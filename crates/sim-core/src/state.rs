//! Session state machine: folds [`Event`]s into a [`SessionState`].
//!
//! `SessionState::apply` is the single place where state rules live, so the server, replay
//! and (later) the browser all agree on what an event means.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Event, TimestampMs, ToolKind, Usage};
use crate::ids::{AgentId, RequestId, SessionId, ToolUseId};

/// What an agent is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum AgentStatus {
    /// Waiting for input.
    #[default]
    Idle,
    /// Producing thinking or text.
    Thinking,
    /// Running one or more tools.
    Tool,
    /// Blocked on a permission decision.
    AwaitingPermission,
    /// Compacting its context.
    Compacting,
    /// Finished (subagents) or session ended.
    Done,
    /// Last thing that happened was an error.
    Error,
}

/// A tool call that has started and not yet finished.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveTool {
    /// Tool-use id.
    pub tool_use_id: ToolUseId,
    /// Tool name.
    pub name: String,
    /// Classification.
    pub tool_kind: ToolKind,
    /// One-line summary.
    pub summary: String,
    /// When it started.
    pub started_at: TimestampMs,
}

/// A permission request waiting for the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingPermission {
    /// Broker id.
    pub request_id: RequestId,
    /// Agent that asked.
    pub agent: AgentId,
    /// Tool name.
    pub tool_name: String,
    /// Tool input.
    pub input: Value,
    /// When it was requested.
    pub requested_at: TimestampMs,
}

/// Per-agent state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentState {
    /// Agent id.
    pub id: AgentId,
    /// Parent agent, `None` for the main agent.
    pub parent: Option<AgentId>,
    /// Display name: "main", or the subagent description/type.
    pub name: String,
    /// `subagent_type`, when known.
    pub agent_type: Option<String>,
    /// Current status.
    pub status: AgentStatus,
    /// Last model seen.
    pub model: Option<String>,
    /// Tools currently running.
    pub active_tools: Vec<ActiveTool>,
    /// Summed usage across responses.
    pub usage: Usage,
    /// Context tokens of the most recent response.
    pub context_tokens: u64,
    /// Context window size for the model.
    pub context_window: u64,
    /// Estimated cost in USD.
    pub cost_usd: f64,
    /// Number of tool calls started.
    pub tool_calls: u32,
    /// Number of tool calls that errored.
    pub tool_errors: u32,
    /// First event time.
    pub started_at: TimestampMs,
    /// Last event time.
    pub last_activity: TimestampMs,
}

/// Whole-session state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    /// Session id.
    pub id: SessionId,
    /// AI title, when known.
    pub title: Option<String>,
    /// Working directory.
    pub cwd: Option<String>,
    /// Git branch.
    pub git_branch: Option<String>,
    /// All agents, keyed by id (`main` plus subagents). `BTreeMap` keeps output stable.
    pub agents: BTreeMap<AgentId, AgentState>,
    /// Pending permission requests.
    pub pending: Vec<PendingPermission>,
    /// Total estimated cost.
    pub cost_usd: f64,
    /// Number of events applied.
    pub event_count: u64,
    /// First event time.
    pub started_at: TimestampMs,
    /// Last event time.
    pub last_activity: TimestampMs,
}

impl SessionState {
    /// Creates an empty session with just the main agent.
    #[must_use]
    pub fn new(id: SessionId, at: TimestampMs) -> Self {
        crate::state_impl::new_session(id, at)
    }

    /// Applies one event. Never panics; events for unknown agents create them.
    pub fn apply(&mut self, event: &Event) {
        crate::state_impl::apply(self, event);
    }
}
