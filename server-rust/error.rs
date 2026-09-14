use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{message}")]
    Request {
        status: u16,
        message: String,
        code: Option<&'static str>,
    },
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }
    pub fn request(status: u16, message: impl Into<String>) -> Self {
        Self::Request {
            status,
            message: message.into(),
            code: None,
        }
    }
    pub fn selection() -> Self {
        Self::Request {
            status: 409,
            message: "Archived notes changed; review the selection again.".into(),
            code: Some("archive_selection_changed"),
        }
    }
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Io(e) => Some(match e.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                std::io::ErrorKind::IsADirectory => "EISDIR",
                std::io::ErrorKind::NotADirectory => "ENOTDIR",
                std::io::ErrorKind::StorageFull => "ENOSPC",
                _ => "EIO",
            }),
            Self::Request { code, .. } => *code,
            _ => None,
        }
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::invalid(e.to_string())
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Request { status, .. } => status,
            Self::Invalid(_) => 400,
            Self::Io(_) => 500,
        };
        if status == 500 {
            eprintln!("Stow request failed: {self}");
        }
        let mut body = json!({"error": if status == 500 { "Request failed".into() } else { self.to_string() }});
        if let Self::Request {
            code: Some(code), ..
        } = self
        {
            body["code"] = json!(code);
        }
        (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(body),
        )
            .into_response()
    }
}
