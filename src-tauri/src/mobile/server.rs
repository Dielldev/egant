//! The phone's HTTP API: an explicit list of what a paired phone may do, and
//! nothing else.
//!
//! Reads: the session and project lists, the chat agents and their models, a
//! window of one transcript, the Mac's wallpaper, and the live event stream.
//! Writes: start a chat in a project the Mac already has open, send a
//! message, stop a turn, switch a session's model or permission mode, answer
//! a permission request, answer a decision prompt. Each write goes through
//! [`crate::service`] — the same code the desktop window's commands run — so
//! the desktop stays the one place the agents live, and the window hears
//! about everything the phone does.
//!
//! What is deliberately absent matters as much: no path is ever taken from
//! the phone (a project is named by its id, and only one the Mac already
//! has), nothing runs a shell or a terminal, nothing reads or writes a file
//! beyond the one wallpaper the user picked, installs an agent, opens a
//! folder or touches git on its own — a new chat's worktree follows the
//! Mac's own default.
//!
//! Every request must name a host egant answers to (loopback on its own port,
//! or this Mac's `*.ts.net` name — through `tailscale serve` on the tailnet,
//! or Funnel from the internet), which shuts out DNS-rebinding pages. Every
//! write must carry an `X-Egant-Client` header, which a cross-site form or
//! image cannot send and a cross-site script cannot either without a CORS
//! preflight this server never grants.
//!
//! Whichever way a request arrives, it comes from 127.0.0.1 — Tailscale's
//! proxy is local — so nothing here trusts the peer address: the device token
//! is the only credential, on every route but health, pairing and the app's
//! own files.

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header, request::Parts};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{Value, json};
use std::convert::Infallible;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

use super::auth::PairError;
use super::{Device, MobileShared, assets, dto};
use crate::service::{self, DecisionOutcome};
use crate::sessions::PermissionAnswer;
use crate::state::AppState;
use crate::sync::{self, Envelope, Origin, SyncHub};
use crate::worktrees::{self, CheckoutPlan};
use egant_harness::{AgentId, AgentModel, PermissionMode};

/// The cookie a paired phone carries.
pub const COOKIE: &str = "egant_device";
const CLIENT_HEADER: &str = "x-egant-client";
const MAX_MESSAGE_BYTES: usize = 100_000;
const MAX_DECISION_REPLY_BYTES: usize = 20_000;
/// The largest wallpaper the phone is sent. Anything bigger is a camera
/// original that has no business crossing a phone connection.
const MAX_WALLPAPER_BYTES: u64 = 25 * 1024 * 1024;
/// The agents egant drives itself — the ones a phone can chat with.
const CHAT_AGENTS: [AgentId; 3] = [AgentId::Claude, AgentId::Codex, AgentId::Opencode];

#[derive(Clone)]
pub struct Ctx {
    pub app: AppHandle,
    pub shared: Arc<MobileShared>,
    pub port: u16,
}

pub fn router(ctx: Ctx) -> Router {
    let api = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/unpair", post(unpair))
        .route("/api/v1/state", get(state))
        .route("/api/v1/events", get(events))
        .route("/api/v1/agents", get(agents))
        .route("/api/v1/agents/{agent}/models", get(models))
        .route("/api/v1/sessions", post(create_session))
        .route("/api/v1/sessions/{id}/transcript", get(transcript))
        .route("/api/v1/sessions/{id}/messages", post(send_message))
        .route("/api/v1/sessions/{id}/interrupt", post(interrupt))
        .route("/api/v1/sessions/{id}/model", post(set_model))
        .route("/api/v1/sessions/{id}/mode", post(set_mode))
        .route(
            "/api/v1/sessions/{id}/permissions/{request_id}",
            post(answer_permission),
        )
        .route(
            "/api/v1/sessions/{id}/decisions/{decision_id}",
            post(answer_decision),
        )
        .layer(middleware::from_fn(no_store));
    // Cached on the phone by version, so outside `no_store`.
    let files = Router::new().route("/api/v1/wallpaper", get(wallpaper));
    Router::new()
        .merge(api)
        .merge(files)
        .fallback(fallback)
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async fn guard(State(ctx): State<Ctx>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !host_allowed(host, ctx.port) {
        log::warn!("mobile: refused a request addressed to host {host:?}");
        return (StatusCode::MISDIRECTED_REQUEST, "unknown host").into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    response
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `(name, port)` of a `Host` header, IPv6 literals included.
fn split_host(host: &str) -> (&str, Option<&str>) {
    if host.starts_with('[') {
        return match host.find(']') {
            Some(end) => (&host[..=end], host[end + 1..].strip_prefix(':')),
            None => (host, None),
        };
    }
    match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    }
}

/// Loopback on egant's own port (this Mac, or `tailscale serve` proxying to
/// it), or a `*.ts.net` name (the same proxy keeping the name it was asked
/// by — the public link through Funnel included, as it is this Mac's name
/// too). Anything else is a page that pointed its own domain at 127.0.0.1.
pub fn host_allowed(host: &str, port: u16) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let (name, host_port) = split_host(&host);
    let name = name.trim_end_matches('.');
    match name {
        "127.0.0.1" | "localhost" | "[::1]" => {
            host_port.and_then(|p| p.parse::<u16>().ok()) == Some(port)
        }
        _ => name.len() > ".ts.net".len() && name.ends_with(".ts.net"),
    }
}

/// Whether the phone reached egant over HTTPS, which only Tailscale (`serve`
/// or Funnel) provides — the one case the device cookie can be marked
/// `Secure`.
fn is_https(headers: &HeaderMap) -> bool {
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"));
    let tailnet_name = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| {
            let host = host.to_ascii_lowercase();
            split_host(&host)
                .0
                .trim_end_matches('.')
                .ends_with(".ts.net")
        });
    forwarded || tailnet_name
}

fn device_cookie(token: &str, secure: bool) -> String {
    format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000{}",
        if secure { "; Secure" } else { "" }
    )
}

fn cleared_cookie(secure: bool) -> String {
    format!(
        "{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        if secure { "; Secure" } else { "" }
    )
}

/// The device token: the cookie, or a bearer header for scripted clients.
fn token_from(headers: &HeaderMap) -> Option<String> {
    if let Some(bearer) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        return Some(bearer.trim().to_string());
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == COOKIE && !value.is_empty()).then(|| value.to_string())
        })
}

impl FromRequestParts<Ctx> for Device {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, ctx: &Ctx) -> Result<Self, Self::Rejection> {
        let token = token_from(&parts.headers).ok_or_else(ApiError::unpaired)?;
        ctx.shared
            .authenticate(&token)
            .ok_or_else(ApiError::unpaired)
    }
}

/// The page load a write came from, named in `X-Egant-Client`. Required on
/// every write: it is both the CSRF guard and how the page recognises its own
/// changes coming back on the event stream.
pub struct Client(String);

impl FromRequestParts<Ctx> for Client {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _ctx: &Ctx) -> Result<Self, Self::Rejection> {
        let id = parts
            .headers
            .get(CLIENT_HEADER)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let valid = (8..=64).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !valid {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "missing X-Egant-Client header",
            ));
        }
        Ok(Client(id.to_string()))
    }
}

impl Client {
    fn origin(self) -> Origin {
        Origin::Client(self.0)
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }

    fn unpaired() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "This device isn't paired with egant.",
        )
    }

    fn unknown_session() -> Self {
        Self::new(StatusCode::NOT_FOUND, "unknown session")
    }

    /// A refusal from the session layer: a session that no longer exists, or
    /// one that cannot take this right now (a CLI session, a folder that
    /// vanished, a conversation with nothing to resume).
    fn from_service(message: String) -> Self {
        if message == "unknown session" {
            Self::unknown_session()
        } else {
            Self::new(StatusCode::CONFLICT, message)
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Runs `work` against the app state on the blocking pool: it takes the same
/// lock the desktop window's commands take, and sending a turn can start a
/// process and write the session to disk.
async fn with_state<T: Send + 'static>(
    ctx: &Ctx,
    work: impl FnOnce(&AppHandle, &mut AppState) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let app = ctx.app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<AppState>>();
        let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
        work(&app, &mut guard)
    })
    .await
    .map_err(|_| ApiError::internal())?
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

async fn health(State(ctx): State<Ctx>, headers: HeaderMap) -> Json<Value> {
    let paired = token_from(&headers).is_some_and(|token| ctx.shared.is_known(&token));
    Json(json!({ "app": "egant", "paired": paired }))
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(default)]
    name: Option<String>,
}

async fn pair(
    State(ctx): State<Ctx>,
    _client: Client,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> Result<Response, ApiError> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let (device, token) = ctx
        .shared
        .pair(&body.code, body.name.as_deref(), user_agent)
        .map_err(|error| match error {
            PairError::Invalid => ApiError::new(
                StatusCode::FORBIDDEN,
                "That code isn't valid any more. Make a new one on your Mac: Settings → Devices → Connect a device.",
            ),
            PairError::TooManyAttempts => ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many wrong codes. Make a new one on your Mac.",
            ),
        })?;
    log::info!("mobile: paired {} ({})", device.name, device.id);
    let cookie = device_cookie(&token, is_https(&headers));
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "device": { "id": device.id, "name": device.name } })),
    )
        .into_response())
}

async fn unpair(
    State(ctx): State<Ctx>,
    device: Device,
    _client: Client,
    headers: HeaderMap,
) -> Response {
    log::info!("mobile: {} ({}) unpaired itself", device.name, device.id);
    ctx.shared.revoke(&device.id);
    (
        [(header::SET_COOKIE, cleared_cookie(is_https(&headers)))],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async fn state(State(ctx): State<Ctx>, device: Device) -> Result<Json<Value>, ApiError> {
    with_state(&ctx, move |app, state| {
        let (epoch, seq) = sync::position(app);
        Ok(Json(json!({
            "epoch": epoch,
            "seq": seq,
            "machineName": crate::state::machine_name(),
            "device": { "id": device.id, "name": device.name },
            "sessions": dto::session_rows(state),
            "projects": dto::project_rows(state),
            "defaultAgent": state.settings.default_agent,
            "wallpaper": state.settings.wallpaper.as_deref().and_then(wallpaper_version),
        })))
    })
    .await
}

#[derive(Deserialize)]
struct WindowQuery {
    limit: Option<usize>,
    before: Option<usize>,
}

async fn transcript(
    State(ctx): State<Ctx>,
    _device: Device,
    Path(id): Path<u64>,
    Query(query): Query<WindowQuery>,
) -> Result<Json<dto::TranscriptWindowDto>, ApiError> {
    let limit = query.limit.unwrap_or(60).clamp(1, 200);
    with_state(&ctx, move |app, state| {
        let session = state
            .sessions
            .get(&id)
            .ok_or_else(ApiError::unknown_session)?;
        let (epoch, seq) = sync::position(app);
        Ok(Json(dto::transcript_window(
            session,
            limit,
            query.before,
            epoch,
            seq,
        )))
    })
    .await
}

/// The chat agents, and whether this Mac has each one installed and signed
/// in. A filesystem probe that can fall through to a login shell the first
/// time, so off the async threads.
async fn agents(_device: Device) -> Result<Json<Value>, ApiError> {
    let statuses = tauri::async_runtime::spawn_blocking(egant_harness::detect_agents)
        .await
        .map_err(|_| ApiError::internal())?;
    Ok(Json(Value::Array(
        statuses
            .into_iter()
            .filter(|status| CHAT_AGENTS.contains(&status.id))
            .map(|status| {
                json!({
                    "id": status.id.as_str(),
                    "name": status.name,
                    "installed": status.installed,
                    "connected": status.connected,
                })
            })
            .collect(),
    )))
}

/// One agent's models — the desktop picker's own catalog, cached the same
/// way (see `egant_harness::models::list_models`).
async fn models(
    _device: Device,
    Path(agent): Path<String>,
) -> Result<Json<Vec<AgentModel>>, ApiError> {
    let id = chat_agent(&agent)?;
    tauri::async_runtime::spawn_blocking(move || egant_harness::models::list_models(id))
        .await
        .map_err(|_| ApiError::internal())?
        .map(Json)
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error))
}

#[derive(Deserialize)]
struct WallpaperQuery {
    v: Option<String>,
}

/// The wallpaper the user picked for egant on the Mac — the one file on
/// disk the phone may read, and only because the desktop already shows it.
/// Addressed by version (`?v=`, from `/state`), so a phone keeps its copy
/// until the picture changes.
async fn wallpaper(
    State(ctx): State<Ctx>,
    _device: Device,
    Query(query): Query<WallpaperQuery>,
) -> Result<Response, ApiError> {
    let no_wallpaper = || ApiError::new(StatusCode::NOT_FOUND, "no wallpaper");
    let path = with_state(&ctx, |_, state| Ok(state.settings.wallpaper.clone()))
        .await?
        .ok_or_else(no_wallpaper)?;
    let version = wallpaper_version(&path).ok_or_else(no_wallpaper)?;
    let bytes = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || -> Result<Vec<u8>, ApiError> {
            let size = std::fs::metadata(&path).map_err(|_| no_wallpaper())?.len();
            if size > MAX_WALLPAPER_BYTES {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "The wallpaper on your Mac is too large to send to a phone.",
                ));
            }
            std::fs::read(&path).map_err(|_| no_wallpaper())
        }
    })
    .await
    .map_err(|_| ApiError::internal())??;

    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(crate::commands::mime_for(&path)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if query.v.as_deref() == Some(version.as_str()) {
            "private, max-age=31536000, immutable"
        } else {
            "private, no-cache"
        }),
    );
    Ok(response)
}

/// Names one state of the wallpaper file — its path, size and modification
/// time — so the phone's cached copy is replaced exactly when it changes.
/// `None` when there is no such file any more.
fn wallpaper_version(path: &std::path::Path) -> Option<String> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let meta = std::fs::metadata(path).ok().filter(|meta| meta.is_file())?;
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    meta.modified().ok().hash(&mut hasher);
    Some(format!("{:016x}", hasher.finish()))
}

#[derive(Deserialize)]
struct EventsQuery {
    since: Option<u64>,
    epoch: Option<String>,
}

/// The live stream. Replays what the phone missed since `since` (when this
/// run still has it), then follows along; a `resync` frame tells the phone to
/// refetch instead when it has been away too long.
async fn events(
    State(ctx): State<Ctx>,
    device: Device,
    Query(query): Query<EventsQuery>,
) -> Result<Response, ApiError> {
    let hub = ctx
        .app
        .try_state::<SyncHub>()
        .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "starting up"))?;
    let subscription = hub.subscribe(query.since, query.epoch.as_deref());
    // After a resync the phone's old position means nothing (it may even be
    // from a previous run, numbered higher than anything this one has sent).
    let last = if subscription.resync {
        0
    } else {
        query.since.unwrap_or(0)
    };
    let stream = event_stream(StreamState {
        replay: subscription.replay.into_iter(),
        resync: subscription.resync,
        rx: subscription.rx,
        last,
        connection: ctx.shared.connect(&device.id),
        shared: ctx.shared.clone(),
        device: device.id,
    });
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    // Proxies that buffer would hold a whole turn back; ask them not to.
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

struct StreamState {
    replay: std::vec::IntoIter<Arc<Envelope>>,
    resync: bool,
    rx: broadcast::Receiver<Arc<Envelope>>,
    last: u64,
    device: String,
    shared: Arc<MobileShared>,
    /// Counts this stream as the device being connected, for the panel.
    #[allow(dead_code)]
    connection: super::Connection,
}

fn event_stream(state: StreamState) -> impl Stream<Item = Result<Event, Infallible>> {
    stream::unfold(state, |mut st| async move {
        if st.resync {
            st.resync = false;
            return Some((Ok(resync_event()), st));
        }
        if let Some(envelope) = st.replay.next() {
            st.last = envelope.seq;
            return Some((Ok(frame(&envelope)), st));
        }
        loop {
            match tokio::time::timeout(Duration::from_secs(30), st.rx.recv()).await {
                // Quiet for a while: a revoked device's stream still ends
                // even if the revocation signal was missed.
                Err(_) => {
                    if !st.shared.device_exists(&st.device) {
                        return None;
                    }
                }
                Ok(Ok(envelope)) => {
                    if let Some(revoked) = &envelope.revoked_device {
                        if *revoked == st.device || revoked == "*" {
                            return None;
                        }
                        continue;
                    }
                    if envelope.seq <= st.last {
                        continue;
                    }
                    st.last = envelope.seq;
                    return Some((Ok(frame(&envelope)), st));
                }
                // Fell further behind than the channel holds: the phone
                // refetches rather than folding a stream with a hole in it.
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    return Some((Ok(resync_event()), st));
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => return None,
            }
        }
    })
}

fn frame(envelope: &Envelope) -> Event {
    Event::default()
        .id(envelope.seq.to_string())
        .data(envelope.json.as_ref())
}

fn resync_event() -> Event {
    Event::default().data(json!({ "type": "resync" }).to_string())
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SendBody {
    text: String,
}

async fn send_message(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Path(id): Path<u64>,
    Json(body): Json<SendBody>,
) -> Result<Json<Value>, ApiError> {
    let text = body.text;
    check_message(&text)?;
    log::info!(
        "mobile: {} sent a message to session {id} ({} chars)",
        device.name,
        text.len()
    );
    with_state(&ctx, move |app, state| {
        let title = service::send_message(app, state, id, text, Vec::new(), &client.origin())
            .map_err(ApiError::from_service)?;
        Ok(Json(json!({ "title": title })))
    })
    .await
}

async fn interrupt(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Path(id): Path<u64>,
) -> Result<Json<Value>, ApiError> {
    log::info!("mobile: {} stopped session {id}", device.name);
    with_state(&ctx, move |app, state| {
        service::interrupt(app, state, id, &client.origin()).map_err(ApiError::from_service)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionBody {
    project_id: usize,
    agent: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    variant: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    text: String,
}

/// A new chat: a session in one of the projects the Mac already has open,
/// with the phone's first message sent into it. The checkout follows the
/// Mac's own default for new sessions (a fresh worktree or the project
/// folder), cut off the state lock the way the window's own start is.
async fn create_session(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Json(body): Json<NewSessionBody>,
) -> Result<Json<Value>, ApiError> {
    let agent = chat_agent(&body.agent)?;
    let model = cli_value(body.model, "model")?;
    let variant = cli_value(body.variant, "effort")?;
    let mode = match body.mode.as_deref().filter(|name| !name.is_empty()) {
        None => PermissionMode::Auto,
        Some(name) => PermissionMode::from_cli_arg(name)
            .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "unknown permission mode"))?,
    };
    let text = body.text;
    check_message(&text)?;
    let project_id = body.project_id;

    let (new_worktree, project_path) = with_state(&ctx, move |_, state| {
        let project = state.project(project_id).ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "That project isn't open on your Mac any more.",
            )
        })?;
        Ok((state.settings.worktree_default, project.fs_path()))
    })
    .await?;
    let worktree = if new_worktree {
        tauri::async_runtime::spawn_blocking(move || {
            worktrees::prepare(&CheckoutPlan::NewWorktree { base: None }, &project_path)
        })
        .await
        .map_err(|_| ApiError::internal())?
        .map_err(|error| ApiError::new(StatusCode::CONFLICT, error))?
    } else {
        None
    };

    log::info!(
        "mobile: {} started a {} chat in project {project_id}",
        device.name,
        agent.as_str()
    );
    let origin = client.origin();
    with_state(&ctx, move |app, state| {
        let id = service::start_session(
            app, state, project_id, agent, model, variant, mode, worktree, &origin,
        )
        .map_err(ApiError::from_service)?;
        // The session exists from here on: a first message that could not go
        // out is the phone's to try again in it, not a failed start.
        let (title, error) = match service::send_message(app, state, id, text, Vec::new(), &origin)
        {
            Ok(title) => (title, None),
            Err(error) => (None, Some(error)),
        };
        Ok(Json(json!({
            "id": id,
            "title": title,
            "error": error,
            "session": dto::session_row(state, id),
        })))
    })
    .await
}

#[derive(Deserialize)]
struct ModelBody {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    variant: Option<String>,
}

/// Moves a session onto another model or effort between turns — the
/// desktop's restart-with-resume.
async fn set_model(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Path(id): Path<u64>,
    Json(body): Json<ModelBody>,
) -> Result<Json<Value>, ApiError> {
    let model = cli_value(body.model, "model")?;
    let variant = cli_value(body.variant, "effort")?;
    log::info!(
        "mobile: {} switched session {id} to model {model:?}, effort {variant:?}",
        device.name
    );
    with_state(&ctx, move |app, state| {
        service::set_model(app, state, id, model, variant, &client.origin())
            .map_err(ApiError::from_service)?;
        Ok(Json(json!({ "session": dto::session_row(state, id) })))
    })
    .await
}

#[derive(Deserialize)]
struct ModeBody {
    mode: String,
}

async fn set_mode(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Path(id): Path<u64>,
    Json(body): Json<ModeBody>,
) -> Result<Json<Value>, ApiError> {
    let mode = PermissionMode::from_cli_arg(&body.mode)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "unknown permission mode"))?;
    log::info!(
        "mobile: {} set session {id} to {}",
        device.name,
        mode.as_cli_arg()
    );
    with_state(&ctx, move |app, state| {
        let applied = service::set_permission_mode(app, state, id, mode, &client.origin())
            .map_err(ApiError::from_service)?;
        Ok(Json(json!({ "permissionMode": applied })))
    })
    .await
}

/// One of the agents a phone can chat with.
fn chat_agent(name: &str) -> Result<AgentId, ApiError> {
    AgentId::from_str(name)
        .filter(|id| CHAT_AGENTS.contains(id))
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "unknown agent"))
}

/// A model or effort name, which reaches the agent's CLI as an argument of
/// its own: the characters real catalog ids use, and never something that
/// reads as a flag. Blank means the CLI's own default.
fn cli_value(value: Option<String>, what: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let valid = value.len() <= 200
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:[]@+".contains(c));
    if valid {
        Ok(Some(value))
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("bad {what}"),
        ))
    }
}

fn check_message(text: &str) -> Result<(), ApiError> {
    if text.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Nothing to send."));
    }
    if text.len() > MAX_MESSAGE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "That message is too long to send from a phone.",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct PermissionBody {
    decision: String,
}

async fn answer_permission(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Path((id, request_id)): Path<(u64, String)>,
    Json(body): Json<PermissionBody>,
) -> Result<Json<Value>, ApiError> {
    let answer = PermissionAnswer::from_str_name(&body.decision).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "decision must be allow, allow-always or deny",
        )
    })?;
    log::info!(
        "mobile: {} answered permission {request_id} in session {id}: {answer:?}",
        device.name
    );
    with_state(&ctx, move |app, state| {
        let mode =
            service::answer_permission(app, state, id, &request_id, answer, &client.origin())
                .map_err(ApiError::from_service)?;
        Ok(Json(json!({ "permissionMode": mode })))
    })
    .await
}

#[derive(Deserialize)]
struct DecisionBody {
    response: Value,
    /// The reply the agent reads — the same text the desktop sends for the
    /// same answer (`formatDecisionReply`).
    text: String,
}

async fn answer_decision(
    State(ctx): State<Ctx>,
    device: Device,
    client: Client,
    Path((id, decision_id)): Path<(u64, String)>,
    Json(body): Json<DecisionBody>,
) -> Result<Json<Value>, ApiError> {
    if decision_id.is_empty() || decision_id.len() > 200 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad decision id"));
    }
    if !service::is_decision_response(&body.response) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "bad decision answer",
        ));
    }
    if body.text.trim().is_empty() || body.text.len() > MAX_DECISION_REPLY_BYTES {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad decision reply"));
    }
    log::info!(
        "mobile: {} answered decision {decision_id} in session {id}",
        device.name
    );
    with_state(&ctx, move |app, state| {
        match service::answer_decision(
            app,
            state,
            id,
            &decision_id,
            body.response,
            body.text,
            &client.origin(),
        ) {
            Ok(DecisionOutcome::Sent(title)) => Ok(Json(json!({ "title": title }))),
            Ok(DecisionOutcome::AlreadyAnswered) => Err(ApiError::new(
                StatusCode::CONFLICT,
                "This was already answered on another device.",
            )),
            Err(error) => Err(ApiError::from_service(error)),
        }
    })
    .await
}

async fn fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return ApiError::new(StatusCode::NOT_FOUND, "no such endpoint").into_response();
    }
    assets::serve(uri).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_are_catalog_ids_and_never_flags() {
        let ok = |value: &str| cli_value(Some(value.to_string()), "model").ok().flatten();
        assert_eq!(ok("opus").as_deref(), Some("opus"));
        assert_eq!(
            ok("claude-opus-5-5[1m]").as_deref(),
            Some("claude-opus-5-5[1m]")
        );
        assert_eq!(
            ok(" anthropic/claude-sonnet-5.5 ").as_deref(),
            Some("anthropic/claude-sonnet-5.5")
        );
        assert!(cli_value(Some("  ".into()), "model").unwrap().is_none());
        assert!(cli_value(None, "model").unwrap().is_none());
        assert!(cli_value(Some("--dangerously-skip-permissions".into()), "model").is_err());
        assert!(cli_value(Some("opus; rm -rf ~".into()), "model").is_err());
        assert!(cli_value(Some("opus\n--flag".into()), "model").is_err());
        assert!(cli_value(Some("x".repeat(201)), "model").is_err());
    }

    #[test]
    fn only_harnessed_agents_can_be_chatted_with() {
        assert!(chat_agent("claude").is_ok());
        assert!(chat_agent("codex").is_ok());
        assert!(chat_agent("opencode").is_ok());
        assert!(chat_agent("cursor").is_err());
        assert!(chat_agent("bash").is_err());
    }

    #[test]
    fn only_loopback_on_our_port_and_tailnet_names_are_served() {
        assert!(host_allowed("127.0.0.1:47247", 47247));
        assert!(host_allowed("localhost:47247", 47247));
        assert!(host_allowed("[::1]:47247", 47247));
        assert!(host_allowed(
            "diells-macbook-air.tail1234.ts.net:47247",
            47247
        ));
        assert!(host_allowed("Diells-MacBook-Air.tail1234.ts.net", 47247));
        assert!(host_allowed(
            "diells-macbook-air.tail1234.ts.net.:47247",
            47247
        ));

        // Loopback on some other port is not this server's address.
        assert!(!host_allowed("127.0.0.1:3000", 47247));
        assert!(!host_allowed("localhost", 47247));
        // A rebinding page's own domain, pointed at 127.0.0.1.
        assert!(!host_allowed("attacker.example:47247", 47247));
        assert!(!host_allowed("ts.net:47247", 47247));
        assert!(!host_allowed("evil-ts.net:47247", 47247));
        assert!(!host_allowed("", 47247));
    }

    #[test]
    fn the_token_comes_from_the_cookie_or_a_bearer_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("theme=dark; egant_device=abc123; other=1"),
        );
        assert_eq!(token_from(&headers).as_deref(), Some("abc123"));

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer xyz"),
        );
        assert_eq!(token_from(&headers).as_deref(), Some("xyz"));

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_static("egant_device="));
        assert_eq!(token_from(&headers), None);
    }

    #[test]
    fn the_cookie_is_secure_over_the_tailnet_and_scoped_tight_everywhere() {
        let cookie = device_cookie("tok", true);
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("; Secure"));
        assert!(!device_cookie("tok", false).contains("Secure"));

        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("mac.tail1234.ts.net:47247"),
        );
        assert!(is_https(&headers));
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:47247"));
        assert!(!is_https(&headers));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert!(is_https(&headers));
    }
}
