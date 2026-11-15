//! # sim-server
//!
//! The local server behind simagent: it tails Claude Code transcripts, receives HTTP
//! hooks, brokers permission decisions and streams state to the browser over WebSocket.
//!
//! **Why a lib + a thin bin:** routes and actors live in the library so tests can build
//! the router and call it directly, without spawning a process or opening a port.
//!
//! Data flow: `ingest` (transcript files) and `http` (hooks) produce [`sim_core::Event`]s,
//! the [`hub`] actor folds them into [`sim_core::SessionState`] and broadcasts updates, and
//! the [`broker`] actor parks permission requests until the browser decides.

pub mod broker;
pub mod config;
pub mod demo;
pub mod driver;
pub mod http;
pub mod hub;
pub mod ingest;
pub mod replay;
pub mod sessions;

pub use http::{AppState, router};

use sim_core::TimestampMs;

/// Current wall-clock time in milliseconds since the Unix epoch.
///
/// sim-core never reads the clock (it must run in wasm), so the server stamps events.
#[must_use]
pub fn now_ms() -> TimestampMs {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    // i128 -> i64 cannot overflow for any realistic date (i64 ms covers ~292M years).
    TimestampMs::try_from(nanos / 1_000_000).unwrap_or(TimestampMs::MAX)
}

/// Lowercase hex encoding, used for tokens and request ids.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            // Writing to a String cannot fail.
            let _ = write!(out, "{b:02x}");
            out
        })
}
