//! The phone app itself: the built `mobile/` PWA, served from the same origin
//! as its API so the device cookie and the service worker both just work.
//!
//! Release builds carry the files inside the binary; debug builds read them
//! from `mobile/dist` on each request, so `npm run build:mobile` is the whole
//! reload loop while working on the phone UI.

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::server;

#[derive(rust_embed::Embed)]
#[folder = "../mobile/dist/"]
#[allow_missing = true]
struct MobileDist;

/// Scripts and styles only from this origin, nothing posted anywhere else,
/// and nobody frames the app. Inline styles stay allowed: React sets `style`
/// attributes. The one thing the app frames is the website preview
/// ([`super::preview`]) — see [`content_security_policy`].
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
     style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; \
     connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; \
     base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/// The app's policy, with the one frame it may draw: the website preview,
/// which lives on this same host at a port of its own. So `frame-src` names
/// this host at any port — never another host — for whichever address the
/// page was asked for by.
pub fn content_security_policy(headers: &HeaderMap) -> String {
    let frames = same_host_sources(headers).unwrap_or_else(|| "'none'".to_string());
    format!("{CONTENT_SECURITY_POLICY}; frame-src {frames}")
}

/// `https://mac.tail1234.ts.net https://mac.tail1234.ts.net:*` — the host
/// this request was addressed to, at its default port and at any other, for
/// a CSP source list. `None` for anything that isn't plainly a host name, so
/// nothing a client sent can add a directive of its own to the policy.
pub fn same_host_sources(headers: &HeaderMap) -> Option<String> {
    let host = headers
        .get(header::HOST)?
        .to_str()
        .ok()?
        .to_ascii_lowercase();
    let (name, _) = server::split_host(&host);
    let name = name.trim_end_matches('.');
    let plain = !name.is_empty()
        && name.len() <= 253
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if !plain && name != "[::1]" {
        return None;
    }
    let scheme = if server::is_https(headers) {
        "https"
    } else {
        "http"
    };
    Some(format!("{scheme}://{name} {scheme}://{name}:*"))
}

pub async fn serve(uri: Uri, request_headers: &HeaderMap) -> Response {
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
        let policy = HeaderValue::from_str(&content_security_policy(request_headers))
            .unwrap_or_else(|_| HeaderValue::from_static(CONTENT_SECURITY_POLICY));
        headers.insert(header::CONTENT_SECURITY_POLICY, policy);
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
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str, forwarded_proto: Option<&str>) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(proto) = forwarded_proto {
            map.insert("x-forwarded-proto", HeaderValue::from_str(proto).unwrap());
        }
        map
    }

    #[test]
    fn the_app_may_frame_its_own_host_and_nobody_elses() {
        let policy = content_security_policy(&headers("mac.tail1234.ts.net", None));
        assert!(
            policy.ends_with("frame-src https://mac.tail1234.ts.net https://mac.tail1234.ts.net:*"),
            "{policy}"
        );
        // Whoever asked for the app, and however it arrived, that host only.
        let policy = content_security_policy(&headers("Mac.tail1234.ts.net.:47247", None));
        assert!(
            policy.ends_with("frame-src https://mac.tail1234.ts.net https://mac.tail1234.ts.net:*"),
            "{policy}"
        );
        let policy = content_security_policy(&headers("127.0.0.1:47247", None));
        assert!(
            policy.ends_with("frame-src http://127.0.0.1 http://127.0.0.1:*"),
            "{policy}"
        );
        let policy = content_security_policy(&headers("localhost:47247", Some("https")));
        assert!(
            policy.ends_with("frame-src https://localhost https://localhost:*"),
            "{policy}"
        );
        let policy = content_security_policy(&headers("[::1]:47247", None));
        assert!(
            policy.ends_with("frame-src http://[::1] http://[::1]:*"),
            "{policy}"
        );
        // Nothing else about the policy moves: the app is still framed by no one.
        assert!(policy.contains("frame-ancestors 'none'") && policy.contains("default-src 'self'"));
    }

    #[test]
    fn a_host_that_is_not_plainly_a_name_cannot_write_into_the_policy() {
        for host in [
            "x.ts.net; script-src *",
            "a b.ts.net",
            "evil.ts.net'; script-src 'unsafe-inline",
            "",
            "[fe80::1]:1",
        ] {
            let policy = content_security_policy(&headers(host, None));
            assert!(policy.ends_with("frame-src 'none'"), "{host:?} -> {policy}");
            assert_eq!(
                policy.matches("script-src").count(),
                1,
                "{host:?} -> {policy}"
            );
        }
        assert!(content_security_policy(&HeaderMap::new()).ends_with("frame-src 'none'"));
    }
}
