//! The workspace panel's Browser tab: a real webview per tab, layered over
//! the main window and positioned to match a placeholder `<div>` the
//! frontend measures and keeps in sync (see `BrowserPane.tsx`).
//!
//! Deliberately outside this app's own reach: `capabilities/default.json`
//! grants permissions to the webview labeled `main` specifically (its
//! `webviews` field, not `windows` — for a multiwebview window the two are
//! not equivalent, see that file), so a page loaded into one of these tabs
//! has no IPC access to any Tauri command no matter what script it runs.
//! That is the whole point of a browser tab: it loads pages this app does
//! not control.
//!
//! A tab's webview is created once and outlives the panel closing or another
//! tab taking focus — those only hide it (`browser_set_visible`), so a
//! page's scroll position and form state survive. Only closing the tab itself
//! (`browser_close`) tears it down.

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl,
};

/// What changed about a browser tab's page. The address bar and the tab
/// strip's title are both driven off this rather than polled.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNav {
    label: String,
    url: String,
    loading: bool,
}

fn emit_nav(app: &AppHandle, label: &str, url: &Url, loading: bool) {
    let _ = app.emit(
        "browser-nav",
        BrowserNav {
            label: label.to_string(),
            url: url.to_string(),
            loading,
        },
    );
}

/// Turns whatever landed in the address bar into something a webview can
/// load: a real URL as typed, a bare host name (`github.com`, `localhost:3000`)
/// with `https://` filled in, and anything else — a search — handed to
/// Google. `Url`'s own query encoder does the escaping, so nothing here has
/// to.
fn resolve_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("nothing to open".to_string());
    }
    if let Ok(url) = Url::parse(trimmed) {
        if url.scheme() == "http" || url.scheme() == "https" {
            return Ok(url);
        }
    }
    let looks_like_address =
        !trimmed.contains(' ') && (trimmed.contains('.') || trimmed.starts_with("localhost"));
    if looks_like_address {
        if let Ok(url) = Url::parse(&format!("https://{trimmed}")) {
            return Ok(url);
        }
    }
    let mut url = Url::parse("https://www.google.com/search").expect("static URL");
    url.query_pairs_mut().append_pair("q", trimmed);
    Ok(url)
}

/// Opens a browser tab's webview and returns the address it resolved to.
///
/// Idempotent by label: called again for a tab whose webview is already
/// alive — the panel was closed and reopened, say — this only moves it to
/// `x, y, width, height` and shows it again, on purpose never renavigating,
/// so reopening the panel doesn't reload the page out from under whatever the
/// user was doing on it. The webview's own current URL is returned in that
/// case rather than `url`, in case it had navigated on since the frontend
/// last heard about it.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let target = resolve_url(&url)?;

    if let Some(existing) = app.get_webview(&label) {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        existing.show().map_err(|error| error.to_string())?;
        return Ok(existing
            .url()
            .map(|url| url.to_string())
            .unwrap_or_else(|_| target.to_string()));
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;

    log::info!("browser_open {label} -> {target}");
    let load_label = label.clone();
    let load_app = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target.clone()))
        .on_navigation(|url| {
            log::debug!("browser_navigation -> {url}");
            true
        })
        .on_page_load(move |_webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_nav(&load_app, &load_label, payload.url(), loading);
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|error| error.to_string())?;
    Ok(target.to_string())
}

/// The address bar's Enter / Go — navigates a tab's existing webview.
#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<String, String> {
    let target = resolve_url(&url)?;
    let Some(webview) = app.get_webview(&label) else {
        return Err("that browser tab isn't open".to_string());
    };
    webview
        .navigate(target.clone())
        .map_err(|error| error.to_string())?;
    Ok(target.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, label: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    webview.reload().map_err(|error| error.to_string())
}

/// Back/forward run through the page's own history via `eval` rather than a
/// dedicated runtime call — there isn't one — which is exactly what a
/// toolbar's Back button does in a real browser.
#[tauri::command]
pub fn browser_go_back(app: AppHandle, label: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    webview
        .eval("history.back()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_go_forward(app: AppHandle, label: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    webview
        .eval("history.forward()")
        .map_err(|error| error.to_string())
}

/// Keeps a tab's webview lined up with its placeholder `<div>` — called on
/// every layout change the frontend observes (a resize, the panel's own
/// drag-to-resize, maximizing). Silently a no-op for a label with no webview
/// rather than an error: the frontend's resize observer can fire once more
/// after a tab already closed.
#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

/// Shows or hides a tab's webview without destroying it — how switching away
/// from a Browser tab keeps the page alive underneath during the frontend's
/// short grace period before it gives up and suspends it for real
/// (`browser_close`).
///
/// Hiding also pauses any playing media: `hide()` alone stops the view from
/// drawing, but a page mid-video keeps decoding and streaming it regardless,
/// which is exactly the background cost a tab nobody is looking at
/// shouldn't be paying. Best-effort — a page that fails this (no video on
/// it, a CSP that blocks inline scripts) still gets hidden either way.
#[tauri::command]
pub fn browser_set_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    if visible {
        webview.show().map_err(|error| error.to_string())
    } else {
        let _ = webview.eval("document.querySelectorAll('video,audio').forEach(m => m.pause())");
        webview.hide().map_err(|error| error.to_string())
    }
}

/// Tears a tab's webview down. The only thing that does — everything else
/// only hides it.
#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    webview.close().map_err(|error| error.to_string())
}
