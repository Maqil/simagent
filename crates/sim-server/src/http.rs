//! HTTP surface: hooks, WebSocket, file serving, health and the embedded UI.
//!
//! Every handler is thin: extract, call the hub/broker, map to a response.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Path as UrlPath, Query, State, WebSocketUpgrade, ws,
        ws::rejection::WebSocketUpgradeRejection,
    },
    http::{HeaderMap, StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sim_protocol::{ClientMsg, ServerMsg};
use tokio::sync::broadcast::error::RecvError;

use crate::broker::Broker;
use crate::config::Opts;
use crate::hub::{HubHandle, snapshot_msg};
use crate::ingest::LoadError;
use crate::sessions::SessionCache;
use crate::usage::UsageCache;

/// Largest accepted hook body.
const MAX_HOOK_BODY: usize = 2 * 1024 * 1024;
/// Largest file served by `/api/file`.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Header carrying the token on hook requests.
pub const TOKEN_HEADER: &str = "x-simagent-token";

/// Shared state for all handlers. Cheap to clone (handles and an `Arc`).
#[derive(Debug, Clone)]
pub struct AppState {
    /// Hub actor.
    pub hub: HubHandle,
    /// Permission broker actor.
    pub broker: Broker,
    /// Auth token for hooks, WS and file access.
    pub token: Arc<str>,
    /// Extra allowlisted roots for `/api/file` besides session cwds.
    pub file_roots: Arc<[PathBuf]>,
    /// Claude Code projects dir, read by `/api/sessions` and `/api/replay`.
    pub projects_dir: Arc<Path>,
    /// Summary cache for `/api/sessions`.
    pub sessions: SessionCache,
    /// Incremental per-file usage cache for `/api/usage`.
    pub usage: UsageCache,
    /// Runs browser-driven turns (`claude -p --resume`).
    pub driver: crate::driver::Driver,
    /// Loads sessions on demand. `None` until the ingest thread is started (and in tests
    /// that don't need it).
    pub ingest: Option<crate::ingest::IngestHandle>,
}

impl AppState {
    /// Spawns the hub and broker actors and builds the state.
    #[must_use]
    pub fn new(token: &str, permission_timeout: std::time::Duration) -> Self {
        let hub = HubHandle::spawn();
        let broker = Broker::spawn(hub.clone(), permission_timeout);
        let driver = crate::driver::Driver::spawn(hub.clone(), crate::driver::find_claude());
        Self {
            hub,
            broker,
            driver,
            token: Arc::from(token),
            file_roots: default_file_roots().into(),
            projects_dir: Arc::from(crate::config::default_projects_dir()),
            sessions: SessionCache::default(),
            usage: UsageCache::default(),
            ingest: None,
        }
    }

    /// Attaches the ingest thread's handle, enabling `OpenSession`.
    #[must_use]
    pub fn with_ingest(mut self, ingest: crate::ingest::IngestHandle) -> Self {
        self.ingest = Some(ingest);
        self
    }

    /// Uses `dir` as the projects dir for session listing and replay.
    #[must_use]
    pub fn with_projects_dir(mut self, dir: PathBuf) -> Self {
        self.projects_dir = Arc::from(dir);
        self
    }
}

/// `/tmp`, `/private/tmp` and `~/.claude`.
fn default_file_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".claude"));
    }
    roots
}

/// Builds the router. Kept separate from binding a socket so tests can call it in-process.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/hooks/{event}",
            post(hook).layer(DefaultBodyLimit::max(MAX_HOOK_BODY)),
        )
        .route("/ws", get(ws_upgrade))
        .route("/api/file", get(file))
        .route("/api/sessions", get(sessions))
        .route("/api/replay/{session_id}", get(replay))
        .route("/api/usage", get(usage))
        .fallback(static_ui)
        .with_state(state)
}

/// Runs the server until Ctrl-C: token, actors, ingest, browser, then `axum::serve`.
///
/// # Errors
/// When the token cannot be loaded or the port cannot be bound.
pub async fn serve(opts: &Opts) -> anyhow::Result<()> {
    let token = crate::config::load_or_create_token()?;
    // Bind first: if the port is taken, fail now, before starting background threads
    // (a blocking ingest thread would otherwise keep the process alive after the error).
    // Loopback only: this server hands out file contents and approves tool calls.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, opts.port));
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| {
        format!(
            "port {} is already in use (is another simagent running?). Stop it, or pass --port <other>",
            opts.port
        )
    })?;
    let state =
        AppState::new(&token, opts.permission_timeout()).with_projects_dir(opts.projects_dir());
    let ingest = crate::ingest::spawn(
        state.hub.clone(),
        opts.projects_dir(),
        opts.startup_sessions,
    );
    let state = state.with_ingest(ingest);
    let url = format!("http://{addr}/?token={token}");
    tracing::info!(%addr, "simagent listening");
    // Plain, unmissable line: this is the one thing the user needs from the log.
    eprintln!("\n  simagent is running → open {url}\n");
    if !opts.no_open {
        if let Err(err) = open::that_detached(&url) {
            tracing::warn!(%err, "could not open the browser; open the URL above manually");
        }
    }

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            // If installing the Ctrl-C handler fails we just never shut down gracefully.
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("server error")
}

/// Liveness probe.
async fn healthz() -> &'static str {
    "ok"
}

/// Constant-time-ish comparison so the token can't be guessed byte by byte via timing.
fn token_ok(expected: &str, given: Option<&str>) -> bool {
    let Some(given) = given else { return false };
    expected.len() == given.len()
        && expected
            .bytes()
            .zip(given.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// `POST /hooks/{event}`: every Claude Code hook lands here.
async fn hook(
    State(state): State<AppState>,
    UrlPath(event): UrlPath<String>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    let given = headers.get(TOKEN_HEADER).and_then(|v| v.to_str().ok());
    if !token_ok(&state.token, given) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let body = body.map_or(Value::Null, |Json(v)| v);
    if event == "PermissionRequest" {
        return Json(state.broker.request(&body).await).into_response();
    }
    let events = sim_core::hooks::hook_to_events(&event, &body, crate::now_ms());
    if state.hub.ingest(events).await.is_err() {
        tracing::warn!(%event, "hub stopped; hook dropped");
    }
    Json(json!({})).into_response()
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// `GET /ws?token=`: upgrades to a WebSocket streaming [`ServerMsg`]s.
async fn ws_upgrade(
    State(state): State<AppState>,
    Query(q): Query<TokenQuery>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // Check the token before the upgrade headers, so unauthenticated callers always get 401.
    if !token_ok(&state.token, q.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    upgrade.on_upgrade(move |socket| ws_session(state, socket))
}

#[tracing::instrument(skip_all)]
async fn ws_session(state: AppState, socket: ws::WebSocket) {
    let _guard = state.hub.client_guard();
    let Ok(sub) = state.hub.subscribe().await else {
        return;
    };
    let mut updates = sub.updates;
    let (mut sink, mut stream) = socket.split();
    if send(&mut sink, &snapshot_msg(sub.snapshot)).await.is_err() {
        return;
    }
    tracing::info!("browser connected");
    loop {
        tokio::select! {
            update = updates.recv() => {
                let msg = match update {
                    Ok(msg) => msg,
                    Err(RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "client lagged; resending snapshot");
                        // Resubscribe so the snapshot and the new receiver line up exactly.
                        let Ok(sub) = state.hub.subscribe().await else { break };
                        updates = sub.updates;
                        snapshot_msg(sub.snapshot)
                    }
                    Err(RecvError::Closed) => break,
                };
                if send(&mut sink, &msg).await.is_err() {
                    break;
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(ws::Message::Text(text))) => {
                        if let Some(reply) = handle_client_msg(&state, text.as_str()).await
                            && send(&mut sink, &reply).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(ws::Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    tracing::info!("browser disconnected");
}

async fn handle_client_msg(state: &AppState, text: &str) -> Option<ServerMsg> {
    let msg: ClientMsg = match serde_json::from_str(text) {
        Ok(msg) => msg,
        Err(err) => {
            tracing::warn!(%err, "ignoring malformed client message");
            return None;
        }
    };
    match msg {
        ClientMsg::Decide {
            request_id,
            decision,
        } => {
            state.broker.decide(request_id, decision).await;
            None
        }
        ClientMsg::LoadHistory { session } => {
            let events = state.hub.history(session.clone()).await.ok()?;
            Some(ServerMsg::History { session, events })
        }
        ClientMsg::Prompt { session, text } => {
            state.driver.prompt(session, text).await;
            None
        }
        ClientMsg::Interrupt { session } => {
            state.driver.interrupt(session).await;
            None
        }
        ClientMsg::OpenSession { session } => {
            open_session(state, session).await;
            None
        }
        other => {
            tracing::warn!(?other, "unhandled client message");
            None
        }
    }
}

/// Starts following `session`. Its state then reaches every browser through the hub, so
/// there is no reply; a bad id is only logged (the browser's History lists real ids).
async fn open_session(state: &AppState, session: sim_core::SessionId) {
    let Some(ingest) = state.ingest.clone() else {
        tracing::warn!(%session, "open requested but ingest is not running");
        return;
    };
    // `open` lists a directory: keep blocking file work off the async runtime.
    let id = session.clone();
    match tokio::task::spawn_blocking(move || ingest.open(id.as_str())).await {
        Ok(Ok(())) => tracing::info!(%session, "opened session on demand"),
        Ok(Err(err)) => tracing::warn!(%session, %err, "could not open session"),
        Err(err) => tracing::warn!(%session, %err, "open task failed"),
    }
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<ws::WebSocket, ws::Message>,
    msg: &ServerMsg,
) -> Result<(), ()> {
    let text = serde_json::to_string(msg).map_err(|err| {
        tracing::warn!(%err, "could not serialize server message");
    })?;
    sink.send(ws::Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

/// `GET /api/sessions?token=`: every transcript on disk, newest first.
async fn sessions(State(state): State<AppState>, Query(q): Query<TokenQuery>) -> Response {
    if !token_ok(&state.token, q.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let live = state.hub.session_ids().await.unwrap_or_default();
    let dir = Arc::clone(&state.projects_dir);
    let cache = state.sessions.clone();
    match tokio::task::spawn_blocking(move || cache.list(&dir, &live)).await {
        Ok(list) => Json(list).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Default and bounds of the `days` window of `/api/usage`.
const USAGE_DAYS_DEFAULT: i64 = 30;
const USAGE_DAYS_MAX: i64 = 365;

#[derive(Debug, Deserialize)]
struct UsageQuery {
    token: Option<String>,
    /// Signed so `days=0` or `days=-3` clamps to 1 instead of being a 400.
    days: Option<i64>,
}

/// `GET /api/usage?token=&days=N`: hour buckets and 5-hour blocks over the last `N` days
/// (default 30, clamped to 1..=365) of every transcript on disk.
async fn usage(State(state): State<AppState>, Query(q): Query<UsageQuery>) -> Response {
    if !token_ok(&state.token, q.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let days = q
        .days
        .unwrap_or(USAGE_DAYS_DEFAULT)
        .clamp(1, USAGE_DAYS_MAX);
    // In range 1..=365 after the clamp, so the conversion cannot fail.
    let days = u32::try_from(days).unwrap_or(1);
    let live = state.hub.session_ids().await.unwrap_or_default();
    let dir = Arc::clone(&state.projects_dir);
    let (sessions, usage) = (state.sessions.clone(), state.usage.clone());
    let report = tokio::task::spawn_blocking(move || {
        let list = sessions.list(&dir, &live);
        usage.report(&dir, &list, crate::now_ms(), days)
    })
    .await;
    match report {
        Ok(report) => Json(report).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `GET /api/replay/{session_id}?token=`: the whole session parsed from disk, for replay
/// of sessions the live hub never loaded (or only partly keeps).
#[tracing::instrument(skip_all, fields(session = %session_id))]
async fn replay(
    State(state): State<AppState>,
    UrlPath(session_id): UrlPath<String>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !token_ok(&state.token, q.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Validate before moving to a blocking thread: cheap, and keeps errors uniform.
    if !crate::ingest::valid_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, LoadError::InvalidId.to_string()).into_response();
    }
    let dir = Arc::clone(&state.projects_dir);
    let id = session_id.clone();
    let loaded =
        tokio::task::spawn_blocking(move || crate::ingest::load_session_events(&dir, &id)).await;
    match loaded {
        Ok(Ok(events)) => Json(json!({ "session": session_id, "events": events })).into_response(),
        Ok(Err(err)) => {
            let status = match &err {
                LoadError::InvalidId => StatusCode::BAD_REQUEST,
                LoadError::NotFound => StatusCode::NOT_FOUND,
                LoadError::Io { .. } => {
                    tracing::warn!(%err, "replay load failed");
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            };
            (status, err.to_string()).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
    token: Option<String>,
}

/// Why a file request was refused.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FileError {
    /// Not absolute, contains `..`, or does not resolve.
    #[error("invalid path")]
    Invalid,
    /// Resolves outside every allowlisted root.
    #[error("path not allowed")]
    Forbidden,
    /// Larger than the cap.
    #[error("file too large")]
    TooLarge,
    /// Not a regular file.
    #[error("not a file")]
    NotFile,
}

/// Resolves `requested` and checks it lies under one of `roots` (also canonicalized).
///
/// `..` components are rejected outright, and canonicalization resolves symlinks, so a
/// link inside an allowed root that points outside is refused too.
///
/// # Errors
/// See [`FileError`].
pub fn resolve_allowed(requested: &str, roots: &[PathBuf]) -> Result<PathBuf, FileError> {
    let path = Path::new(requested);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| c == std::path::Component::ParentDir)
    {
        return Err(FileError::Invalid);
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| FileError::Invalid)?;
    let allowed = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|root| canonical.starts_with(&root));
    if !allowed {
        return Err(FileError::Forbidden);
    }
    let meta = std::fs::metadata(&canonical).map_err(|_| FileError::Invalid)?;
    if !meta.is_file() {
        return Err(FileError::NotFile);
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    Ok(canonical)
}

/// `GET /api/file?path=&token=`: serves a file from an allowlisted root.
async fn file(State(state): State<AppState>, Query(q): Query<FileQuery>) -> Response {
    if !token_ok(&state.token, q.token.as_deref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut roots: Vec<PathBuf> = state.file_roots.to_vec();
    roots.extend(
        state
            .hub
            .cwds()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from),
    );
    let resolved = match tokio::task::spawn_blocking(move || resolve_allowed(&q.path, &roots)).await
    {
        Ok(Ok(path)) => path,
        Ok(Err(err)) => {
            let status = match err {
                FileError::Invalid | FileError::NotFile => StatusCode::BAD_REQUEST,
                FileError::Forbidden => StatusCode::FORBIDDEN,
                FileError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            };
            return (status, err.to_string()).into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match tokio::fs::read(&resolved).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&resolved).first_or_octet_stream();
            (
                [
                    (header::CONTENT_TYPE, mime.essence_str().to_owned()),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(err) => {
            tracing::warn!(%err, path = %resolved.display(), "could not read file");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// The built web UI, embedded at compile time. `allow_missing` lets the server build
/// before `web/dist` exists; then the fallback page below is served.
#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct WebAssets;

const NO_UI_PAGE: &str = "<!doctype html><meta charset=utf-8><title>simagent</title>\
<body style=\"font-family:system-ui;padding:2rem\"><h1>simagent</h1>\
<p>The web UI is not built into this binary. Run <code>just web-build</code> and rebuild the server.</p>";

/// Serves embedded assets; unknown non-API paths get `index.html` (client-side routing).
async fn static_ui(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("hooks/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let asset = if path.is_empty() {
        None
    } else {
        WebAssets::get(path).map(|f| (path, f))
    };
    let Some((name, file)) =
        asset.or_else(|| WebAssets::get("index.html").map(|f| ("index.html", f)))
    else {
        return Html(NO_UI_PAGE).into_response();
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    Response::builder()
        .header(header::CONTENT_TYPE, mime.essence_str())
        .body(Body::from(file.data.into_owned()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn app() -> Router {
        router(AppState::new(TOKEN, Duration::from_secs(60)))
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn healthz_says_ok() {
        let resp = app()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn hook_without_token_is_401() {
        let resp = app()
            .oneshot(
                Request::post("/hooks/Stop")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn hook_with_wrong_token_is_401() {
        let resp = app()
            .oneshot(
                Request::post("/hooks/Stop")
                    .header(TOKEN_HEADER, "nope")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn hook_with_token_is_ok() {
        let resp = app()
            .oneshot(
                Request::post("/hooks/Stop")
                    .header(TOKEN_HEADER, TOKEN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"session_id":"s"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({}));
    }

    #[tokio::test]
    async fn permission_request_without_ui_returns_empty_object_quickly() {
        let req = Request::post("/hooks/PermissionRequest")
            .header(TOKEN_HEADER, TOKEN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"session_id":"s","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
            ))
            .unwrap();
        let resp = tokio::time::timeout(Duration::from_secs(2), app().oneshot(req))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({}));
    }

    #[tokio::test]
    async fn oversized_hook_body_is_rejected() {
        let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_HOOK_BODY + 1));
        let resp = app()
            .oneshot(
                Request::post("/hooks/Stop")
                    .header(TOKEN_HEADER, TOKEN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(big))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn ws_without_token_is_401() {
        let resp = app()
            .oneshot(Request::get("/ws").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn file_without_token_is_401() {
        let resp = app()
            .oneshot(
                Request::get("/api/file?path=/tmp/x")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn file_etc_passwd_is_forbidden_over_http() {
        let resp = app()
            .oneshot(
                Request::get(format!("/api/file?path=/etc/passwd&token={TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn allowlist_rejects_outside_and_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.txt"), b"hi").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"no").unwrap();
        let roots = vec![root.clone()];

        assert_eq!(
            resolve_allowed("/etc/passwd", &roots),
            Err(FileError::Forbidden)
        );
        let traversal = format!("{}/../secret.txt", root.display());
        assert_eq!(resolve_allowed(&traversal, &roots), Err(FileError::Invalid));
        assert_eq!(
            resolve_allowed("relative.txt", &roots),
            Err(FileError::Invalid)
        );
        let ok = resolve_allowed(&format!("{}/ok.txt", root.display()), &roots).unwrap();
        assert!(ok.ends_with("ok.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn allowlist_rejects_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"no").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link")).unwrap();
        let link = format!("{}/link", root.display());
        assert_eq!(resolve_allowed(&link, &[root]), Err(FileError::Forbidden));
    }

    #[tokio::test]
    async fn root_serves_html() {
        let resp = app()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(ct.starts_with("text/html"));
    }

    /// A projects dir with one session `sess-1` (two main records) and one finished
    /// subagent `abc` whose records fall between them.
    fn replay_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("-home-user-project");
        let subs = proj.join("sess-1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let rec = |kind: &str, ts: &str, side: bool, content: &str| {
            format!(
                r#"{{"type":"{kind}","isSidechain":{side},"cwd":"/home/user/project","sessionId":"sess-1","uuid":"u-{ts}","timestamp":"2026-11-14T10:00:{ts}.000Z","message":{{"role":"{kind}","content":{content}}}}}"#
            )
        };
        let main = [
            rec("user", "00", false, r#""hello""#),
            r#"{"type":"ai-title","aiTitle":"Old title","sessionId":"sess-1"}"#.to_owned(),
            rec(
                "assistant",
                "10",
                false,
                r#"[{"type":"text","text":"done"}]"#,
            ),
            r#"{"type":"ai-title","aiTitle":"Fixture session","sessionId":"sess-1"}"#.to_owned(),
        ];
        std::fs::write(proj.join("sess-1.jsonl"), main.join("\n") + "\n").unwrap();
        let sub = [
            rec("user", "05", true, r#""look around""#),
            rec(
                "assistant",
                "06",
                true,
                r#"[{"type":"text","text":"found it"}]"#,
            ),
        ];
        std::fs::write(subs.join("agent-abc.jsonl"), sub.join("\n") + "\n").unwrap();
        std::fs::write(
            subs.join("agent-abc.meta.json"),
            r#"{"agentType":"Explore","description":"look","finished":true}"#,
        )
        .unwrap();
        dir
    }

    fn app_with(dir: &Path) -> Router {
        router(AppState::new(TOKEN, Duration::from_secs(60)).with_projects_dir(dir.to_path_buf()))
    }

    async fn get(app: Router, uri: &str) -> Response {
        app.oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn sessions_lists_transcripts_with_title_and_subagents() {
        let dir = replay_fixture();
        let resp = get(
            app_with(dir.path()),
            &format!("/api/sessions?token={TOKEN}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let list: Vec<sim_protocol::SessionSummary> =
            serde_json::from_value(body_json(resp).await).unwrap();
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.id.as_str(), "sess-1");
        assert_eq!(s.project, "-home-user-project");
        assert_eq!(s.title.as_deref(), Some("Fixture session"));
        assert_eq!(s.cwd.as_deref(), Some("/home/user/project"));
        assert_eq!(s.subagents, 1);
        assert!(!s.live);
    }

    #[tokio::test]
    async fn usage_requires_token_and_clamps_days() {
        let dir = replay_fixture();
        let app = app_with(dir.path());
        let resp = get(app.clone(), "/api/usage").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let resp = get(app.clone(), "/api/usage?token=wrong").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let window = |r: &sim_protocol::UsageReport| (r.generated_ms - r.since_ms) / 86_400_000;
        for (query, days) in [
            ("", 30),
            ("&days=0", 1),
            ("&days=-4", 1),
            ("&days=7", 7),
            ("&days=9999", 365),
        ] {
            let resp = get(app.clone(), &format!("/api/usage?token={TOKEN}{query}")).await;
            assert_eq!(resp.status(), StatusCode::OK, "{query}");
            let report: sim_protocol::UsageReport =
                serde_json::from_value(body_json(resp).await).unwrap();
            assert_eq!(window(&report), days, "{query}");
        }
    }

    #[tokio::test]
    async fn usage_reports_session_with_title_from_listing() {
        let dir = replay_fixture();
        let main = dir.path().join("-home-user-project").join("sess-1.jsonl");
        let ts = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let text = std::fs::read_to_string(&main).unwrap();
        let record = format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"u1","model":"claude-opus-5-5","content":[],"usage":{{"input_tokens":7,"output_tokens":3}}}}}}"#
        );
        std::fs::write(&main, text + &record + "\n").unwrap();
        let resp = get(app_with(dir.path()), &format!("/api/usage?token={TOKEN}")).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let report: sim_protocol::UsageReport =
            serde_json::from_value(body_json(resp).await).unwrap();
        assert_eq!(report.sessions.len(), 1);
        let s = &report.sessions[0];
        assert_eq!(s.title.as_deref(), Some("Fixture session"));
        assert_eq!(s.cwd.as_deref(), Some("/home/user/project"));
        assert_eq!(s.buckets.len(), 1);
        assert_eq!(s.buckets[0].usage.input, 7);
        assert_eq!(report.blocks.len(), 1);
        assert!(report.blocks[0].active);
    }

    #[tokio::test]
    async fn sessions_without_token_is_401() {
        let dir = replay_fixture();
        let resp = get(app_with(dir.path()), "/api/sessions").await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn replay_merges_sorted_events_with_spawn_before_child() {
        let dir = replay_fixture();
        let resp = get(
            app_with(dir.path()),
            &format!("/api/replay/sess-1?token={TOKEN}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["session"], "sess-1");
        let events: Vec<sim_core::Event> = serde_json::from_value(body["events"].clone()).unwrap();
        assert!(
            events.windows(2).all(|w| w[0].at <= w[1].at),
            "sorted by at"
        );
        let spawn = events
            .iter()
            .position(|e| matches!(&e.kind, sim_core::EventKind::SubagentSpawned { child, .. } if child.as_str() == "abc"))
            .unwrap();
        let first_child = events
            .iter()
            .position(|e| e.agent.as_str() == "abc")
            .unwrap();
        assert!(spawn < first_child, "spawn precedes the child's events");
        let finished = events
            .iter()
            .position(|e| matches!(e.kind, sim_core::EventKind::SubagentFinished { .. }))
            .unwrap();
        let last_child = events
            .iter()
            .rposition(|e| e.agent.as_str() == "abc")
            .unwrap();
        assert!(finished > last_child);
        assert!(
            events
                .iter()
                .any(|e| e.agent == sim_core::AgentId::main() && e.at > events[finished].at)
        );
    }

    #[tokio::test]
    async fn replay_rejects_bad_id_unknown_id_and_missing_token() {
        let dir = replay_fixture();
        let bad = get(
            app_with(dir.path()),
            &format!("/api/replay/..%2Fx?token={TOKEN}"),
        )
        .await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        let bad = get(
            app_with(dir.path()),
            &format!("/api/replay/a.b?token={TOKEN}"),
        )
        .await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        let unknown = get(
            app_with(dir.path()),
            &format!("/api/replay/nope-123?token={TOKEN}"),
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        let anon = get(app_with(dir.path()), "/api/replay/sess-1").await;
        assert_eq!(anon.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn token_comparison() {
        assert!(token_ok("abc", Some("abc")));
        assert!(!token_ok("abc", Some("abd")));
        assert!(!token_ok("abc", Some("ab")));
        assert!(!token_ok("abc", None));
    }
}
