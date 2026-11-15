//! Converts Claude Code HTTP hook payloads into [`Event`]s and decisions into hook replies.
//!
//! Hooks overlap with the transcript (both see tool calls), so only events the transcript
//! cannot provide, or provides late, are produced here. That avoids duplicate tool events.

use serde_json::{Map, Value, json};

use crate::event::{Decision, Event, EventKind, Source, TimestampMs};
use crate::ids::{AgentId, SessionId};

/// Converts a hook body (`hook_event_name` = `event_name`) into events. `PermissionRequest`
/// is handled by the broker, not here, so it yields nothing.
#[must_use]
pub fn hook_to_events(event_name: &str, body: &Value, at: TimestampMs) -> Vec<Event> {
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    let owned = |key: &str| text(key).map(str::to_owned);
    let Some(session) = text("session_id") else {
        tracing::debug!(event_name, "hook body without session_id");
        return Vec::new();
    };
    let hook_agent = text("agent_id").map(AgentId::new);
    let subagent_child = || {
        hook_agent.clone().or_else(|| {
            tracing::debug!(event_name, "subagent hook without agent_id");
            None
        })
    };

    // Subagent lifecycle events are reported on the parent (main) agent.
    let (agent, kind) = match event_name {
        "SessionStart" => (
            None,
            EventKind::SessionStarted {
                cwd: owned("cwd"),
                git_branch: None,
                version: None,
            },
        ),
        "UserPromptSubmit" => (
            None,
            EventKind::UserPrompt {
                text: owned("prompt").unwrap_or_default(),
            },
        ),
        "SubagentStart" => {
            let Some(child) = subagent_child() else {
                return Vec::new();
            };
            let kind = EventKind::SubagentSpawned {
                child,
                agent_type: owned("agent_type"),
                description: None,
                tool_use_id: None,
            };
            (Some(AgentId::main()), kind)
        }
        "SubagentStop" => {
            let Some(child) = subagent_child() else {
                return Vec::new();
            };
            (Some(AgentId::main()), EventKind::SubagentFinished { child })
        }
        "Stop" => (None, EventKind::TurnEnded { duration_ms: None }),
        "Notification" => (
            None,
            EventKind::Notification {
                message: owned("message").unwrap_or_default(),
            },
        ),
        "PreCompact" => (
            None,
            EventKind::Compacted {
                trigger: owned("trigger"),
                pre_tokens: None,
            },
        ),
        // PreToolUse/PostToolUse: the transcript already yields ToolStarted/ToolFinished.
        // PermissionRequest: owned by the broker.
        "PreToolUse" | "PostToolUse" | "PermissionRequest" => return Vec::new(),
        other => {
            tracing::debug!(event_name = other, "ignoring unknown hook event");
            return Vec::new();
        }
    };
    vec![Event {
        session: SessionId::new(session),
        agent: agent.or(hook_agent).unwrap_or_else(AgentId::main),
        at,
        source: Source::Hook,
        kind,
    }]
}

/// Builds the JSON body Claude Code expects in reply to a `PermissionRequest` hook.
#[must_use]
pub fn permission_reply(decision: &Decision) -> Value {
    let decision = match decision {
        Decision::Allow { updated_input } => {
            let mut d = Map::new();
            d.insert("behavior".into(), json!("allow"));
            if let Some(input) = updated_input {
                d.insert("updatedInput".into(), input.clone());
            }
            Value::Object(d)
        }
        Decision::Deny { message } => json!({ "behavior": "deny", "message": message }),
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(name: &str, body: &Value) -> Event {
        let mut events = hook_to_events(name, body, 42);
        assert_eq!(events.len(), 1, "{name}");
        events.remove(0)
    }

    #[test]
    fn maps_session_and_prompt_hooks() {
        let e = one("SessionStart", &json!({"session_id": "s", "cwd": "/w"}));
        assert_eq!(e.session, SessionId::new("s"));
        assert_eq!(e.agent, AgentId::main());
        assert_eq!(e.source, Source::Hook);
        assert_eq!(e.at, 42);
        assert_eq!(
            e.kind,
            EventKind::SessionStarted {
                cwd: Some("/w".into()),
                git_branch: None,
                version: None
            }
        );
        let e = one(
            "UserPromptSubmit",
            &json!({"session_id": "s", "prompt": "go", "agent_id": "a1"}),
        );
        assert_eq!(e.agent, AgentId::new("a1"));
        assert_eq!(e.kind, EventKind::UserPrompt { text: "go".into() });
    }

    #[test]
    fn subagent_hooks_report_on_main() {
        let e = one(
            "SubagentStart",
            &json!({"session_id": "s", "agent_id": "c", "agent_type": "Explore"}),
        );
        assert_eq!(e.agent, AgentId::main());
        assert_eq!(
            e.kind,
            EventKind::SubagentSpawned {
                child: AgentId::new("c"),
                agent_type: Some("Explore".into()),
                description: None,
                tool_use_id: None
            }
        );
        let e = one("SubagentStop", &json!({"session_id": "s", "agent_id": "c"}));
        assert_eq!(
            e.kind,
            EventKind::SubagentFinished {
                child: AgentId::new("c")
            }
        );
        assert_eq!(
            hook_to_events("SubagentStop", &json!({"session_id": "s"}), 0).len(),
            0
        );
    }

    #[test]
    fn maps_stop_notification_and_compact() {
        let b = json!({"session_id": "s", "message": "needs input", "trigger": "manual"});
        assert_eq!(
            one("Stop", &b).kind,
            EventKind::TurnEnded { duration_ms: None }
        );
        assert_eq!(
            one("Notification", &b).kind,
            EventKind::Notification {
                message: "needs input".into()
            }
        );
        assert_eq!(
            one("PreCompact", &b).kind,
            EventKind::Compacted {
                trigger: Some("manual".into()),
                pre_tokens: None
            }
        );
    }

    #[test]
    fn ignores_tool_permission_unknown_and_sessionless_hooks() {
        let b = json!({"session_id": "s"});
        for name in ["PreToolUse", "PostToolUse", "PermissionRequest", "Whatever"] {
            assert_eq!(hook_to_events(name, &b, 0).len(), 0, "{name}");
        }
        assert_eq!(hook_to_events("Stop", &json!({}), 0).len(), 0);
    }

    #[test]
    fn builds_permission_replies() {
        let allow = permission_reply(&Decision::Allow {
            updated_input: None,
        });
        assert_eq!(
            allow,
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}})
        );
        let edited = permission_reply(&Decision::Allow {
            updated_input: Some(json!({"command": "ls"})),
        });
        assert_eq!(
            edited["hookSpecificOutput"]["decision"]["updatedInput"],
            json!({"command": "ls"})
        );
        let deny = permission_reply(&Decision::Deny {
            message: "no".into(),
        });
        assert_eq!(
            deny,
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "no"}}})
        );
    }
}
