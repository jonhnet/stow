//! Durable diagnostic history, separate from the note CRDT and its history.
use crate::{
    error::{Error, Result},
    storage::{atomic_write, mkdir_durable, read_optional},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

pub const RETENTION_MS: f64 = 30. * 24. * 60. * 60. * 1000.;
pub const MAX_DEVICES: usize = 16;
pub const MAX_EVENTS: usize = 5000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Availability {
    Enabled,
    Unavailable,
    NotPermitted,
    Error,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Permission {
    Granted,
    Denied,
    Prompt,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Detail {
    RegistrationCheck {
        standalone: bool,
    },
    Registration {
        availability: Availability,
        standalone: bool,
        permission: Option<Permission>,
        message: Option<String>,
    },
    Wake {
        run_id: String,
    },
    Started {
        run_id: String,
    },
    Skipped {
        run_id: String,
        message: String,
    },
    Success {
        run_id: String,
        duration_ms: f64,
        received_bytes: u64,
    },
    Failure {
        run_id: String,
        duration_ms: f64,
        message: String,
    },
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Event {
    seq: u64,
    at: f64,
    // The producing tab/worker's revision, not the uploader's. Previously
    // queued and stored events without this field have unknown provenance.
    build: Option<String>,
    #[serde(flatten)]
    detail: Detail,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Foreground,
    Background,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    schema: u8,
    device_id: String,
    source: Source,
    build: Option<String>,
    through: u64,
    dropped_unacknowledged: u64,
    events: Vec<Event>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredEvent {
    received_at: f64,
    #[serde(flatten)]
    event: Event,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    device_id: String,
    browser: String,
    last_upload_build: Option<String>,
    last_seen_at: f64,
    last_foreground_at: Option<f64>,
    last_background_at: Option<f64>,
    through: u64,
    dropped_unacknowledged: u64,
    events: Vec<StoredEvent>,
}
#[derive(Deserialize, Serialize)]
struct Reports {
    schema: u8,
    devices: Vec<Device>,
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn number(value: f64) -> bool {
    value.is_finite() && (0. ..=MAX_SAFE as f64).contains(&value)
}
fn message(value: &str) -> bool {
    value.len() <= 4000
}
fn valid_build(value: Option<&str>) -> bool {
    value.is_none_or(|build| build.len() == 40 && build.bytes().all(|c| c.is_ascii_hexdigit()))
}
pub fn parse(value: Value) -> Result<Upload> {
    let invalid = || Error::request(400, "Invalid background diagnostic report.");
    let upload: Upload = serde_json::from_value(value).map_err(|_| invalid())?;
    if upload.schema != 1
        || !uuid(&upload.device_id)
        || upload.events.len() > 200
        || upload.through > MAX_SAFE
        || upload.dropped_unacknowledged > MAX_SAFE
        || !valid_build(upload.build.as_deref())
    {
        return Err(invalid());
    }
    let mut previous = 0;
    for event in &upload.events {
        if event.seq <= previous
            || event.seq > upload.through
            || !number(event.at)
            || !valid_build(event.build.as_deref())
        {
            return Err(invalid());
        }
        previous = event.seq;
        let valid = match &event.detail {
            Detail::RegistrationCheck { .. } => true,
            Detail::Registration { message: msg, .. } => msg.as_ref().is_none_or(|v| message(v)),
            Detail::Wake { run_id } | Detail::Started { run_id } => uuid(run_id),
            Detail::Skipped {
                run_id,
                message: msg,
            } => uuid(run_id) && message(msg),
            Detail::Success {
                run_id,
                duration_ms,
                received_bytes,
            } => uuid(run_id) && number(*duration_ms) && *received_bytes <= MAX_SAFE,
            Detail::Failure {
                run_id,
                duration_ms,
                message: msg,
            } => uuid(run_id) && number(*duration_ms) && message(msg),
        };
        if !valid {
            return Err(invalid());
        }
    }
    if !upload.events.is_empty() && previous != upload.through {
        return Err(invalid());
    }
    Ok(upload)
}

fn load(path: &Path) -> Result<Reports> {
    let Some(bytes) = read_optional(path)? else {
        return Ok(Reports {
            schema: 1,
            devices: vec![],
        });
    };
    let reports: Reports = serde_json::from_slice(&bytes)?;
    if reports.schema != 1 {
        return Err(Error::invalid("Unsupported background diagnostic storage."));
    }
    Ok(reports)
}
fn prune(reports: &mut Reports, now: f64) {
    let cutoff = now - RETENTION_MS;
    reports
        .devices
        .retain(|device| device.last_seen_at >= cutoff);
    for device in &mut reports.devices {
        device.events.retain(|event| event.received_at >= cutoff);
    }
}

/// Caller serializes operations on this file. Acknowledgment follows fsync and
/// atomic publication; retries preserve the original server receipt timestamps.
pub fn accept(path: &Path, upload: Upload, browser: String, now: f64) -> Result<Value> {
    let mut reports = load(path)?;
    prune(&mut reports, now);
    let index = reports
        .devices
        .iter()
        .position(|d| d.device_id == upload.device_id)
        .unwrap_or_else(|| {
            reports.devices.push(Device {
                device_id: upload.device_id.clone(),
                browser: String::new(),
                last_upload_build: None,
                last_seen_at: now,
                last_foreground_at: None,
                last_background_at: None,
                through: 0,
                dropped_unacknowledged: 0,
                events: vec![],
            });
            reports.devices.len() - 1
        });
    let device = &mut reports.devices[index];
    for event in upload.events {
        if event.seq > device.through {
            device.events.push(StoredEvent {
                received_at: now,
                event,
            });
        }
    }
    let excess = device.events.len().saturating_sub(MAX_EVENTS);
    device.events.drain(..excess);
    device.through = device.through.max(upload.through);
    device.dropped_unacknowledged = device
        .dropped_unacknowledged
        .max(upload.dropped_unacknowledged);
    device.last_seen_at = now;
    device.browser = browser;
    device.last_upload_build = upload.build;
    match upload.source {
        Source::Foreground => device.last_foreground_at = Some(now),
        Source::Background => device.last_background_at = Some(now),
    }
    reports.devices.sort_by(|a, b| {
        b.last_seen_at
            .total_cmp(&a.last_seen_at)
            .then_with(|| a.device_id.cmp(&b.device_id))
    });
    // Keep the just-accepted device even when several uploads share a timestamp.
    while reports.devices.len() > MAX_DEVICES {
        let index = reports
            .devices
            .iter()
            .rposition(|d| d.device_id != upload.device_id)
            .unwrap();
        reports.devices.remove(index);
    }
    mkdir_durable(
        path.parent()
            .ok_or_else(|| Error::invalid("Missing diagnostic directory"))?,
    )?;
    atomic_write(path, &serde_json::to_vec(&reports)?)?;
    Ok(json!({"deviceId":upload.device_id,"through":upload.through}))
}

pub fn read(path: &Path, now: f64) -> Result<Value> {
    let mut reports = load(path)?;
    let before: usize = reports.devices.iter().map(|d| d.events.len() + 1).sum();
    prune(&mut reports, now);
    let after: usize = reports.devices.iter().map(|d| d.events.len() + 1).sum();
    if before != after {
        atomic_write(path, &serde_json::to_vec(&reports)?)?;
    }
    Ok(
        json!({"schema":1,"retentionDays":30,"maxEventsPerDevice":MAX_EVENTS,"maxDevices":MAX_DEVICES,"devices":reports.devices}),
    )
}
