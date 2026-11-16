//! Permission broker: parks a `PermissionRequest` hook until the browser decides.
//!
//! **Flow:** the hook handler calls [`Broker::request`], which emits
//! `PermissionRequested` to the hub, registers a `oneshot` sender with the broker actor
//! and waits (with a timeout) on the receiver. A WebSocket `Decide` message calls
//! [`Broker::decide`], which completes that oneshot. If no browser is connected, or the
//! timeout passes, we return no decision so Claude Code falls back to its terminal dialog.

use std::collections::HashMap;
use std::time::Duration;

use rand::Rng;
use serde_json::{Value, json};
use sim_core::{AgentId, Decision, Event, EventKind, RequestId, Resolution, SessionId, Source};
use tokio::sync::{mpsc, oneshot};

use crate::hub::HubHandle;

/// Commands for the broker actor.
#[derive(Debug)]
enum BrokerCmd {
    Register(RequestId, oneshot::Sender<Decision>),
    Decide(RequestId, Decision),
    Forget(RequestId),
}

/// Cloneable handle to the broker actor.
#[derive(Debug, Clone)]
pub struct Broker {
    tx: mpsc::Sender<BrokerCmd>,
    hub: HubHandle,
    timeout: Duration,
}

impl Broker {
    /// Spawns the broker actor. `timeout` is how long a request waits for the browser.
    #[must_use]
    pub fn spawn(hub: HubHandle, timeout: Duration) -> Self {
        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(run(rx));
        Self { tx, hub, timeout }
    }

    /// Handles one `PermissionRequest` hook body and returns the JSON reply for Claude Code.
    ///
    /// Returns `{}` (no decision) when no UI is connected or nobody decides in time.
    #[tracing::instrument(skip_all)]
    pub async fn request(&self, body: &Value) -> Value {
        let session = SessionId::new(str_field(body, "session_id").unwrap_or("unknown"));
        let agent = str_field(body, "agent_id").map_or_else(AgentId::main, AgentId::new);
        let tool_name = str_field(body, "tool_name").unwrap_or("unknown").to_owned();
        let input = body.get("tool_input").cloned().unwrap_or(Value::Null);
        let request_id = new_request_id();

        let event = |kind| Event {
            session: session.clone(),
            agent: agent.clone(),
            at: crate::now_ms(),
            source: Source::Hook,
            kind,
        };

        // Register before announcing the request, so a decision that arrives right after
        // the browser sees it can never find the id missing.
        let parked = if self.hub.client_count() == 0 {
            tracing::debug!(%request_id, "no UI connected; falling back to terminal");
            None
        } else {
            self.register(&request_id).await
        };

        self.emit(event(EventKind::PermissionRequested {
            request_id: request_id.clone(),
            tool_name,
            input,
        }))
        .await;

        // From here on the browser shows a card. If Claude Code abandons the HTTP request
        // (Esc, its own hook timeout), axum drops this future at an `.await` and the code
        // below never runs; the guard then resolves the card from its `Drop`.
        let mut guard = ResolveOnDrop {
            armed: true,
            hub: self.hub.clone(),
            tx: self.tx.clone(),
            session: session.clone(),
            agent: agent.clone(),
            request_id: request_id.clone(),
        };

        let decision = match parked {
            Some(rx) => self.wait_for_decision(&request_id, rx).await,
            None => None,
        };

        let (reply, resolution) = match decision {
            Some(decision) => (
                sim_core::hooks::permission_reply(&decision),
                Resolution::Decided { decision },
            ),
            None => (json!({}), Resolution::FellBack),
        };
        self.emit(event(EventKind::PermissionResolved {
            request_id,
            resolution,
        }))
        .await;
        // Disarm only after the emit finished: a cancel during that last `.await` still
        // leaves the guard to report the resolution.
        guard.disarm();
        reply
    }

    /// Delivers a decision from the browser. Unknown ids are logged and ignored.
    pub async fn decide(&self, request_id: RequestId, decision: Decision) {
        if self
            .tx
            .send(BrokerCmd::Decide(request_id, decision))
            .await
            .is_err()
        {
            tracing::warn!("broker stopped; decision dropped");
        }
    }

    async fn register(&self, request_id: &RequestId) -> Option<oneshot::Receiver<Decision>> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(BrokerCmd::Register(request_id.clone(), tx))
            .await
            .ok()?;
        Some(rx)
    }

    async fn wait_for_decision(
        &self,
        request_id: &RequestId,
        rx: oneshot::Receiver<Decision>,
    ) -> Option<Decision> {
        if let Ok(Ok(decision)) = tokio::time::timeout(self.timeout, rx).await {
            Some(decision)
        } else {
            tracing::info!(%request_id, "permission request timed out; falling back");
            // Drop the parked sender so a late decision is reported as unknown.
            let _ = self.tx.send(BrokerCmd::Forget(request_id.clone())).await;
            None
        }
    }

    async fn emit(&self, event: Event) {
        if self.hub.ingest(vec![event]).await.is_err() {
            tracing::warn!("hub stopped; permission event dropped");
        }
    }
}

/// Drop guard that resolves a shown permission request when its hook future is dropped.
///
/// **Why:** an async fn can be cancelled at any `.await` (axum drops the handler future
/// when the client disconnects). Without this, the browser card and the broker's parked
/// sender would stay forever. `Drop` cannot `.await`, so it hands the work to a spawned
/// task (hub event) and a non-blocking `try_send` (broker cleanup).
#[derive(Debug)]
struct ResolveOnDrop {
    armed: bool,
    hub: HubHandle,
    tx: mpsc::Sender<BrokerCmd>,
    session: SessionId,
    agent: AgentId,
    request_id: RequestId,
}

impl ResolveOnDrop {
    /// The normal path emitted `PermissionResolved` itself; nothing left to do on drop.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ResolveOnDrop {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        tracing::info!(request_id = %self.request_id, "hook request abandoned; terminal handles it");
        // Best effort: if the broker queue is full the entry is only a stale map slot,
        // and a late decision for it is already logged as "requester gone".
        let _ = self.tx.try_send(BrokerCmd::Forget(self.request_id.clone()));
        let event = Event {
            session: self.session.clone(),
            agent: self.agent.clone(),
            at: crate::now_ms(),
            source: Source::Hook,
            kind: EventKind::PermissionResolved {
                request_id: self.request_id.clone(),
                resolution: Resolution::FellBack,
            },
        };
        // `try_current` instead of `tokio::spawn` directly: spawning outside a runtime
        // (e.g. during runtime shutdown) would panic.
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            tracing::warn!("no runtime; abandoned permission event dropped");
            return;
        };
        let hub = self.hub.clone();
        rt.spawn(async move {
            if hub.ingest(vec![event]).await.is_err() {
                tracing::warn!("hub stopped; abandoned permission event dropped");
            }
        });
    }
}

fn str_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn new_request_id() -> RequestId {
    let bytes: [u8; 8] = rand::rng().random();
    RequestId::new(crate::hex(&bytes))
}

async fn run(mut rx: mpsc::Receiver<BrokerCmd>) {
    let mut pending: HashMap<RequestId, oneshot::Sender<Decision>> = HashMap::new();
    while let Some(cmd) = rx.recv().await {
        match cmd {
            BrokerCmd::Register(id, tx) => {
                pending.insert(id, tx);
            }
            BrokerCmd::Decide(id, decision) => {
                if let Some(tx) = pending.remove(&id) {
                    if tx.send(decision).is_err() {
                        tracing::warn!(request_id = %id, "requester gone before decision");
                    }
                } else {
                    tracing::warn!(request_id = %id, "decision for unknown request");
                }
            }
            BrokerCmd::Forget(id) => {
                pending.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use sim_protocol::ServerMsg;

    use super::*;

    #[tokio::test]
    async fn no_ui_falls_back_immediately() {
        let hub = HubHandle::spawn();
        let broker = Broker::spawn(hub.clone(), Duration::from_secs(60));
        let body = json!({"session_id": "s", "tool_name": "Bash", "tool_input": {}});
        let reply = tokio::time::timeout(Duration::from_secs(2), broker.request(&body))
            .await
            .unwrap();
        assert_eq!(reply, json!({}));
        let hist = hub.history(SessionId::new("s")).await.unwrap();
        assert!(matches!(
            hist.last().map(|e| &e.kind),
            Some(EventKind::PermissionResolved {
                resolution: Resolution::FellBack,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn decision_resolves_waiting_request() {
        let hub = HubHandle::spawn();
        let _client = hub.client_guard();
        let mut sub = hub.subscribe().await.unwrap();
        let broker = Broker::spawn(hub.clone(), Duration::from_secs(10));
        let waiter = {
            let broker = broker.clone();
            tokio::spawn(async move {
                let body = json!({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": "ls"}});
                broker.request(&body).await
            })
        };
        // The browser sees the request, then decides.
        let ServerMsg::Update { event, .. } = sub.updates.recv().await.unwrap() else {
            panic!("expected update");
        };
        let EventKind::PermissionRequested { request_id, .. } = event.kind else {
            panic!("expected PermissionRequested");
        };
        let decision = Decision::Allow {
            updated_input: None,
        };
        broker.decide(request_id, decision.clone()).await;
        let reply = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply, sim_core::hooks::permission_reply(&decision));
        let hist = hub.history(SessionId::new("s")).await.unwrap();
        assert!(matches!(
            hist.last().map(|e| &e.kind),
            Some(EventKind::PermissionResolved {
                resolution: Resolution::Decided { .. },
                ..
            })
        ));
    }

    #[tokio::test]
    async fn abandoned_request_still_resolves() {
        let hub = HubHandle::spawn();
        let _client = hub.client_guard();
        let mut sub = hub.subscribe().await.unwrap();
        let broker = Broker::spawn(hub.clone(), Duration::from_secs(60));
        let waiter = {
            let broker = broker.clone();
            tokio::spawn(async move {
                broker
                    .request(&json!({"session_id": "s", "tool_name": "Bash"}))
                    .await
            })
        };
        let ServerMsg::Update { event, .. } = sub.updates.recv().await.unwrap() else {
            panic!("expected update");
        };
        let EventKind::PermissionRequested { request_id, .. } = event.kind else {
            panic!("expected PermissionRequested");
        };
        // Claude Code hangs up: axum drops the handler future, like this abort.
        waiter.abort();
        let ServerMsg::Update { event, .. } =
            tokio::time::timeout(Duration::from_secs(2), sub.updates.recv())
                .await
                .unwrap()
                .unwrap()
        else {
            panic!("expected update");
        };
        assert!(matches!(
            event.kind,
            EventKind::PermissionResolved {
                request_id: ref id,
                resolution: Resolution::FellBack,
            } if *id == request_id
        ));
    }

    #[tokio::test]
    async fn timeout_falls_back() {
        let hub = HubHandle::spawn();
        let _client = hub.client_guard();
        let broker = Broker::spawn(hub, Duration::from_millis(50));
        let reply = broker.request(&json!({"session_id": "s"})).await;
        assert_eq!(reply, json!({}));
    }
}
