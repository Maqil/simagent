//! # sim-core
//!
//! The pure heart of simagent. It turns raw Claude Code data (transcript lines,
//! hook payloads) into typed [`Event`]s and folds them into [`SessionState`].
//!
//! **Why a separate crate with no IO:** the same logic must run in the server (native)
//! and in the browser (wasm32). Keeping tokio, axum, wgpu and the filesystem out of
//! this crate guarantees that, and makes every rule testable with plain unit tests.

pub mod cost;
pub mod event;
pub mod hooks;
pub mod ids;
pub mod parser;
pub mod state;
mod state_impl;
pub mod usage;

pub use event::{
    Decision, Event, EventKind, MessageChannel, Resolution, Source, TimestampMs, ToolKind, Usage,
};
pub use ids::{AgentId, RequestId, SessionId, ToolUseId};
pub use parser::TranscriptParser;
pub use state::{AgentState, AgentStatus, SessionState};
