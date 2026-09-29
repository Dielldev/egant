//! egant on a phone: a paired phone drives the agents running on this Mac.
//!
//! The Mac stays the source of truth — every agent runs here, every session
//! is saved here — and the phone is a second window onto it. Three pieces:
//!
//! - [`server`], a small HTTP API inside the app, bound to 127.0.0.1 only,
//!   serving the phone app ([`assets`]) and an explicit list of operations;
//! - [`tailscale`], which puts that port behind HTTPS on this Mac's
//!   `*.ts.net` name without egant ever listening on a real network
//!   interface: `tailscale serve` for the tailnet, and Funnel for the public
//!   link, which a phone opens from any network with nothing installed;
//! - [`auth`], pairing by QR code and device tokens stored hashed — the same
//!   whichever way the phone arrives.
//!
//! Off until the user turns it on in Settings → Devices.

pub mod assets;
pub mod auth;
pub mod dto;
pub mod server;
pub mod tailscale;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use auth::{DeviceRecord, MobileConfig, PairError, Pairings};

use tailscale::TailscaleStatus;

use crate::sync::{SyncHub, now_ms};

/// How often a device's "last seen" is written back to disk. Every request
/// updates it in memory; the file only needs to be roughly right.
const LAST_SEEN_SAVE_INTERVAL_MS: u64 = 60_000;

/// How long a Tailscale probe is reused before running the CLI again.
const TAILSCALE_CACHE: Duration = Duration::from_secs(10);

/// A paired device, as a request authenticated it.
#[derive(Debug, Clone)]
pub struct Device {
    pub id: String,
    pub name: String,
}

/// The state the server's handlers share with the Devices panel.
pub struct MobileShared {
    app: OnceLock<AppHandle>,
    /// Where the config is saved; `None` keeps it in memory (tests).
    path: Option<std::path::PathBuf>,
    config: Mutex<MobileConfig>,
    pairings: Mutex<Pairings>,
    /// Open event streams per device: the panel's "Connected".
    connections: Mutex<HashMap<String, usize>>,
    /// When each device's last-seen time was last written to disk.
    seen_saved: Mutex<HashMap<String, u64>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MobileShared {
    fn new(path: Option<std::path::PathBuf>) -> Self {
        let config = auth::load(path.as_deref());
        Self {
            app: OnceLock::new(),
            path,
            config: Mutex::new(config),
            pairings: Mutex::new(Pairings::default()),
            connections: Mutex::new(HashMap::new()),
            seen_saved: Mutex::new(HashMap::new()),
        }
    }

    fn changed(&self) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("mobile-changed", ());
        }
    }

    fn port(&self) -> u16 {
        lock(&self.config).port
    }

    fn update(&self, change: impl FnOnce(&mut MobileConfig)) {
        let mut config = lock(&self.config);
        change(&mut config);
        auth::save(self.path.as_deref(), &config);
    }

    /// The device holding `token`, marking it seen.
    pub fn authenticate(&self, token: &str) -> Option<Device> {
        let now = now_ms();
        let mut config = lock(&self.config);
        let device = config.authenticate(token)?.id.clone();
        let record = config.devices.iter_mut().find(|d| d.id == device)?;
        record.last_seen_ms = now;
        let found = Device {
            id: record.id.clone(),
            name: record.name.clone(),
        };
        let mut saved = lock(&self.seen_saved);
        let last = saved.get(&found.id).copied().unwrap_or(0);
        if now.saturating_sub(last) >= LAST_SEEN_SAVE_INTERVAL_MS {
            saved.insert(found.id.clone(), now);
            auth::save(self.path.as_deref(), &config);
        }
        Some(found)
    }

    pub fn is_known(&self, token: &str) -> bool {
        lock(&self.config).authenticate(token).is_some()
    }

    pub fn device_exists(&self, id: &str) -> bool {
        lock(&self.config).devices.iter().any(|d| d.id == id)
    }

    /// Redeems a pairing code and adds the device it pairs.
    pub fn pair(
        &self,
        code: &str,
        name: Option<&str>,
        user_agent: &str,
    ) -> Result<(DeviceRecord, String), PairError> {
        let now = now_ms();
        lock(&self.pairings).redeem(code, now)?;
        let (device, token) = {
            let mut config = lock(&self.config);
            let paired = config.add_device(auth::device_name(name, user_agent), now);
            auth::save(self.path.as_deref(), &config);
            paired
        };
        self.changed();
        Ok((device, token))
    }

    /// Forgets a device and ends its open streams at once.
    pub fn revoke(&self, id: &str) -> bool {
        let removed = {
            let mut config = lock(&self.config);
            let removed = config.remove_device(id);
            if removed {
                auth::save(self.path.as_deref(), &config);
            }
            removed
        };
        if removed {
            if let Some(hub) = self.app.get().and_then(|app| app.try_state::<SyncHub>()) {
                hub.revoke_device(id);
            }
            self.changed();
        }
        removed
    }

    fn connect(self: &Arc<Self>, device: &str) -> Connection {
        *lock(&self.connections)
            .entry(device.to_string())
            .or_default() += 1;
        self.changed();
        Connection {
            shared: self.clone(),
            device: device.to_string(),
        }
    }
}

/// One open event stream, counted while it lives.
pub struct Connection {
    shared: Arc<MobileShared>,
    device: String,
}

impl Drop for Connection {
    fn drop(&mut self) {
        {
            let mut connections = lock(&self.shared.connections);
            if let Some(count) = connections.get_mut(&self.device) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    connections.remove(&self.device);
                }
            }
        }
        self.shared.changed();
    }
}

struct RunningServer {
    port: u16,
    stop: oneshot::Sender<()>,
}

/// Managed Tauri state: phone access as a whole.
pub struct MobileService {
    shared: Arc<MobileShared>,
    server: Mutex<Option<RunningServer>>,
    /// Why the server could not start, or why `tailscale serve` refused.
    error: Mutex<Option<String>>,
    /// Why the public link could not open (or close).
    public_error: Mutex<Option<String>>,
    /// When egant opened the public link in this run: a new public name can
    /// take a few minutes to reach phones.
    public_opened: Mutex<Option<u64>>,
    tailscale: Mutex<Option<(Instant, TailscaleStatus)>>,
}

impl MobileService {
    pub fn load() -> Self {
        let shared = MobileShared::new(auth::config_path());
        // A debug build can be handed a pairing code up front, which is how
        // the end-to-end test pairs a browser without clicking the desktop
        // UI. Release builds never read it.
        #[cfg(debug_assertions)]
        if let Some(code) = std::env::var("EGANT_MOBILE_TEST_PAIRING")
            .ok()
            .and_then(|code| auth::normalize_code(&code))
        {
            log::warn!("mobile: accepting a test pairing code from EGANT_MOBILE_TEST_PAIRING");
            lock(&shared.pairings).insert(code, now_ms() + 60 * 60 * 1000);
        }
        Self {
            shared: Arc::new(shared),
            server: Mutex::new(None),
            error: Mutex::new(None),
            public_error: Mutex::new(None),
            public_opened: Mutex::new(None),
            tailscale: Mutex::new(None),
        }
    }
}

/// Wires the service to the app and brings the server back up if it was on.
pub fn init(app: &AppHandle) {
    let service = app.state::<MobileService>();
    let _ = service.shared.app.set(app.clone());
    if lock(&service.shared.config).enabled {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = start(&app).await {
                log::error!("mobile: {error}");
            }
        });
    }
}

async fn start(app: &AppHandle) -> Result<(), String> {
    let service = app.state::<MobileService>();
    if lock(&service.server).is_some() {
        return Ok(());
    }
    let port = service.shared.port();
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            let message = format!("couldn't listen on 127.0.0.1:{port}: {error}");
            *lock(&service.error) = Some(message.clone());
            return Err(message);
        }
    };
    let router = server::router(server::Ctx {
        app: app.clone(),
        shared: service.shared.clone(),
        port,
    });
    let (stop, stopped) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let served = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = stopped.await;
        });
        if let Err(error) = served.await {
            log::error!("mobile: server stopped: {error}");
        }
    });
    *lock(&service.server) = Some(RunningServer { port, stop });
    *lock(&service.error) = None;
    log::info!("mobile: listening on 127.0.0.1:{port}");
    Ok(())
}

fn stop(app: &AppHandle) {
    let service = app.state::<MobileService>();
    let Some(server) = lock(&service.server).take() else {
        return;
    };
    // An open event stream never finishes by itself, and graceful shutdown
    // waits for every connection: end them first.
    if let Some(hub) = app.try_state::<SyncHub>() {
        hub.revoke_device("*");
    }
    let _ = server.stop.send(());
    log::info!("mobile: stopped listening on 127.0.0.1:{}", server.port);
}

async fn tailscale_status(app: &AppHandle, fresh: bool) -> TailscaleStatus {
    let service = app.state::<MobileService>();
    if !fresh {
        if let Some((at, status)) = lock(&service.tailscale).as_ref() {
            if at.elapsed() < TAILSCALE_CACHE {
                return status.clone();
            }
        }
    }
    let port = service.shared.port();
    let status = tauri::async_runtime::spawn_blocking(move || tailscale::probe(port, port))
        .await
        .unwrap_or_default();
    *lock(&service.tailscale) = Some((Instant::now(), status.clone()));
    status
}

/// Points `tailscale serve` at the server, when Tailscale is up and the
/// tailnet issues certificates. Failure is recorded for the panel, not
/// returned: the server itself is fine either way.
async fn setup_serve(app: &AppHandle) {
    let status = tailscale_status(app, true).await;
    let service = app.state::<MobileService>();
    if !status.running || !status.https_enabled || status.serving {
        return;
    }
    let port = service.shared.port();
    let outcome = tauri::async_runtime::spawn_blocking(move || tailscale::enable_serve(port, port))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    match outcome {
        Ok(()) => {
            log::info!("mobile: tailscale serve now proxies https port {port} to egant");
            service
                .shared
                .update(|config| config.serve_configured = true);
            *lock(&service.error) = None;
        }
        Err(error) => {
            log::warn!("mobile: tailscale serve failed: {error}");
            *lock(&service.error) = Some(error);
        }
    }
    *lock(&service.tailscale) = None;
}

/// Opens the public link: Tailscale Funnel in front of the same server, on
/// this Mac's `*.ts.net` name. Like [`setup_serve`], a refusal is recorded
/// for the panel rather than returned.
async fn setup_funnel(app: &AppHandle) {
    let status = tailscale_status(app, true).await;
    let service = app.state::<MobileService>();
    let refusal = if !status.installed {
        Some("Install Tailscale on this Mac first. Your phone doesn't need it.")
    } else if !status.running {
        Some("Tailscale isn't connected on this Mac.")
    } else if !status.https_enabled {
        Some("Turn on HTTPS certificates for your tailnet first.")
    } else {
        None
    };
    if let Some(refusal) = refusal {
        *lock(&service.public_error) = Some(refusal.to_string());
        return;
    }
    if status.funnel_port.is_some() {
        *lock(&service.public_error) = None;
        return;
    }
    let port = service.shared.port();
    let outcome = tauri::async_runtime::spawn_blocking(move || tailscale::enable_funnel(port))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    match outcome {
        Ok(funnel) => {
            log::info!(
                "mobile: Funnel opens https port {funnel} to egant — the public link is live"
            );
            *lock(&service.public_opened) = Some(now_ms());
            *lock(&service.public_error) = None;
        }
        Err(error) => {
            log::warn!("mobile: Funnel failed: {error}");
            *lock(&service.public_error) = Some(error);
        }
    }
    *lock(&service.tailscale) = None;
}

/// Closes the public link: the Funnel entry pointing at egant — whoever
/// opened it — and nothing else.
async fn remove_funnel(app: &AppHandle) {
    let service = app.state::<MobileService>();
    *lock(&service.public_error) = None;
    *lock(&service.public_opened) = None;
    let Some(port) = tailscale_status(app, true).await.funnel_port else {
        return;
    };
    let outcome = tauri::async_runtime::spawn_blocking(move || tailscale::disable_funnel(port))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    match outcome {
        Ok(()) => log::info!("mobile: closed the public link (Funnel on port {port})"),
        Err(error) => {
            log::warn!("mobile: couldn't close Funnel on port {port}: {error}");
            *lock(&service.public_error) = Some(format!("Couldn't close the public link: {error}"));
        }
    }
    *lock(&service.tailscale) = None;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto {
    pub id: String,
    pub name: String,
    pub created_ms: u64,
    pub last_seen_ms: u64,
    pub connected: bool,
}

/// The public link, as the Devices panel shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicLinkDto {
    /// Wanted: it comes back whenever phone access does.
    pub on: bool,
    /// Funnel is sending the internet to egant right now.
    pub live: bool,
    /// `https://<mac>.<tailnet>.ts.net`, while live.
    pub url: Option<String>,
    /// Why it couldn't open, with the Tailscale page that fixes it when the
    /// CLI named one.
    pub error: Option<String>,
    /// What to run by hand when egant can't open it itself.
    pub command: String,
    /// When egant opened it in this run.
    pub opened_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileStatusDto {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub error: Option<String>,
    pub tailscale: TailscaleStatus,
    /// Where a pairing QR code sends a phone: the public link, while it is
    /// live. Never the tailnet address — a phone without Tailscale can't even
    /// look that name up.
    pub url: Option<String>,
    /// This Mac's tailnet-only address, once `tailscale serve` is up.
    pub tailnet_url: Option<String>,
    pub public: PublicLinkDto,
    /// The same app on this Mac, for trying it in a desktop browser.
    pub local_url: String,
    /// What to run by hand when egant can't set `serve` up itself.
    pub serve_command: String,
    pub devices: Vec<DeviceDto>,
}

/// The public link while Funnel is live: `https://<name>` on 443, with the
/// port on 8443 or 10000.
fn funnel_url(tailscale: &TailscaleStatus) -> Option<String> {
    let port = tailscale.funnel_port?;
    let name = tailscale.dns_name.as_deref()?;
    Some(match port {
        443 => format!("https://{name}"),
        port => format!("https://{name}:{port}"),
    })
}

/// This Mac's tailnet-only address, once `tailscale serve` points at the
/// server.
fn tailnet_url(service: &MobileService, tailscale: &TailscaleStatus) -> Option<String> {
    let config = lock(&service.shared.config);
    let reachable = tailscale.running
        && tailscale.https_enabled
        && (tailscale.serving || config.serve_configured);
    let name = tailscale.dns_name.as_deref().filter(|_| reachable)?;
    Some(format!("https://{name}:{}", config.port))
}

async fn status(app: &AppHandle, fresh: bool) -> MobileStatusDto {
    let tailscale = tailscale_status(app, fresh).await;
    let service = app.state::<MobileService>();
    let public_url = funnel_url(&tailscale);
    let tailnet = tailnet_url(&service, &tailscale);
    let url = public_url.clone();
    let running = lock(&service.server).is_some();
    let connections = lock(&service.shared.connections).clone();
    let config = lock(&service.shared.config).clone();
    let mut devices: Vec<DeviceDto> = config
        .devices
        .iter()
        .map(|device| DeviceDto {
            id: device.id.clone(),
            name: device.name.clone(),
            created_ms: device.created_ms,
            last_seen_ms: device.last_seen_ms,
            connected: connections.contains_key(&device.id),
        })
        .collect();
    devices.sort_by_key(|device| std::cmp::Reverse(device.last_seen_ms));
    MobileStatusDto {
        enabled: config.enabled,
        running,
        port: config.port,
        error: lock(&service.error).clone(),
        tailscale,
        url,
        tailnet_url: tailnet,
        public: PublicLinkDto {
            on: config.public,
            live: public_url.is_some(),
            url: public_url,
            error: lock(&service.public_error).clone(),
            command: tailscale::funnel_command(config.port),
            opened_ms: *lock(&service.public_opened),
        },
        local_url: format!("http://127.0.0.1:{}", config.port),
        serve_command: tailscale::serve_command(config.port, config.port),
        devices,
    }
}

/// Phone access, as the Devices panel shows it. `refresh` re-asks Tailscale
/// instead of reusing the last few seconds' answer.
#[tauri::command]
pub async fn mobile_status(app: AppHandle, refresh: Option<bool>) -> MobileStatusDto {
    status(&app, refresh.unwrap_or(false)).await
}

/// Turns phone access on — the server, then `tailscale serve` in front of it,
/// and Funnel too when the public link is wanted — or off, taking down the
/// public link and only a `serve` entry egant made itself.
#[tauri::command]
pub async fn mobile_set_enabled(app: AppHandle, enabled: bool) -> MobileStatusDto {
    log::info!(
        "mobile: phone access {}",
        if enabled { "on" } else { "off" }
    );
    let service = app.state::<MobileService>();
    service.shared.update(|config| config.enabled = enabled);
    if enabled {
        if start(&app).await.is_ok() {
            setup_serve(&app).await;
            if lock(&service.shared.config).public {
                setup_funnel(&app).await;
            }
        }
    } else {
        stop(&app);
        *lock(&service.error) = None;
        remove_funnel(&app).await;
        let (configured, port) = {
            let config = lock(&service.shared.config);
            (config.serve_configured, config.port)
        };
        if configured {
            match tauri::async_runtime::spawn_blocking(move || tailscale::disable_serve(port)).await
            {
                Ok(Ok(())) => service
                    .shared
                    .update(|config| config.serve_configured = false),
                Ok(Err(error)) => log::warn!("mobile: couldn't remove tailscale serve: {error}"),
                Err(error) => log::warn!("mobile: couldn't remove tailscale serve: {error}"),
            }
        }
    }
    service.shared.changed();
    status(&app, true).await
}

/// "Recheck" beside Tailscale in the panel: tries `tailscale serve` again —
/// and Funnel, when the public link is wanted — after the user has installed
/// Tailscale, signed in, or turned on HTTPS or Funnel.
#[tauri::command]
pub async fn mobile_setup_tailscale(app: AppHandle) -> MobileStatusDto {
    let service = app.state::<MobileService>();
    let (enabled, public) = {
        let config = lock(&service.shared.config);
        (config.enabled, config.public)
    };
    if enabled && start(&app).await.is_ok() {
        setup_serve(&app).await;
        if public {
            setup_funnel(&app).await;
        }
    }
    status(&app, true).await
}

/// Opens or closes the public link: Tailscale Funnel in front of the same
/// server, so a phone reaches egant from any network with nothing installed.
/// Opening it turns phone access on first; pairing is unchanged either way.
#[tauri::command]
pub async fn mobile_set_public(app: AppHandle, on: bool) -> MobileStatusDto {
    log::info!("mobile: public link {}", if on { "on" } else { "off" });
    let service = app.state::<MobileService>();
    service.shared.update(|config| {
        config.public = on;
        config.enabled |= on;
    });
    if on {
        if start(&app).await.is_ok() {
            setup_serve(&app).await;
            setup_funnel(&app).await;
        }
    } else {
        remove_funnel(&app).await;
    }
    service.shared.changed();
    status(&app, true).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingDto {
    /// `ABCDE-FGHJK`, for typing into a phone that can't scan.
    pub code: String,
    /// The link the QR code carries: the public link, while it is live.
    pub url: Option<String>,
    /// `url` is the public link — a phone needs nothing installed.
    pub public: bool,
    pub local_url: String,
    /// The QR code for `url`, as SVG.
    pub qr_svg: Option<String>,
    pub expires_at_ms: u64,
}

/// A fresh pairing code, and the QR code a phone scans to redeem it.
#[tauri::command]
pub async fn mobile_create_pairing(app: AppHandle) -> Result<PairingDto, String> {
    let service = app.state::<MobileService>();
    if lock(&service.server).is_none() {
        return Err("Turn on phone access first.".to_string());
    }
    let (code, expires_at_ms) = lock(&service.shared.pairings).issue(now_ms());
    let tailscale = tailscale_status(&app, false).await;
    // Only ever the public link: the tailnet name doesn't resolve on a phone
    // without Tailscale, which is the phone this is for.
    let public = funnel_url(&tailscale);
    let url = public.as_ref().map(|base| format!("{base}/#pair={code}"));
    let qr_svg = url.as_deref().and_then(qr_svg);
    log::info!("mobile: new pairing code (valid 5 minutes)");
    Ok(PairingDto {
        code: auth::format_code(&code),
        url,
        public: public.is_some(),
        local_url: format!("http://127.0.0.1:{}/#pair={code}", service.shared.port()),
        qr_svg,
        expires_at_ms,
    })
}

/// Revokes a paired device: its token stops working and its streams close.
#[tauri::command]
pub async fn mobile_revoke_device(app: AppHandle, id: String) -> MobileStatusDto {
    log::info!("mobile: revoking device {id}");
    app.state::<MobileService>().shared.revoke(&id);
    status(&app, false).await
}

fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(232, 232)
            .dark_color(svg::Color("#0d0d0d"))
            .light_color(svg::Color("#ffffff"))
            .quiet_zone(true)
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_qr_code_renders_as_svg() {
        let svg = qr_svg("https://mac.tail1234.ts.net:47247/#pair=ABCDEFGHJK").unwrap();
        assert!(svg.contains("<svg"), "{svg}");
        assert!(svg.contains("#0d0d0d"));
    }

    #[test]
    fn the_public_link_leaves_out_the_default_https_port() {
        let mut tailscale = TailscaleStatus {
            dns_name: Some("mac.tail1234.ts.net".into()),
            funnel_port: Some(443),
            ..TailscaleStatus::default()
        };
        assert_eq!(
            funnel_url(&tailscale).as_deref(),
            Some("https://mac.tail1234.ts.net")
        );
        tailscale.funnel_port = Some(8443);
        assert_eq!(
            funnel_url(&tailscale).as_deref(),
            Some("https://mac.tail1234.ts.net:8443")
        );
        tailscale.funnel_port = None;
        assert_eq!(funnel_url(&tailscale), None);
    }

    #[test]
    fn a_paired_device_is_authenticated_and_revocation_locks_it_out() {
        // No path: the config stays in memory, never on the real disk.
        let shared = MobileShared::new(None);
        let code = lock(&shared.pairings).issue(now_ms()).0;
        let (device, token) = shared.pair(&code, Some("Test phone"), "").unwrap();
        assert_eq!(
            shared.authenticate(&token).map(|d| d.id),
            Some(device.id.clone())
        );
        assert!(shared.is_known(&token));
        assert!(shared.pair(&code, None, "").is_err(), "a code works once");
        assert!(shared.revoke(&device.id));
        assert!(shared.authenticate(&token).is_none());
        assert!(!shared.device_exists(&device.id));
    }

    #[test]
    fn a_config_round_trips_through_its_file_with_owner_only_permissions() {
        let dir = std::env::temp_dir().join(format!("egant-mobile-cfg-{}", std::process::id()));
        let path = dir.join("mobile.json");
        let mut config = MobileConfig {
            enabled: true,
            ..MobileConfig::default()
        };
        config.add_device("iPhone".into(), 5);
        auth::save(Some(&path), &config);
        assert_eq!(auth::load(Some(&path)), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
