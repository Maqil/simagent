//! Implementation of the state rules (kept apart from the type definitions in `state`).

use std::collections::BTreeMap;

use crate::cost;
use crate::event::{Event, EventKind, TimestampMs, Usage};
use crate::ids::{AgentId, RequestId, SessionId, ToolUseId};
use crate::state::{ActiveTool, AgentState, AgentStatus, PendingPermission, SessionState};

pub(crate) fn new_session(id: SessionId, at: TimestampMs) -> SessionState {
    let mut agents = BTreeMap::new();
    agents.insert(
        AgentId::main(),
        new_agent(AgentId::main(), None, "main", at),
    );
    SessionState {
        id,
        title: None,
        cwd: None,
        git_branch: None,
        agents,
        pending: Vec::new(),
        cost_usd: 0.0,
        event_count: 0,
        started_at: at,
        last_activity: at,
    }
}

pub(crate) fn new_agent(
    id: AgentId,
    parent: Option<AgentId>,
    name: &str,
    at: TimestampMs,
) -> AgentState {
    AgentState {
        id,
        parent,
        name: name.to_owned(),
        agent_type: None,
        status: AgentStatus::Idle,
        model: None,
        active_tools: Vec::new(),
        usage: Usage::default(),
        context_tokens: 0,
        context_window: 200_000,
        cost_usd: 0.0,
        tool_calls: 0,
        tool_errors: 0,
        started_at: at,
        last_activity: at,
    }
}

/// Status for an agent that is producing output: `Tool` while tools run, else `Thinking`.
fn busy_status(agent: &AgentState) -> AgentStatus {
    if agent.active_tools.is_empty() {
        AgentStatus::Thinking
    } else {
        AgentStatus::Tool
    }
}

/// Returns the agent with `id`, creating it (no parent, named after its id) if unknown.
fn ensure_agent<'a>(
    state: &'a mut SessionState,
    id: &AgentId,
    at: TimestampMs,
) -> &'a mut AgentState {
    state
        .agents
        .entry(id.clone())
        .or_insert_with(|| new_agent(id.clone(), None, id.as_str(), at))
}

pub(crate) fn apply(state: &mut SessionState, event: &Event) {
    let at = event.at;
    state.event_count += 1;
    state.last_activity = state.last_activity.max(at);
    // Events can arrive out of order (subagent files are read after the main file), so the
    // start is the earliest timestamp seen, not the first event applied. 0 means "unknown".
    if at > 0 && (state.started_at <= 0 || at < state.started_at) {
        state.started_at = at;
    }
    {
        let agent = ensure_agent(state, &event.agent, at);
        agent.last_activity = agent.last_activity.max(at);
        if at > 0 && (agent.started_at <= 0 || at < agent.started_at) {
            agent.started_at = at;
        }
    }

    match &event.kind {
        EventKind::SessionStarted {
            cwd, git_branch, ..
        } => {
            if let Some(cwd) = cwd {
                state.cwd = Some(cwd.clone());
            }
            if let Some(branch) = git_branch {
                state.git_branch = Some(branch.clone());
            }
        }
        EventKind::Title { title } => state.title = Some(title.clone()),
        EventKind::UserPrompt { .. } => {
            ensure_agent(state, &event.agent, at).status = AgentStatus::Thinking;
        }
        EventKind::Thinking { .. } | EventKind::AssistantText { .. } => {
            let agent = ensure_agent(state, &event.agent, at);
            agent.status = busy_status(agent);
        }
        EventKind::ModelSeen { model } => {
            let agent = ensure_agent(state, &event.agent, at);
            agent.context_window = cost::context_window(model);
            agent.model = Some(model.clone());
        }
        EventKind::UsageReported { model, usage } => {
            add_usage(state, &event.agent, at, model, usage);
        }
        EventKind::ToolStarted { .. } => start_tool(state, event),
        EventKind::ToolFinished {
            tool_use_id,
            is_error,
            ..
        } => {
            finish_tool(state, event, tool_use_id, *is_error);
        }
        EventKind::SubagentSpawned {
            child,
            agent_type,
            description,
            ..
        } => {
            spawn_subagent(
                state,
                event,
                child,
                agent_type.as_ref(),
                description.as_deref(),
            );
        }
        EventKind::SubagentFinished { child } => {
            let agent = ensure_agent(state, child, at);
            agent.status = AgentStatus::Done;
            agent.active_tools.clear();
            agent.last_activity = agent.last_activity.max(at);
        }
        EventKind::PermissionRequested { .. } => request_permission(state, event),
        EventKind::PermissionResolved { request_id, .. } => {
            resolve_permission(state, event, request_id);
        }
        EventKind::Compacted { .. } => {
            ensure_agent(state, &event.agent, at).status = AgentStatus::Compacting;
        }
        EventKind::TurnEnded { .. } => {
            let agent = ensure_agent(state, &event.agent, at);
            agent.status = AgentStatus::Idle;
            agent.active_tools.clear();
        }
        EventKind::Notification { .. } | EventKind::MessageSent { .. } => {}
        EventKind::Error { .. } => {
            ensure_agent(state, &event.agent, at).status = AgentStatus::Error;
        }
    }
}

fn start_tool(state: &mut SessionState, event: &Event) {
    let EventKind::ToolStarted {
        tool_use_id,
        name,
        tool_kind,
        summary,
        ..
    } = &event.kind
    else {
        return;
    };
    let agent = ensure_agent(state, &event.agent, event.at);
    agent.active_tools.push(ActiveTool {
        tool_use_id: tool_use_id.clone(),
        name: name.clone(),
        tool_kind: *tool_kind,
        summary: summary.clone(),
        started_at: event.at,
    });
    agent.tool_calls += 1;
    agent.status = AgentStatus::Tool;
}

fn finish_tool(state: &mut SessionState, event: &Event, tool_use_id: &ToolUseId, is_error: bool) {
    let agent = ensure_agent(state, &event.agent, event.at);
    agent.active_tools.retain(|t| &t.tool_use_id != tool_use_id);
    if is_error {
        agent.tool_errors += 1;
    }
    agent.status = busy_status(agent);
}

fn request_permission(state: &mut SessionState, event: &Event) {
    let EventKind::PermissionRequested {
        request_id,
        tool_name,
        input,
    } = &event.kind
    else {
        return;
    };
    state.pending.push(PendingPermission {
        request_id: request_id.clone(),
        agent: event.agent.clone(),
        tool_name: tool_name.clone(),
        input: input.clone(),
        requested_at: event.at,
    });
    ensure_agent(state, &event.agent, event.at).status = AgentStatus::AwaitingPermission;
}

fn add_usage(state: &mut SessionState, id: &AgentId, at: TimestampMs, model: &str, usage: &Usage) {
    let cost = cost::cost_usd(model, usage);
    let agent = ensure_agent(state, id, at);
    agent.usage.input += usage.input;
    agent.usage.output += usage.output;
    agent.usage.cache_read += usage.cache_read;
    agent.usage.cache_write += usage.cache_write;
    agent.context_tokens = usage.context_tokens();
    agent.cost_usd += cost;
    state.cost_usd += cost;
}

/// Creates or updates `child` as a subagent of `event.agent`.
fn spawn_subagent(
    state: &mut SessionState,
    event: &Event,
    child: &AgentId,
    agent_type: Option<&String>,
    description: Option<&str>,
) {
    let name = description
        .or(agent_type.map(String::as_str))
        .unwrap_or(child.as_str())
        .to_owned();
    let agent = ensure_agent(state, child, event.at);
    agent.parent = Some(event.agent.clone());
    agent.name = name;
    if let Some(kind) = agent_type {
        agent.agent_type = Some(kind.clone());
    }
    agent.status = AgentStatus::Thinking;
    agent.last_activity = agent.last_activity.max(event.at);
}

/// Removes a pending request and un-blocks the agent that asked, if nothing else is pending.
fn resolve_permission(state: &mut SessionState, event: &Event, request_id: &RequestId) {
    // The asking agent is recorded on the pending entry; fall back to the event's agent.
    let asker = state
        .pending
        .iter()
        .position(|p| &p.request_id == request_id)
        .map_or_else(|| event.agent.clone(), |i| state.pending.remove(i).agent);
    let still_waiting = state.pending.iter().any(|p| p.agent == asker);
    let agent = ensure_agent(state, &asker, event.at);
    if !still_waiting && agent.status == AgentStatus::AwaitingPermission {
        agent.status = busy_status(agent);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::event::{Decision, Resolution, Source, ToolKind};
    use crate::ids::{RequestId, ToolUseId};

    fn ev(agent: &str, at: TimestampMs, kind: EventKind) -> Event {
        Event {
            session: SessionId::new("s"),
            agent: AgentId::new(agent),
            at,
            source: Source::Transcript,
            kind,
        }
    }

    fn started(id: &str) -> EventKind {
        EventKind::ToolStarted {
            tool_use_id: ToolUseId::new(id),
            name: "Read".into(),
            tool_kind: ToolKind::Read,
            summary: "/a".into(),
            input: json!({}),
        }
    }

    fn finished(id: &str, is_error: bool) -> EventKind {
        EventKind::ToolFinished {
            tool_use_id: ToolUseId::new(id),
            is_error,
            output: String::new(),
            duration_ms: None,
        }
    }

    fn main_status(s: &SessionState) -> Option<AgentStatus> {
        s.agents.get(&AgentId::main()).map(|a| a.status)
    }

    #[test]
    fn tracks_tools_and_status() {
        let mut s = SessionState::new(SessionId::new("s"), 0);
        s.apply(&ev("main", 1, EventKind::UserPrompt { text: "hi".into() }));
        assert_eq!(main_status(&s), Some(AgentStatus::Thinking));
        s.apply(&ev("main", 2, started("a")));
        s.apply(&ev("main", 3, started("b")));
        s.apply(&ev(
            "main",
            4,
            EventKind::Thinking {
                text: String::new(),
            },
        ));
        assert_eq!(main_status(&s), Some(AgentStatus::Tool));
        s.apply(&ev("main", 5, finished("a", true)));
        assert_eq!(main_status(&s), Some(AgentStatus::Tool));
        s.apply(&ev("main", 6, finished("b", false)));
        assert_eq!(main_status(&s), Some(AgentStatus::Thinking));
        let main = &s.agents[&AgentId::main()];
        assert_eq!((main.tool_calls, main.tool_errors), (2, 1));
        assert_eq!(s.event_count, 6);
        assert_eq!(s.last_activity, 6);
        s.apply(&ev("main", 7, started("c")));
        s.apply(&ev("main", 8, EventKind::TurnEnded { duration_ms: None }));
        assert_eq!(main_status(&s), Some(AgentStatus::Idle));
        assert_eq!(s.agents[&AgentId::main()].active_tools.len(), 0);
    }

    #[test]
    fn accumulates_usage_and_cost() {
        let mut s = SessionState::new(SessionId::new("s"), 0);
        s.apply(&ev(
            "main",
            1,
            EventKind::ModelSeen {
                model: "claude-haiku-4-5".into(),
            },
        ));
        let usage = Usage {
            input: 1_000_000,
            output: 0,
            cache_read: 0,
            cache_write: 0,
        };
        let kind = EventKind::UsageReported {
            model: "claude-haiku-4-5".into(),
            usage,
        };
        s.apply(&ev("main", 2, kind.clone()));
        s.apply(&ev("main", 3, kind));
        let main = &s.agents[&AgentId::main()];
        assert_eq!(main.context_window, 200_000);
        assert_eq!(main.usage.input, 2_000_000);
        assert_eq!(main.context_tokens, 1_000_000);
        assert!((s.cost_usd - 2.0).abs() < 1e-9);
        assert!((main.cost_usd - 2.0).abs() < 1e-9);
    }

    #[test]
    fn creates_unknown_agents_and_subagents() {
        let mut s = SessionState::new(SessionId::new("s"), 0);
        s.apply(&ev(
            "ghost",
            1,
            EventKind::Notification {
                message: "x".into(),
            },
        ));
        assert_eq!(s.agents[&AgentId::new("ghost")].name, "ghost");
        s.apply(&ev(
            "main",
            2,
            EventKind::SubagentSpawned {
                child: AgentId::new("c1"),
                agent_type: Some("Explore".into()),
                description: None,
                tool_use_id: None,
            },
        ));
        let child = &s.agents[&AgentId::new("c1")];
        assert_eq!(child.parent, Some(AgentId::main()));
        assert_eq!(child.name, "Explore");
        assert_eq!(child.status, AgentStatus::Thinking);
        s.apply(&ev("c1", 3, started("t")));
        s.apply(&ev(
            "main",
            4,
            EventKind::SubagentFinished {
                child: AgentId::new("c1"),
            },
        ));
        let child = &s.agents[&AgentId::new("c1")];
        assert_eq!(child.status, AgentStatus::Done);
        assert_eq!(child.active_tools.len(), 0);
    }

    #[test]
    fn permission_round_trip() {
        let mut s = SessionState::new(SessionId::new("s"), 0);
        s.apply(&ev("main", 1, started("t")));
        s.apply(&ev(
            "main",
            2,
            EventKind::PermissionRequested {
                request_id: RequestId::new("r"),
                tool_name: "Bash".into(),
                input: json!({}),
            },
        ));
        assert_eq!(main_status(&s), Some(AgentStatus::AwaitingPermission));
        assert_eq!(s.pending.len(), 1);
        s.apply(&ev(
            "main",
            3,
            EventKind::PermissionResolved {
                request_id: RequestId::new("r"),
                resolution: Resolution::Decided {
                    decision: Decision::Allow {
                        updated_input: None,
                    },
                },
            },
        ));
        assert_eq!(s.pending.len(), 0);
        assert_eq!(main_status(&s), Some(AgentStatus::Tool));
    }

    #[test]
    fn compaction_and_errors_set_status() {
        let mut s = SessionState::new(SessionId::new("s"), 0);
        s.apply(&ev(
            "main",
            1,
            EventKind::Compacted {
                trigger: None,
                pre_tokens: None,
            },
        ));
        assert_eq!(main_status(&s), Some(AgentStatus::Compacting));
        s.apply(&ev(
            "main",
            2,
            EventKind::Thinking {
                text: String::new(),
            },
        ));
        assert_eq!(main_status(&s), Some(AgentStatus::Thinking));
        s.apply(&ev(
            "main",
            3,
            EventKind::Error {
                message: "x".into(),
            },
        ));
        assert_eq!(main_status(&s), Some(AgentStatus::Error));
    }
}
