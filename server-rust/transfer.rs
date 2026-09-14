//! Protocol 2 byte-compatible with src/core/sync-transfer.ts.
//! Receipt only grants frame credit. The caller publishes `done` after durable application.
use crate::{crdt::CURRENT_SCHEMA, policy::is_hash};
use axum::extract::ws::Message;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
pub const FRAME: usize = 256 * 1024;
pub const PAYLOAD: usize = FRAME - 8;
pub const WINDOW: usize = 4;
pub const MAX: usize = 128 * 1024 * 1024;
pub const AGGREGATE: usize = 256 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    SyncRequest,
    Sync,
    Update,
    HistoryBoundary,
    SyncComplete,
    HistoryChanged,
    HistoryFailure,
}
impl Kind {
    pub fn max(self) -> usize {
        if matches!(self, Self::SyncRequest | Self::Sync | Self::Update) {
            MAX
        } else {
            FRAME
        }
    }
    pub fn optional(self) -> bool {
        matches!(self, Self::HistoryChanged | Self::HistoryFailure)
    }
}
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn frame(&self) -> Message {
        control(json!({"type":"failure","code":self.code,"message":self.message}))
    }
}
pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Clone, Default)]
pub struct Budget(Arc<AtomicUsize>);
pub struct Reservation {
    budget: Budget,
    bytes: usize,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.0.fetch_sub(self.bytes, Ordering::Release);
    }
}
impl Budget {
    pub fn reserve(&self, bytes: usize) -> Result<Reservation> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes).filter(|n| *n <= AGGREGATE)
            })
            .map_err(|_| {
                Failure::new(
                    "retry",
                    "The server is busy receiving updates. Reconnect to retry.",
                )
            })?;
        Ok(Reservation {
            budget: self.clone(),
            bytes,
        })
    }
}
pub struct Unit {
    pub kind: Kind,
    pub data: Arc<[u8]>,
    _reservation: Reservation,
    queued: Arc<AtomicUsize>,
}
impl Drop for Unit {
    fn drop(&mut self) {
        self.queued.fetch_sub(self.data.len(), Ordering::Release);
    }
}
impl Unit {
    pub fn new(
        kind: Kind,
        data: Arc<[u8]>,
        budget: &Budget,
        queued: Arc<AtomicUsize>,
    ) -> Result<Self> {
        let len = data.len();
        if len == 0 || len > kind.max() {
            return Err(Failure::new(
                "limit",
                "A sync update exceeds its supported size limit. Local edits remain saved on this device.",
            ));
        }
        queued
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(len).filter(|n| *n <= MAX)
            })
            .map_err(|_| {
                Failure::new(
                    "retry",
                    "Sync is falling behind. Reconnect to catch up from saved notes.",
                )
            })?;
        match budget.reserve(len) {
            Ok(reservation) => Ok(Self {
                kind,
                data,
                _reservation: reservation,
                queued,
            }),
            Err(e) => {
                queued.fetch_sub(len, Ordering::Release);
                Err(e)
            }
        }
    }
}
struct Outgoing {
    id: u32,
    unit: Unit,
    sent: usize,
    received: usize,
    started: Instant,
}
struct Incoming {
    id: u32,
    kind: Kind,
    data: Vec<u8>,
    offset: usize,
    digest: String,
    started: Instant,
    _reservation: Reservation,
}
pub struct Received {
    pub id: u32,
    pub kind: Kind,
    pub data: Vec<u8>,
}
pub struct Transfer {
    budget: Budget,
    outgoing: Option<Outgoing>,
    incoming: Option<Incoming>,
    queue: VecDeque<Unit>,
    next_out: u32,
    next_in: u32,
    last_activity: Instant,
}
fn control(v: Value) -> Message {
    Message::Text(v.to_string().into())
}
impl Transfer {
    pub fn new(budget: Budget) -> Self {
        Self {
            budget,
            outgoing: None,
            incoming: None,
            queue: VecDeque::new(),
            next_out: 1,
            next_in: 1,
            last_activity: Instant::now(),
        }
    }
    pub fn ready_to_send(&self) -> bool {
        self.outgoing.is_none() && self.queue.is_empty()
    }
    pub fn can_queue(&self) -> bool {
        self.queue.len() < 128
    }
    pub fn send(&mut self, unit: Unit) -> Result<Vec<Message>> {
        if !self.can_queue() {
            return Err(Failure::new(
                "retry",
                "Sync transport queue is full. Reconnect to catch up.",
            ));
        }
        self.queue.push_back(unit);
        self.start_next()
    }
    fn start_next(&mut self) -> Result<Vec<Message>> {
        if self.outgoing.is_some() {
            return Ok(vec![]);
        }
        let Some(unit) = self.queue.pop_front() else {
            return Ok(vec![]);
        };
        let id = self.next_out;
        self.next_out = self
            .next_out
            .checked_add(1)
            .ok_or_else(|| Failure::new("retry", "Sync transfer identity exhausted"))?;
        let digest = hex::encode(Sha256::digest(&unit.data));
        let header = control(
            json!({"type":"begin","id":id,"kind":unit.kind,"bytes":unit.data.len(),"digest":digest}),
        );
        self.outgoing = Some(Outgoing {
            id,
            unit,
            sent: 0,
            received: 0,
            started: Instant::now(),
        });
        self.last_activity = Instant::now();
        let mut frames = vec![header];
        frames.extend(self.pump());
        Ok(frames)
    }
    fn pump(&mut self) -> Vec<Message> {
        let mut frames = Vec::new();
        if let Some(active) = &mut self.outgoing {
            while active.sent < active.unit.data.len()
                && active.sent - active.received < PAYLOAD * WINDOW
            {
                let end = (active.sent + PAYLOAD).min(active.unit.data.len());
                let mut frame = Vec::with_capacity(8 + end - active.sent);
                frame.extend(active.id.to_be_bytes());
                frame.extend((active.sent as u32).to_be_bytes());
                frame.extend_from_slice(&active.unit.data[active.sent..end]);
                active.sent = end;
                frames.push(Message::Binary(frame.into()));
            }
        }
        frames
    }
    pub fn receive(&mut self, message: Message) -> Result<(Vec<Message>, Option<Received>)> {
        self.last_activity = Instant::now();
        let mut frames = vec![];
        match message {
            Message::Text(text) => {
                if text.len() > 4096 {
                    return Err(Failure::invalid("Oversized sync control frame."));
                }
                let v: Value = serde_json::from_str(&text)
                    .map_err(|_| Failure::invalid("Invalid sync control frame"))?;
                if v["type"] == "failure" {
                    let code = match v["code"].as_str() {
                        Some("invalid") => "invalid",
                        Some("limit") => "limit",
                        Some("retry") => "retry",
                        Some("storage") => "storage",
                        _ => return Err(Failure::invalid("Invalid sync failure response.")),
                    };
                    return Err(Failure::new(
                        code,
                        v["message"]
                            .as_str()
                            .ok_or_else(|| Failure::invalid("Invalid sync failure response."))?
                            .chars()
                            .take(512)
                            .collect::<String>(),
                    ));
                }
                let id = v["id"]
                    .as_u64()
                    .filter(|n| *n >= 1 && *n <= u32::MAX as u64)
                    .ok_or_else(|| Failure::invalid("Invalid sync transfer identity."))?
                    as u32;
                match v["type"].as_str() {
                    Some("begin") => {
                        let kind: Kind = serde_json::from_value(v["kind"].clone())
                            .map_err(|_| Failure::invalid("Invalid sync transfer header."))?;
                        let bytes = v["bytes"]
                            .as_u64()
                            .and_then(|v| usize::try_from(v).ok())
                            .filter(|n| *n > 0)
                            .ok_or_else(|| Failure::invalid("Invalid sync transfer header."))?;
                        let digest = v["digest"]
                            .as_str()
                            .filter(|s| is_hash(s))
                            .ok_or_else(|| Failure::invalid("Invalid sync transfer header."))?;
                        if self.incoming.is_some() || id != self.next_in {
                            return Err(Failure::invalid("Invalid sync transfer header."));
                        }
                        if bytes > kind.max() {
                            return Err(Failure::new(
                                "limit",
                                "A sync update exceeds its supported size limit.",
                            ));
                        }
                        let reservation = self.budget.reserve(bytes)?;
                        let mut data = Vec::new();
                        data.try_reserve_exact(bytes)
                            .map_err(|_| Failure::new("retry", "Sync allocation unavailable"))?;
                        data.resize(bytes, 0);
                        self.incoming = Some(Incoming {
                            id,
                            kind,
                            data,
                            offset: 0,
                            digest: digest.into(),
                            started: Instant::now(),
                            _reservation: reservation,
                        });
                    }
                    Some("receipt") => {
                        let active = self
                            .outgoing
                            .as_mut()
                            .ok_or_else(|| Failure::invalid("Unexpected sync chunk receipt."))?;
                        let offset = v["offset"]
                            .as_u64()
                            .and_then(|n| usize::try_from(n).ok())
                            .ok_or_else(|| Failure::invalid("Invalid sync chunk receipt."))?;
                        if id != active.id
                            || offset <= active.received
                            || offset > active.sent
                            || (offset != active.unit.data.len() && !offset.is_multiple_of(PAYLOAD))
                        {
                            return Err(Failure::invalid("Invalid sync chunk receipt."));
                        }
                        active.received = offset;
                        frames.extend(self.pump());
                    }
                    Some("done") => {
                        let active = self
                            .outgoing
                            .as_ref()
                            .ok_or_else(|| Failure::invalid("Unexpected sync acknowledgement."))?;
                        if id != active.id || active.received != active.unit.data.len() {
                            return Err(Failure::invalid("Premature sync acknowledgement."));
                        }
                        self.outgoing = None;
                        frames.extend(self.start_next()?);
                    }
                    _ => return Err(Failure::invalid("Unknown sync control frame.")),
                }
            }
            Message::Binary(frame) => {
                let active = self
                    .incoming
                    .as_mut()
                    .ok_or_else(|| Failure::invalid("Unexpected sync chunk."))?;
                if frame.len() <= 8 || frame.len() > FRAME || active.data.is_empty() {
                    return Err(Failure::invalid("Unexpected sync chunk."));
                }
                let id = u32::from_be_bytes(frame[..4].try_into().unwrap());
                let offset = u32::from_be_bytes(frame[4..8].try_into().unwrap()) as usize;
                let len = frame.len() - 8;
                if id != active.id
                    || offset != active.offset
                    || len != PAYLOAD.min(active.data.len() - active.offset)
                {
                    return Err(Failure::invalid(
                        "Missing, repeated, or out-of-order sync chunk.",
                    ));
                }
                active.data[offset..offset + len].copy_from_slice(&frame[8..]);
                active.offset += len;
                frames.push(control(
                    json!({"type":"receipt","id":active.id,"offset":active.offset}),
                ));
                if active.offset == active.data.len() {
                    if hex::encode(Sha256::digest(&active.data)) != active.digest {
                        return Err(Failure::invalid("Sync transfer checksum does not match."));
                    }
                    let data = std::mem::take(&mut active.data);
                    return Ok((
                        frames,
                        Some(Received {
                            id: active.id,
                            kind: active.kind,
                            data,
                        }),
                    ));
                }
            }
            _ => return Err(Failure::invalid("Invalid sync message")),
        }
        Ok((frames, None))
    }
    pub fn committed(&mut self, id: u32) -> Result<Message> {
        if self
            .incoming
            .as_ref()
            .is_none_or(|a| a.id != id || !a.data.is_empty())
        {
            return Err(Failure::invalid("Uncommitted sync transfer"));
        }
        self.incoming = None;
        self.next_in = self
            .next_in
            .checked_add(1)
            .ok_or_else(|| Failure::new("retry", "Sync transfer identity exhausted"))?;
        self.last_activity = Instant::now();
        Ok(control(json!({"type":"done","id":id})))
    }
    pub fn check_timeout(&self) -> Result<()> {
        if (self.incoming.is_some() || self.outgoing.is_some())
            && (self.last_activity.elapsed() >= Duration::from_secs(60)
                || self
                    .incoming
                    .as_ref()
                    .is_some_and(|a| a.started.elapsed() >= Duration::from_secs(300))
                || self
                    .outgoing
                    .as_ref()
                    .is_some_and(|a| a.started.elapsed() >= Duration::from_secs(300)))
        {
            return Err(Failure::new(
                "retry",
                "Sync timed out. Unacknowledged changes will retry after reconnecting.",
            ));
        }
        Ok(())
    }
}
pub fn pack(update: &[u8], vector: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(CURRENT_SCHEMA.len() + 5 + vector.len() + update.len());
    data.extend_from_slice(CURRENT_SCHEMA.as_bytes());
    data.push(0);
    data.extend_from_slice(&(vector.len() as u32).to_be_bytes());
    data.extend_from_slice(vector);
    data.extend_from_slice(update);
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(bytes: Vec<u8>, budget: &Budget, queued: &Arc<AtomicUsize>) -> Unit {
        Unit::new(Kind::Update, bytes.into(), budget, queued.clone()).unwrap()
    }
    fn header(bytes: usize, kind: Kind) -> Message {
        control(json!({"type":"begin","id":1,"kind":kind,"bytes":bytes,"digest":"a".repeat(64)}))
    }
    fn used(budget: &Budget) -> usize {
        budget.0.load(Ordering::Acquire)
    }

    #[test]
    fn window_credit_does_not_acknowledge_durability() {
        let budget = Budget::default();
        let queued = Arc::new(AtomicUsize::new(0));
        let bytes = vec![173; FRAME * 9 + 13];
        let mut sender = Transfer::new(budget.clone());
        let mut receiver = Transfer::new(budget.clone());
        let initial = sender.send(unit(bytes.clone(), &budget, &queued)).unwrap();
        assert_eq!(initial.len(), 1 + WINDOW);
        assert_eq!(sender.outgoing.as_ref().unwrap().sent, PAYLOAD * WINDOW);
        let mut pending = VecDeque::from(initial);
        let mut received = None;
        while let Some(frame) = pending.pop_front() {
            if let Message::Binary(bytes) = &frame {
                assert!(bytes.len() <= FRAME);
            }
            let (receipts, value) = receiver.receive(frame).unwrap();
            if value.is_some() {
                received = value;
            }
            for receipt in receipts {
                let (frames, value) = sender.receive(receipt).unwrap();
                assert!(value.is_none());
                pending.extend(frames);
            }
        }
        let received = received.unwrap();
        assert_eq!(received.data, bytes);
        assert!(
            sender.outgoing.is_some(),
            "all receipts still leave the update unacknowledged"
        );
        assert_eq!(used(&budget), bytes.len() * 2);
        assert!(
            receiver.receive(header(1, Kind::Update)).is_err(),
            "one incoming unit until durable commit"
        );
        sender
            .receive(receiver.committed(received.id).unwrap())
            .unwrap();
        assert!(sender.ready_to_send());
        assert_eq!(used(&budget), 0);
        assert_eq!(queued.load(Ordering::Acquire), 0);
    }

    #[test]
    fn disconnect_at_each_chunk_releases_reservations_without_committing() {
        for boundary in 0..=4 {
            let budget = Budget::default();
            let queued = Arc::new(AtomicUsize::new(0));
            let mut sender = Transfer::new(budget.clone());
            let mut receiver = Transfer::new(budget.clone());
            let frames = sender
                .send(unit(vec![9; FRAME * 4], &budget, &queued))
                .unwrap();
            for frame in frames.into_iter().take(boundary + 1) {
                assert!(receiver.receive(frame).unwrap().1.is_none());
            }
            assert!(used(&budget) > 0);
            assert!(receiver.committed(1).is_err());
            drop(receiver);
            drop(sender);
            assert_eq!(used(&budget), 0);
            assert_eq!(queued.load(Ordering::Acquire), 0);
        }
    }

    #[test]
    fn malformed_frames_never_reach_application() {
        for corruption in [
            "duplicate",
            "reordered",
            "checksum",
            "ack",
            "short",
            "offset",
            "id",
        ] {
            let budget = Budget::default();
            let queued = Arc::new(AtomicUsize::new(0));
            let mut sender = Transfer::new(budget.clone());
            let mut receiver = Transfer::new(budget);
            let frames = sender
                .send(unit(vec![0; FRAME * 2], &sender.budget, &queued))
                .unwrap();
            receiver.receive(frames[0].clone()).unwrap();
            let result = match corruption {
                "duplicate" => {
                    receiver.receive(frames[1].clone()).unwrap();
                    receiver.receive(frames[1].clone())
                }
                "reordered" => receiver.receive(frames[2].clone()),
                "ack" => sender.receive(control(json!({"type":"done","id":1}))),
                _ => {
                    let Message::Binary(first) = &frames[1] else {
                        unreachable!()
                    };
                    let mut first = first.to_vec();
                    match corruption {
                        "checksum" => first[8] = 99,
                        "short" => {
                            first.pop();
                        }
                        "offset" => first[7] = 1,
                        "id" => first[3] = 2,
                        _ => unreachable!(),
                    }
                    let result = receiver.receive(Message::Binary(first.into()));
                    if corruption == "checksum" {
                        assert!(result.unwrap().1.is_none());
                        assert!(receiver.receive(frames[2].clone()).unwrap().1.is_none());
                        receiver.receive(frames[3].clone())
                    } else {
                        result
                    }
                }
            };
            assert!(result.is_err(), "{corruption}");
        }
    }

    #[test]
    fn completed_payload_cannot_accept_a_duplicate_before_commit() {
        let budget = Budget::default();
        let queued = Arc::new(AtomicUsize::new(0));
        let mut sender = Transfer::new(budget.clone());
        let mut receiver = Transfer::new(budget.clone());
        let frames = sender.send(unit(vec![1], &budget, &queued)).unwrap();
        receiver.receive(frames[0].clone()).unwrap();
        assert_eq!(
            receiver.receive(frames[1].clone()).unwrap().1.unwrap().data,
            [1]
        );
        assert!(receiver.receive(frames[1].clone()).is_err());
        assert!(sender.outgoing.is_some());
        // A failed publication drops this receiver without ever calling committed.
        drop(receiver);
        assert_eq!(used(&budget), 1);
        drop(sender);
        assert_eq!(used(&budget), 0);
    }

    #[test]
    fn size_and_shared_admission_fail_before_allocating() {
        let budget = Budget::default();
        let mut receiver = Transfer::new(budget.clone());
        for (kind, bytes) in [(Kind::Update, MAX + 1), (Kind::HistoryBoundary, FRAME + 1)] {
            assert_eq!(
                receiver.receive(header(bytes, kind)).err().unwrap().code,
                "limit"
            );
            assert_eq!(used(&budget), 0);
            assert!(receiver.incoming.is_none());
        }
        let full = budget.reserve(AGGREGATE).unwrap();
        assert_eq!(
            receiver
                .receive(header(1, Kind::Update))
                .err()
                .unwrap()
                .code,
            "retry"
        );
        assert!(receiver.incoming.is_none());
        let queued = Arc::new(AtomicUsize::new(0));
        assert!(Unit::new(Kind::Update, vec![1].into(), &budget, queued.clone()).is_err());
        assert_eq!(queued.load(Ordering::Acquire), 0);
        drop(full);
        receiver.receive(header(1, Kind::Update)).unwrap();
        assert_eq!(used(&budget), 1);
    }

    #[test]
    fn queue_and_optional_failure_preserve_already_admitted_updates() {
        let budget = Budget::default();
        let queued = Arc::new(AtomicUsize::new(0));
        let mut sender = Transfer::new(budget.clone());
        sender.send(unit(vec![1], &budget, &queued)).unwrap();
        for _ in 0..128 {
            sender.send(unit(vec![2], &budget, &queued)).unwrap();
        }
        assert!(sender.send(unit(vec![3], &budget, &queued)).is_err());
        assert_eq!(queued.load(Ordering::Acquire), 129);
        let full = budget.reserve(AGGREGATE - 129).unwrap();
        assert!(
            Unit::new(
                Kind::HistoryChanged,
                vec![4].into(),
                &budget,
                queued.clone()
            )
            .is_err()
        );
        assert!(sender.outgoing.is_some());
        assert_eq!(sender.queue.len(), 128);
        drop(full);
        drop(sender);
        assert_eq!(used(&budget), 0);
        assert_eq!(queued.load(Ordering::Acquire), 0);
    }

    #[test]
    fn receipts_must_be_forward_exact_frame_boundaries() {
        for offset in [0, 1, PAYLOAD * WINDOW + 1] {
            let budget = Budget::default();
            let mut sender = Transfer::new(budget.clone());
            sender
                .send(unit(vec![0; FRAME * 5], &budget, &Arc::default()))
                .unwrap();
            assert!(
                sender
                    .receive(control(json!({"type":"receipt","id":1,"offset":offset})))
                    .is_err()
            );
        }
    }

    #[test]
    fn idle_and_total_lifetime_have_independent_deadlines() {
        let mut receiver = Transfer::new(Budget::default());
        receiver.last_activity = Instant::now() - Duration::from_secs(61);
        assert!(
            receiver.check_timeout().is_ok(),
            "idle connections have no active transfer timeout"
        );
        receiver.receive(header(1, Kind::Update)).unwrap();
        receiver.last_activity = Instant::now() - Duration::from_secs(61);
        assert_eq!(receiver.check_timeout().err().unwrap().code, "retry");
        receiver.last_activity = Instant::now();
        receiver.incoming.as_mut().unwrap().started = Instant::now() - Duration::from_secs(301);
        assert_eq!(receiver.check_timeout().err().unwrap().code, "retry");
    }

    #[test]
    fn snapshot_marker_and_vector_match_the_browser_wire_contract() {
        assert_eq!(pack(&[0, 0], &[0]), b"stow-current-v1\0\0\0\0\x01\0\0\0");
    }
}
