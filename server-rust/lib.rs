#![forbid(unsafe_code)]

pub mod account_metadata;
pub mod account_reset;
pub mod cache;
pub mod crdt;
pub mod diagnostics;
pub mod error;
#[cfg(feature = "test-support")]
pub mod fixture;
pub mod history;
pub mod history_state;
pub mod identity;
pub mod images;
#[cfg(feature = "test-support")]
pub mod lab;
pub mod policy;
pub mod retention;
pub mod server;
pub mod storage;
pub mod transfer;

pub mod bridge;

#[cfg(test)]
mod tests;

pub mod admin;

mod cli;
