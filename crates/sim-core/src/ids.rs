//! Strongly typed identifiers.
//!
//! Claude Code uses plain strings for session, agent, tool-use and request ids. A newtype
//! per id lets the compiler reject passing a `SessionId` where a `ToolUseId` is expected.

use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wraps a raw id.
            #[must_use]
            pub fn new(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }

            /// Borrows the id as `&str` without cloning.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

string_id!(
    /// One Claude Code session: the UUID in `~/.claude/projects/*/<uuid>.jsonl`.
    SessionId
);
string_id!(
    /// One agent inside a session. The main agent is [`AgentId::main`]; subagents use the
    /// id from `subagents/agent-<id>.jsonl`.
    AgentId
);
string_id!(
    /// A `tool_use` block id, pairing a tool call with its `tool_result`.
    ToolUseId
);
string_id!(
    /// A pending permission request held by the server's broker.
    RequestId
);

impl AgentId {
    /// The id used for a session's main (top-level) agent.
    #[must_use]
    pub fn main() -> Self {
        Self::new("main")
    }

    /// The pseudo-agent standing for the human, used as a message sender/recipient.
    #[must_use]
    pub fn user() -> Self {
        Self::new("user")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_bare_string() {
        let id = SessionId::new("abc-123");
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"abc-123\"");
        let back: SessionId = serde_json::from_str("\"abc-123\"").unwrap();
        assert_eq!(back, id);
        assert_eq!(back.to_string(), "abc-123");
    }
}
