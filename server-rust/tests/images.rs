use super::*;
use crate::images::{render, thumbnail};
use sha2::{Digest, Sha256};
use std::process::Stdio;
use tokio::{io::AsyncWriteExt, process::Command};
pub(super) const LARGE: &[u8] = include_bytes!("fixtures/large.png");
async fn dimensions(bytes: &[u8]) -> String {
    let mut p = Command::new("identify")
        .args(["-format", "%m %w %h %[orientation]", "webp:-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    p.stdin.take().unwrap().write_all(bytes).await.unwrap();
    let out = p.wait_with_output().await.unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap()
}
#[tokio::test]
async fn thumbnails_are_account_local_verified_bounded_cached_and_concurrent() {
    let dir = tempfile::tempdir().unwrap();
    let alice = dir.path().join("alice/blobs");
    let bob = dir.path().join("bob/blobs");
    fs::create_dir_all(&alice).unwrap();
    fs::create_dir_all(&bob).unwrap();
    let hash = hex::encode(Sha256::digest(LARGE));
    fs::write(alice.join(&hash), LARGE).unwrap();
    let (a, b) = tokio::join!(thumbnail(&alice, &hash), thumbnail(&alice, &hash));
    let a = a.unwrap();
    assert_eq!(a.bytes, b.unwrap().bytes);
    assert_eq!(a.digest, hex::encode(Sha256::digest(&a.bytes)));
    assert_eq!(dimensions(&a.bytes).await, "WEBP 512 288 Undefined");
    assert!(a.bytes.len() < LARGE.len());
    assert_eq!(fs::read(alice.join(&hash)).unwrap(), LARGE);
    assert_eq!(thumbnail(&alice, &hash).await.unwrap().bytes, a.bytes);
    assert_eq!(
        thumbnail(&bob, &hash).await.err().unwrap().code(),
        Some("ENOENT")
    );
    let wrong = "0".repeat(64);
    fs::write(alice.join(&wrong), LARGE).unwrap();
    assert!(
        thumbnail(&alice, &wrong)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("integrity check")
    );
    let h = hex::encode(Sha256::digest(b"not an image"));
    fs::write(alice.join(&h), "not an image").unwrap();
    assert!(
        thumbnail(&alice, &h)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("could not be decoded")
    );
    assert!(thumbnail(&alice, "../outside").await.is_err());
}
#[tokio::test]
async fn exif_orientation_small_dimensions_and_avif_are_preserved() {
    for (bytes, expected) in [
        (
            include_bytes!("fixtures/rotated.jpg").as_slice(),
            "WEBP 256 512 Undefined",
        ),
        (
            include_bytes!("fixtures/small.png").as_slice(),
            "WEBP 40 20 Undefined",
        ),
        (
            include_bytes!("fixtures/image.avif").as_slice(),
            "WEBP 512 256 Undefined",
        ),
    ] {
        let rendered = render(bytes).await.unwrap();
        assert_eq!(dimensions(&rendered).await, expected);
    }
}
#[tokio::test]
async fn thumbnail_http_checks_binding_and_returns_digest_without_changing_original() {
    use super::api::*;
    let dir = tempfile::tempdir().unwrap();
    let s = start(dir.path(), json!({})).await;
    let a = identity(&s, "alice").await;
    let b = identity(&s, "bob").await;
    let h = auth("alice", Some(&a));
    let hash = hex::encode(Sha256::digest(LARGE));
    let original = format!("/api/blobs/{hash}");
    assert_eq!(
        request(&s, "PUT", &original, &h, LARGE.to_vec())
            .await
            .status,
        204
    );
    let path = format!("{original}/thumbnail");
    assert_eq!(
        request(&s, "GET", &path, &axum::http::HeaderMap::new(), vec![])
            .await
            .status,
        401
    );
    assert_eq!(
        request(&s, "GET", &path, &auth("bob", Some(&b)), vec![])
            .await
            .status,
        404
    );
    assert_eq!(
        request(&s, "GET", &path, &auth("bob", Some(&a)), vec![])
            .await
            .status,
        409
    );
    let r = request(&s, "GET", &path, &h, vec![]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.headers["content-type"], "image/webp");
    assert_eq!(r.headers["cache-control"], "no-store");
    assert_eq!(
        r.headers["x-stow-thumbnail-sha256"].to_str().unwrap(),
        hex::encode(Sha256::digest(&r.bytes))
    );
    assert_eq!(dimensions(&r.bytes).await, "WEBP 512 288 Undefined");
    assert_eq!(request(&s, "GET", &path, &h, vec![]).await.bytes, r.bytes);
    assert_eq!(request(&s, "GET", &original, &h, vec![]).await.bytes, LARGE);
    s.close().await.unwrap();
}
