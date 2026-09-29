//! The phone app itself: the built `mobile/` PWA, served from the same origin
//! as its API so the device cookie and the service worker both just work.
//!
//! Release builds carry the files inside the binary; debug builds read them
//! from `mobile/dist` on each request, so `npm run build:mobile` is the whole
//! reload loop while working on the phone UI.

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

#[derive(rust_embed::Embed)]
#[folder = "../mobile/dist/"]
#[allow_missing = true]
struct MobileDist;

/// Scripts and styles only from this origin, nothing framed, nothing posted
/// anywhere else. Inline styles stay allowed: React sets `style` attributes.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
     style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; \
     connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; \
     base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Debug builds read these files from disk: never let a path climb out of
    // the build folder, however it was spelled.
    if path.split(['/', '\\']).any(|segment| segment == "..") || path.contains('%') {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    // Hashed bundles and icons are files; every other path is a route the app
    // draws itself, so it gets the app.
    let (name, file) = match MobileDist::get(if path.is_empty() { "index.html" } else { path }) {
        Some(file) => (if path.is_empty() { "index.html" } else { path }, file),
        None if !path.contains('.') => match MobileDist::get("index.html") {
            Some(file) => ("index.html", file),
            None => return not_built(),
        },
        None => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };

    let mut response = Response::new(Body::from(file.data.into_owned()));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime_for(name)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if name.starts_with("assets/") {
            // Vite names these after their content: a new build is a new URL.
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    if name.ends_with(".html") {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        );
    }
    response
}

/// A debug build before the phone app has been built at all.
fn not_built() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "The egant phone app hasn't been built yet — run `npm run build:mobile`.",
    )
        .into_response()
}

fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
