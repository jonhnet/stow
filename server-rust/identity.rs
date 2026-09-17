use crate::error::{Error, Result};
use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    Password,
    Proxy,
}
pub fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        None
    } else {
        Some(value)
    }
}
pub fn same_secret(left: &str, right: &str) -> bool {
    bool::from(Sha256::digest(left).ct_eq(&Sha256::digest(right)))
}
pub fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 320
        && value.trim() == value
        && !value.chars().any(|c| c <= ' ' || c == '\u{7f}' || c == ',')
}
pub fn mac(secret: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key size");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().to_vec()
}
pub fn vault_identity(secret: &[u8], mode: AuthMode, user: &str) -> String {
    hex::encode(mac(
        secret,
        &[
            b"stow-vault\0",
            if mode == AuthMode::Proxy {
                b"proxy"
            } else {
                b"password"
            },
            b"\0",
            user.as_bytes(),
        ],
    ))
}
pub fn proxy_identity(headers: &HeaderMap, secret: &str) -> Result<String> {
    let proof = single_header(headers, "x-stow-proxy-secret")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::request(
                401,
                "Authenticated proxy required: missing or duplicate X-Stow-Proxy-Secret.",
            )
        })?;
    if !same_secret(proof, secret) {
        return Err(Error::request(403, "Authenticated proxy proof is invalid."));
    }
    let user = single_header(headers, "x-auth-user")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::request(
                401,
                "Authenticated proxy must supply exactly one X-Auth-User identity.",
            )
        })?;
    if !valid_identity(user) {
        return Err(Error::request(
            403,
            "Authenticated proxy supplied an invalid X-Auth-User identity.",
        ));
    }
    Ok(user.into())
}
