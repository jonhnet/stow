//! APK publication has a longer lifetime than a web deployment. Operators publish
//! artifacts here; browsers and account credentials cannot write this directory.
use super::*;

pub(super) async fn manifest(state: &ServerState) -> Result<Response> {
    let path = state.config.static_dir.join("release.json");
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| Error::request(404, "The Stow web release has not been built"))?;
    let mut manifest: Value = serde_json::from_slice(&bytes)?;
    let directory = state.config.data_dir.join("android-release");
    let android = match tokio::fs::read(directory.join("release.json")).await {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| Error::request(503, "Invalid Android release metadata"))?;
            let filename = string(&value["url"])
                .strip_prefix("/native/android/")
                .unwrap_or("");
            if value["version"]
                .as_u64()
                .is_none_or(|v| v == 0 || v > i32::MAX as u64)
                || value["minSdk"]
                    .as_u64()
                    .is_none_or(|v| !(28..=i32::MAX as u64).contains(&v))
                || filename.is_empty()
                || filename.starts_with('.')
                || !filename.ends_with(".apk")
                || !filename
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                || string(&value["sha256"]).len() != 64
                || !string(&value["sha256"])
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                || !directory.join(filename).is_file()
            {
                return Err(Error::request(
                    503,
                    "Invalid or incomplete Android release publication",
                ));
            }
            value
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => return Err(error.into()),
    };
    manifest["android"] = android;
    let mut response = json_response(200, manifest);
    set_header(&mut response, "cache-control", "no-store");
    Ok(response)
}
