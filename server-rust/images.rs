//! ImageMagick provides the native image codecs, including HEIF/AVIF. The server
//! passes bytes through stdin with an explicit allowed coder; never a shell or a filename.
use crate::{
    error::{Error, Result},
    policy::is_hash,
    storage::{atomic_write, mkdir_durable, read_optional},
};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, sync::Semaphore};
static DECODERS: Semaphore = Semaphore::const_new(2);
pub struct Thumbnail {
    pub bytes: Vec<u8>,
    pub digest: String,
}
pub async fn verify_codecs() -> Result<()> {
    let output=Command::new("identify").args(["-list","format"]).output().await.map_err(|e|Error::invalid(format!("ImageMagick is required (identify and convert with JPEG, PNG, GIF, WebP and HEIF/AVIF support): {e}")))?;
    let formats = String::from_utf8_lossy(&output.stdout);
    for required in ["JPEG", "PNG", "GIF", "WEBP", "HEIC"] {
        if !output.status.success()
            || !formats.lines().any(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                fields
                    .first()
                    .is_some_and(|format| format.trim_end_matches('*') == required)
                    && fields.iter().skip(1).any(|mode| {
                        mode.len() == 3
                            && mode.bytes().all(|c| b"rw-+".contains(&c))
                            && mode.contains('r')
                            && (required != "WEBP" || mode.contains('w'))
                    })
            })
        {
            return Err(Error::invalid(format!(
                "ImageMagick lacks required {required} codec support"
            )));
        }
    }
    if !Command::new("convert")
        .arg("-version")
        .output()
        .await?
        .status
        .success()
    {
        return Err(Error::invalid("ImageMagick convert is unavailable"));
    }
    Ok(())
}
fn coder(bytes: &[u8]) -> Result<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("png");
    }
    if bytes.starts_with(&[255, 216, 255]) {
        return Ok("jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("webp");
    }
    if bytes.len() >= 16
        && &bytes[4..8] == b"ftyp"
        && [
            b"avif", b"avis", b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1",
        ]
        .iter()
        .any(|brand| &bytes[8..12] == *brand)
    {
        return Ok("heic");
    }
    Err(Error::request(
        422,
        "This original could not be decoded as a supported image.",
    ))
}
async fn command(program: &str, args: &[&str], bytes: &[u8]) -> Result<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .env("MAGICK_THREAD_LIMIT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = bytes.to_vec();
    let writer = tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.shutdown().await
    });
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await;
    let write_result = writer.await.map_err(|e| Error::invalid(e.to_string()))?;
    let output = output.map_err(|_| Error::request(422, "Image decoding timed out"))??;
    if !output.status.success() || write_result.is_err() {
        return Err(Error::request(
            422,
            "This original could not be decoded as a supported image.",
        ));
    }
    Ok(output.stdout)
}
pub async fn render(bytes: &[u8]) -> Result<Vec<u8>> {
    let _permit = DECODERS
        .acquire()
        .await
        .map_err(|e| Error::invalid(e.to_string()))?;
    let input = format!("{}:-[0]", coder(bytes)?);
    let dimensions = command(
        "identify",
        &[
            "-limit", "memory", "256MiB", "-limit", "map", "0", "-limit", "disk", "0", "-ping",
            "-format", "%w %h", &input,
        ],
        bytes,
    )
    .await?;
    let dimensions = String::from_utf8_lossy(&dimensions);
    let dims: Vec<u64> = dimensions
        .split_whitespace()
        .filter_map(|v| v.parse().ok())
        .collect();
    if dims.len() != 2
        || dims[0] == 0
        || dims[1] == 0
        || dims[0].checked_mul(dims[1]).is_none_or(|n| n > 100_000_000)
    {
        return Err(Error::request(
            422,
            "This original exceeds the image size limit.",
        ));
    }
    command(
        "convert",
        &[
            "-limit",
            "memory",
            "512MiB",
            "-limit",
            "map",
            "0",
            "-limit",
            "disk",
            "0",
            &input,
            "-auto-orient",
            "-resize",
            "512x512>",
            "-strip",
            "-quality",
            "75",
            "webp:-",
        ],
        bytes,
    )
    .await
}
/// Caller holds the account's writer guard through the cache publication.
pub async fn thumbnail(blob_dir: &Path, hash: &str) -> Result<Thumbnail> {
    if !is_hash(hash) {
        return Err(Error::invalid("Invalid image hash"));
    }
    let directory = blob_dir
        .parent()
        .ok_or_else(|| Error::invalid("Missing vault directory"))?
        .join("thumbnails-v1");
    let filename = directory.join(format!("{hash}.webp"));
    let bytes = if let Some(bytes) = read_optional(&filename)? {
        bytes
    } else {
        let original = std::fs::read(blob_dir.join(hash))?;
        if hex::encode(Sha256::digest(&original)) != hash {
            return Err(Error::request(
                422,
                "The stored original image failed its integrity check.",
            ));
        }
        let bytes = render(&original).await?;
        mkdir_durable(&directory)?;
        atomic_write(&filename, &bytes)?;
        bytes
    };
    Ok(Thumbnail {
        digest: hex::encode(Sha256::digest(&bytes)),
        bytes,
    })
}
