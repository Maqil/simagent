//! The hub actor: the single owner of every [`SessionState`] and recent event history.
//!
//! **Why an actor instead of `Arc<Mutex<..>>`:** one task owns the data and everything
//! else talks to it through [`HubHandle`] messages. No lock can be held across an
//! `.await`, and the order in which events are applied is exactly the channel order.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use sim_core::{Event, SessionId, SessionState};
use sim_protocol::{PROTOCOL_VERSION, ServerMsg};
use tokio::sync::{broadcast, mpsc, oneshot};

/// Maximum events kept per session; older ones are dropped first.
pub const MAX_EVENTS_PER_SESSION: usize = 5000;

/// Capacity of the WebSocket fan-out channel. Slow clients that fall further behind
/// get `Lagged` and are resynced with a fresh snapshot.
const BROADCAST_CAPACITY: usize = 4096;

/// Commands understood by the hub actor.
#[derive(Debug)]
pub enum HubCmd {
    /// Apply events in order and broadcast an update for each.
    Ingest(Vec<Event>),
    /// Get a consistent snapshot plus a receiver for everything after it.
    Subscribe(oneshot::Sender<Subscription>),
    /// Get the recent events of one session, oldest first.
    History(SessionId, oneshot::Sender<Vec<Event>>),
    /// Get the working directories of all known sessions (for the file allowlist).
    Cwds(oneshot::Sender<Vec<String>>),
    /// Get the ids of all sessions the hub knows (marks `live` in the session list).
    SessionIds(oneshot::Sender<HashSet<SessionId>>),
    /// Get one session's working directory, if known.
    Cwd(SessionId, oneshot::Sender<Option<String>>),
    /// Broadcast a message to every browser without touching state.
    Broadcast(ServerMsg),
}

/// Reply to [`HubCmd::Subscribe`].
#[derive(Debug)]
pub struct Subscription {
    /// Sessions, most recently active first.
    pub snapshot: Vec<SessionState>,
    /// Updates after the snapshot. Created in the same actor step, so nothing is missed.
    pub updates: broadcast::Receiver<ServerMsg>,
}

/// Cheap, cloneable handle to the hub actor.
#[derive(Debug, Clone)]
pub struct HubHandle {
    tx: mpsc::Sender<HubCmd>,
    clients: Arc<AtomicUsize>,
}

/// Error returned when the hub task has stopped.
#[derive(Debug, thiserror::Error)]
#[error("hub actor stopped")]
pub struct HubGone;

impl HubHandle {
    /// Spawns the hub actor on the current tokio runtime.
    #[must_use]
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel(1024);
        tokio::spawn(run(rx));
        Self {
            tx,
            clients: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Sends events to be applied. Empty batches are skipped.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn ingest(&self, events: Vec<Event>) -> Result<(), HubGone> {
        if events.is_empty() {
            return Ok(());
        }
        self.tx
            .send(HubCmd::Ingest(events))
            .await
            .map_err(|_| HubGone)
    }

    /// Blocking variant of [`HubHandle::ingest`] for the ingest thread. Must not be called
    /// from inside an async task.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub fn ingest_blocking(&self, events: Vec<Event>) -> Result<(), HubGone> {
        if events.is_empty() {
            return Ok(());
        }
        self.tx
            .blocking_send(HubCmd::Ingest(events))
            .map_err(|_| HubGone)
    }

    /// Subscribes to updates, returning the current snapshot first.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn subscribe(&self) -> Result<Subscription, HubGone> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(HubCmd::Subscribe(reply))
            .await
            .map_err(|_| HubGone)?;
        rx.await.map_err(|_| HubGone)
    }

    /// Recent events of `session`, oldest first (empty if unknown).
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn history(&self, session: SessionId) -> Result<Vec<Event>, HubGone> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(HubCmd::History(session, reply))
            .await
            .map_err(|_| HubGone)?;
        rx.await.map_err(|_| HubGone)
    }

    /// Distinct working directories of known sessions.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn cwds(&self) -> Result<Vec<String>, HubGone> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(HubCmd::Cwds(reply))
            .await
            .map_err(|_| HubGone)?;
        rx.await.map_err(|_| HubGone)
    }

    /// Working directory of one session, if the hub has seen it.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn cwd(&self, id: SessionId) -> Result<Option<String>, HubGone> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(HubCmd::Cwd(id, reply))
            .await
            .map_err(|_| HubGone)?;
        rx.await.map_err(|_| HubGone)
    }

    /// Sends `msg` to every connected browser.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn broadcast(&self, msg: ServerMsg) -> Result<(), HubGone> {
        self.tx
            .send(HubCmd::Broadcast(msg))
            .await
            .map_err(|_| HubGone)
    }

    /// Ids of every session the hub currently tracks.
    ///
    /// # Errors
    /// [`HubGone`] if the actor stopped.
    pub async fn session_ids(&self) -> Result<HashSet<SessionId>, HubGone> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(HubCmd::SessionIds(reply))
            .await
            .map_err(|_| HubGone)?;
        rx.await.map_err(|_| HubGone)
    }

    /// Number of connected browser clients. The broker uses it to fall back immediately
    /// when nobody could answer a permission request.
    #[must_use]
    pub fn client_count(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }

    /// Registers a connected client; the count drops when the guard is dropped.
    #[must_use]
    pub fn client_guard(&self) -> ClientGuard {
        self.clients.fetch_add(1, Ordering::SeqCst);
        ClientGuard(Arc::clone(&self.clients))
    }
}

/// Decrements the client count on drop, so a panicking or aborted WS task still counts down.
#[derive(Debug)]
pub struct ClientGuard(Arc<AtomicUsize>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Everything the actor owns.
struct Hub {
    sessions: HashMap<SessionId, SessionState>,
    events: HashMap<SessionId, VecDeque<Event>>,
    updates: broadcast::Sender<ServerMsg>,
}

impl Hub {
    fn apply(&mut self, event: Event) {
        let state = self
            .sessions
            .entry(event.session.clone())
            .or_insert_with(|| SessionState::new(event.session.clone(), event.at));
        state.apply(&event);
        // Clone: the broadcast message must own a copy; the hub keeps the original.
        let msg = ServerMsg::Update {
            event: Box::new(event.clone()),
            state: Box::new(state.clone()),
        };
        let log = self.events.entry(event.session.clone()).or_default();
        if log.len() >= MAX_EVENTS_PER_SESSION {
            log.pop_front();
        }
        log.push_back(event);
        // An error only means nobody is subscribed right now; that's fine.
        let _ = self.updates.send(msg);
    }

    fn snapshot(&self) -> Vec<SessionState> {
        let mut sessions: Vec<SessionState> = self.sessions.values().cloned().collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
        sessions
    }
}

async fn run(mut rx: mpsc::Receiver<HubCmd>) {
    let (updates, _) = broadcast::channel(BROADCAST_CAPACITY);
    let mut hub = Hub {
        sessions: HashMap::new(),
        events: HashMap::new(),
        updates,
    };
    while let Some(cmd) = rx.recv().await {
        match cmd {
            HubCmd::Ingest(events) => events.into_iter().for_each(|e| hub.apply(e)),
            HubCmd::Subscribe(reply) => {
                let _ = reply.send(Subscription {
                    snapshot: hub.snapshot(),
                    updates: hub.updates.subscribe(),
                });
            }
            HubCmd::History(session, reply) => {
                let events = hub
                    .events
                    .get(&session)
                    .map(|log| log.iter().cloned().collect())
                    .unwrap_or_default();
                let _ = reply.send(events);
            }
            HubCmd::Cwds(reply) => {
                let cwds: HashSet<String> = hub
                    .sessions
                    .values()
                    .filter_map(|s| s.cwd.clone())
                    .collect();
                let _ = reply.send(cwds.into_iter().collect());
            }
            HubCmd::Cwd(id, reply) => {
                let _ = reply.send(hub.sessions.get(&id).and_then(|s| s.cwd.clone()));
            }
            HubCmd::Broadcast(msg) => {
                // No receivers is fine: nobody is watching.
                let _ = hub.updates.send(msg);
            }
            HubCmd::SessionIds(reply) => {
                let _ = reply.send(hub.sessions.keys().cloned().collect());
            }
        }
    }
    tracing::debug!("hub stopped");
}

/// Builds the snapshot message for a subscription (shared by connect and lag resync).
#[must_use]
pub fn snapshot_msg(sessions: Vec<SessionState>) -> ServerMsg {
    ServerMsg::Snapshot {
        protocol_version: PROTOCOL_VERSION,
        sessions,
    }
}

#[cfg(test)]
mod tests {
    use sim_core::{AgentId, EventKind, Source};

    use super::*;

    fn notif(session: &str, at: i64) -> Event {
        Event {
            session: SessionId::new(session),
            agent: AgentId::main(),
            at,
            source: Source::Server,
            kind: EventKind::Notification {
                message: "hi".into(),
            },
        }
    }

    #[tokio::test]
    async fn ingest_creates_session_and_broadcasts_update() {
        let hub = HubHandle::spawn();
        let mut sub = hub.subscribe().await.unwrap();
        assert_eq!(sub.snapshot.len(), 0);
        hub.ingest(vec![notif("s1", 10)]).await.unwrap();
        let msg = sub.updates.recv().await.unwrap();
        assert!(matches!(msg, ServerMsg::Update { ref event, .. } if event.at == 10));
        let snap = hub.subscribe().await.unwrap().snapshot;
        assert_eq!(snap.len(), 1);
        assert_eq!(hub.history(SessionId::new("s1")).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn history_is_capped() {
        let hub = HubHandle::spawn();
        let events = (0..i64::try_from(MAX_EVENTS_PER_SESSION + 10).unwrap())
            .map(|i| notif("s", i))
            .collect();
        hub.ingest(events).await.unwrap();
        let hist = hub.history(SessionId::new("s")).await.unwrap();
        assert_eq!(hist.len(), MAX_EVENTS_PER_SESSION);
        assert_eq!(hist[0].at, 10);
    }

    #[tokio::test]
    async fn client_guard_counts() {
        let hub = HubHandle::spawn();
        let g = hub.client_guard();
        assert_eq!(hub.client_count(), 1);
        drop(g);
        assert_eq!(hub.client_count(), 0);
    }
}
