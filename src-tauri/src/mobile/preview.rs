//! The website preview: a site running on the Mac, shown on the phone.
//!
//! It is its own listener on its own port — reached over its own Tailscale
//! HTTPS port — rather than a path on the phone API, for two reasons that
//! both come from how dev servers work:
//!
//! - A dev server's pages ask for root URLs (`/src/main.tsx`, `/_next/…`) and
//!   open their hot-reload socket at `/`. Only a whole origin can be that
//!   root; a `/preview/…` prefix on the API would serve a page whose every
//!   asset then comes back from egant's own app.
//! - A page is trusted with everything on its origin. The phone API's only
//!   write guard, besides the device cookie, is a header any script on the
//!   same origin can set — so a script in a previewed page (any third-party
//!   tag will do) could message a session and answer its permission prompt,
//!   which is a shell on the Mac. On another origin it can't: the browser
//!   won't send that header across origins without a preflight this server
//!   never grants.
//!
//! **Getting in.** A paired phone asks the API to open a session's site
//! (`POST /api/v1/sessions/{id}/preview`), which finds it (see [`super::run`]),
//! and answers with a link on this listener carrying a one-time ticket. The
//! link swaps the ticket for a cookie of this origin's own (`egant_preview`),
//! bound to that device and that port, and lands on `/`. The
//! device cookie is not what lets a phone in here: the browser that opens the
//! link (an installed iOS web app hands it to a browser that shares no cookies
//! with it) may never have seen it, and this is cleaner in any case — the
//! credential of the site is not the credential of the agent.
//!
//! **Where it goes.** Only to the port the grant names, which the Mac chose:
//! nothing in a request says where to connect. The request is made to look
//! like a browser on the Mac made it (`Host`, `Origin`, `Referer` say
//! `localhost:PORT` — dev servers refuse other hosts as DNS-rebinding
//! protection), egant's own cookies are removed from it, and a `Location` or
//! cookie in the answer that names `localhost:PORT` is made relative. A
//! WebSocket is handed through as bytes, and stays open only while its
//! grant is valid.

use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

use super::run::Site;
use super::{MobileShared, auth, server};

/// The cookie that lets a browser into the preview.
pub const COOKIE: &str = "egant_preview";
/// The path a link's ticket is spent at.
pub const ENTER_PATH: &str = "/__egant/enter";

/// A link works for this long, once.
const TICKET_TTL_MS: u64 = 60_000;
/// A browser that came in through one stays in this long. Long enough for an
/// afternoon of looking at a site; short enough that an old phone tab is not
/// a standing way in.
const GRANT_TTL_MS: u64 = 12 * 60 * 60 * 1000;
/// Outstanding links and grants are bounded, so a paired phone that keeps
/// asking cannot grow this without limit.
const MAX_TICKETS: usize = 32;
const MAX_GRANTS: usize = 64;
/// How often an open WebSocket asks whether it may still be open.
const RECHECK: Duration = Duration::from_secs(15);
/// A dev server that doesn't accept a connection in this long isn't there.
const UPSTREAM_CONNECT: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------------------
// Tickets and grants
// ---------------------------------------------------------------------------

/// What a link, and then a cookie, lets a browser reach: one site, on behalf
/// of one device.
#[derive(Debug, Clone)]
pub struct Grant {
    pub device: String,
    pub site: Site,
    expires_ms: u64,
}

/// Links waiting to be opened, and the browsers that opened one. Both are
/// kept by the hash of their secret — like device tokens — and in memory
/// only: a restart of egant ends every preview.
#[derive(Default)]
pub struct Previews {
    tickets: HashMap<String, Grant>,
    grants: HashMap<String, Grant>,
}

impl Previews {
    /// A one-time link secret for `site`.
    pub fn issue(&mut self, device: &str, site: Site, now_ms: u64) -> String {
        self.prune(now_ms);
        evict_oldest(&mut self.tickets, MAX_TICKETS);
        let ticket = auth::new_token();
        self.tickets.insert(
            auth::hash_token(&ticket),
            Grant {
                device: device.to_string(),
                site,
                expires_ms: now_ms + TICKET_TTL_MS,
            },
        );
        ticket
    }

    /// Spends a ticket: the cookie value for the browser that holds it, and
    /// how many seconds that cookie lasts. A ticket works once.
    pub fn redeem(&mut self, ticket: &str, now_ms: u64) -> Option<(String, u64)> {
        self.prune(now_ms);
        let mut grant = self.tickets.remove(&auth::hash_token(ticket))?;
        grant.expires_ms = now_ms + GRANT_TTL_MS;
        evict_oldest(&mut self.grants, MAX_GRANTS);
        let token = auth::new_token();
        self.grants.insert(auth::hash_token(&token), grant);
        Some((token, GRANT_TTL_MS / 1000))
    }

    /// The grant a cookie value holds, unless it has run out.
    pub fn lookup(&mut self, token: &str, now_ms: u64) -> Option<Grant> {
        let key = auth::hash_token(token);
        let grant = self.grants.get(&key)?;
        if grant.expires_ms <= now_ms {
            self.grants.remove(&key);
            return None;
        }
        Some(grant.clone())
    }

    /// Everything a device holds, links and browsers alike.
    pub fn revoke_device(&mut self, device: &str) {
        self.tickets.retain(|_, grant| grant.device != device);
        self.grants.retain(|_, grant| grant.device != device);
    }

    pub fn clear(&mut self) {
        self.tickets.clear();
        self.grants.clear();
    }

    fn prune(&mut self, now_ms: u64) {
        self.tickets.retain(|_, grant| grant.expires_ms > now_ms);
        self.grants.retain(|_, grant| grant.expires_ms > now_ms);
    }
}

fn evict_oldest(map: &mut HashMap<String, Grant>, capacity: usize) {
    while map.len() >= capacity {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, grant)| grant.expires_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Ctx {
    pub shared: Arc<MobileShared>,
    /// This listener's own port, which the `Host` header must name when it is
    /// addressed as loopback.
    pub port: u16,
}

pub fn router(ctx: Ctx) -> Router {
    Router::new()
        .route(ENTER_PATH, get(enter))
        .fallback(proxy)
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

/// The same host check as the phone API: loopback on this port, or a
/// `*.ts.net` name — never a page's own domain pointed at 127.0.0.1.
async fn guard(State(ctx): State<Ctx>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !server::host_allowed(host, ctx.port) {
        log::warn!("mobile: preview refused a request addressed to host {host:?}");
        return (StatusCode::MISDIRECTED_REQUEST, "unknown host").into_response();
    }
    next.run(request).await
}

#[derive(Deserialize)]
struct EnterQuery {
    t: Option<String>,
}

/// Spends a link's ticket and sends the browser to the site's front page,
/// carrying the cookie the rest of the visit runs on.
async fn enter(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    Query(query): Query<EnterQuery>,
) -> Response {
    let Some((token, max_age)) = query
        .t
        .as_deref()
        .and_then(|ticket| ctx.shared.redeem_preview_ticket(ticket))
    else {
        return page(
            StatusCode::FORBIDDEN,
            "This link has expired",
            "Open the website again from egant on your phone.",
        );
    };
    // Lax, not Strict: a site that signs in through another domain comes back
    // by a top-level redirect, which must still arrive with the cookie.
    let cookie = format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if server::is_https(&headers) {
            "; Secure"
        } else {
            ""
        }
    );
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SEE_OTHER;
    let out = response.headers_mut();
    out.insert(header::LOCATION, HeaderValue::from_static("/"));
    if let Ok(cookie) = HeaderValue::from_str(&cookie) {
        out.insert(header::SET_COOKIE, cookie);
    }
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    out.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// The value of one cookie in a request.
fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == name && !value.is_empty()).then_some(value)
        })
}

/// Who a cookie value is, if it still holds a grant: not expired, and the
/// device it was issued to still paired.
fn authorize(ctx: &Ctx, token: &str) -> Option<Grant> {
    ctx.shared.preview_grant(token)
}

async fn proxy(State(ctx): State<Ctx>, request: Request) -> Response {
    let token = cookie_value(request.headers(), COOKIE).map(str::to_string);
    let Some((token, grant)) = token.and_then(|token| {
        let grant = authorize(&ctx, &token)?;
        Some((token, grant))
    }) else {
        return unauthorized(request.headers());
    };
    if request.method() == Method::CONNECT {
        return (StatusCode::METHOD_NOT_ALLOWED, "no tunnelling").into_response();
    }
    forward(ctx, token, grant.site, request).await
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

async fn forward(ctx: Ctx, token: String, site: Site, mut request: Request) -> Response {
    let upgrading = wants_websocket(request.headers());
    let client_upgrade = upgrading.then(|| hyper::upgrade::on(&mut request));

    let stream = match connect(site).await {
        Ok(stream) => stream,
        Err(error) => {
            log::info!("mobile: preview couldn't reach port {}: {error}", site.port);
            return not_running(site.port, request.headers());
        }
    };
    let Ok((mut sender, connection)) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    else {
        return not_running(site.port, request.headers());
    };
    // `with_upgrades` keeps the connection's I/O available to whoever takes
    // the upgrade, which is how a WebSocket gets out of hyper's hands.
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });

    let (parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .parse::<Uri>()
        .unwrap_or_else(|_| Uri::from_static("/"));
    let mut outgoing = hyper::Request::new(body);
    *outgoing.method_mut() = parts.method;
    *outgoing.uri_mut() = path;
    *outgoing.headers_mut() = upstream_headers(&parts.headers, site.port, upgrading);

    let mut answer = match sender.send_request(outgoing).await {
        Ok(answer) => answer,
        Err(error) => {
            log::info!(
                "mobile: preview request to port {} failed: {error}",
                site.port
            );
            return bad_gateway(&parts.headers);
        }
    };

    let switching = answer.status() == StatusCode::SWITCHING_PROTOCOLS;
    if switching {
        match client_upgrade {
            Some(client) => pump(ctx, token, client, hyper::upgrade::on(&mut answer)),
            // It switched protocols although this wasn't asked to: hand
            // nothing through.
            None => return bad_gateway(&parts.headers),
        }
    }
    let (answer_parts, answer_body) = answer.into_parts();
    let mut response = Response::new(if switching {
        Body::empty()
    } else {
        Body::new(answer_body)
    });
    *response.status_mut() = answer_parts.status;
    *response.headers_mut() = downstream_headers(&answer_parts.headers, site.port, switching);
    response
}

/// A connection to the site: the family it was found on, then the other —
/// a dev server that restarted may have come back on the other one.
async fn connect(site: Site) -> std::io::Result<TcpStream> {
    let mut last = None;
    for addr in [site.socket_addr(), site.other_addr()] {
        match timeout(UPSTREAM_CONNECT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(error)) => last = Some(error),
            Err(_) => last = Some(std::io::ErrorKind::TimedOut.into()),
        }
    }
    Err(last.unwrap_or_else(|| std::io::ErrorKind::NotConnected.into()))
}

/// Joins the two halves of a WebSocket and copies between them, for as long
/// as the grant that opened it holds.
fn pump(ctx: Ctx, token: String, client: OnUpgrade, upstream: OnUpgrade) {
    tokio::spawn(async move {
        let (Ok(client), Ok(upstream)) = (client.await, upstream.await) else {
            return;
        };
        let (mut client, mut upstream) = (TokioIo::new(client), TokioIo::new(upstream));
        let mut copying = std::pin::pin!(tokio::io::copy_bidirectional(&mut client, &mut upstream));
        let mut recheck = tokio::time::interval(RECHECK);
        recheck.tick().await;
        loop {
            tokio::select! {
                _ = &mut copying => break,
                _ = recheck.tick() => {
                    if authorize(&ctx, &token).is_none() {
                        break;
                    }
                }
            }
        }
    });
}

fn wants_websocket(headers: &HeaderMap) -> bool {
    let upgrade = headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    upgrade
        && connection_tokens(headers)
            .iter()
            .any(|token| token == "upgrade")
}

/// The names a `Connection` header lists, lowercased.
fn connection_tokens(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// What a proxy in front of the request would have added and a site running
/// on `localhost` has no use for — or shouldn't be given: Tailscale's
/// identity headers say who is on the tailnet.
fn is_added_by_a_proxy(name: &str) -> bool {
    matches!(
        name,
        "forwarded"
            | "x-forwarded-for"
            | "x-forwarded-host"
            | "x-forwarded-proto"
            | "x-forwarded-port"
            | "x-forwarded-server"
            | "x-real-ip"
    ) || name.starts_with("tailscale-")
}

/// The request as the dev server should see it: from a browser on the same
/// machine, at `localhost:PORT`.
fn upstream_headers(incoming: &HeaderMap, port: u16, websocket: bool) -> HeaderMap {
    let origin = format!("http://localhost:{port}");
    let listed = connection_tokens(incoming);
    let public_host = incoming
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let mut out = HeaderMap::with_capacity(incoming.len() + 2);
    for (name, value) in incoming {
        let name_str = name.as_str();
        let rewritten = matches!(name_str, "host" | "cookie" | "origin" | "referer");
        if rewritten
            || HOP_BY_HOP.contains(&name_str)
            || listed.iter().any(|token| token == name_str)
            || is_added_by_a_proxy(name_str)
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    let set = |out: &mut HeaderMap, name, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            out.insert(name, value);
        }
    };
    set(&mut out, header::HOST, &format!("localhost:{port}"));
    if incoming.contains_key(header::ORIGIN) {
        set(&mut out, header::ORIGIN, &origin);
    }
    if let Some(referer) = incoming
        .get(header::REFERER)
        .and_then(|value| value.to_str().ok())
    {
        set(
            &mut out,
            header::REFERER,
            &rewrite_referer(referer, public_host, &origin),
        );
    }
    if let Some(cookie) = strip_own_cookies(incoming) {
        set(&mut out, header::COOKIE, &cookie);
    }
    if websocket {
        out.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        out.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    }
    out
}

/// A `Referer` that points at this listener, pointed at the dev server
/// instead; anyone else's is left alone.
fn rewrite_referer(referer: &str, public_host: Option<&str>, origin: &str) -> String {
    let Some((_, rest)) = referer.split_once("://") else {
        return referer.to_string();
    };
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    match public_host {
        Some(host) if host.eq_ignore_ascii_case(authority) => format!("{origin}{path}"),
        _ => referer.to_string(),
    }
}

/// The request's cookies without egant's own: the site has no business with
/// a credential that lets someone into the preview, still less the agent.
fn strip_own_cookies(headers: &HeaderMap) -> Option<String> {
    let kept: Vec<&str> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .map(str::trim)
        .filter(|pair| {
            let name = pair.split('=').next().unwrap_or_default();
            !pair.is_empty() && name != COOKIE && name != server::COOKIE
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

/// The answer as the phone should see it: no hop-by-hop headers (unless the
/// protocol is being switched, when they are the point), a `Location` or
/// cookie that names the dev server made relative to this origin, and the
/// page kept apart from whatever opened it.
fn downstream_headers(answer: &HeaderMap, port: u16, switching: bool) -> HeaderMap {
    let listed = connection_tokens(answer);
    let mut out = HeaderMap::with_capacity(answer.len() + 1);
    for (name, value) in answer {
        let name_str = name.as_str();
        if !switching
            && (HOP_BY_HOP.contains(&name_str) || listed.iter().any(|token| token == name_str))
        {
            continue;
        }
        let value = match name_str {
            "location" => value
                .to_str()
                .ok()
                .and_then(|text| HeaderValue::from_str(&rewrite_location(text, port)).ok()),
            "set-cookie" => value
                .to_str()
                .ok()
                .and_then(clean_set_cookie)
                .and_then(|text| HeaderValue::from_str(&text).ok()),
            _ => Some(value.clone()),
        };
        if let Some(value) = value {
            out.append(name.clone(), value);
        }
    }
    // Cuts the link to the page that opened this one (egant's phone app), so
    // the site can't steer it — without touching popups the site opens itself
    // (a sign-in window still reaches its opener).
    if !out.contains_key("cross-origin-opener-policy") {
        out.insert(
            "cross-origin-opener-policy",
            HeaderValue::from_static("same-origin-allow-popups"),
        );
    }
    out
}

/// A redirect to the dev server's own address, as a redirect within this
/// origin.
fn rewrite_location(location: &str, port: u16) -> String {
    for scheme in ["http", "https"] {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            let Some(rest) = location.strip_prefix(&format!("{scheme}://{host}:{port}")) else {
                continue;
            };
            match rest {
                "" => return "/".to_string(),
                rest if rest.starts_with('/') => return rest.to_string(),
                rest if rest.starts_with(['?', '#']) => return format!("/{rest}"),
                // `localhost:5173.evil.example` is not this server.
                _ => {}
            }
        }
    }
    location.to_string()
}

/// A cookie the site sets: kept, but for the domain (which named the dev
/// server's own host) — and never one of egant's own names, which would let
/// a site sign the phone out of the preview or the app.
fn clean_set_cookie(cookie: &str) -> Option<String> {
    let mut parts = cookie.split(';');
    let first = parts.next()?.trim();
    let name = first.split('=').next().unwrap_or_default().trim();
    if name == COOKIE || name == server::COOKIE {
        return None;
    }
    let mut kept = vec![first];
    kept.extend(
        parts
            .map(str::trim)
            .filter(|attribute| !attribute.to_ascii_lowercase().starts_with("domain=")),
    );
    Some(kept.join("; "))
}

// ---------------------------------------------------------------------------
// Words for the browser
// ---------------------------------------------------------------------------

fn wants_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"))
}

fn unauthorized(request: &HeaderMap) -> Response {
    say(
        request,
        StatusCode::UNAUTHORIZED,
        "Open this from egant",
        "This website is shown through egant on your phone. Open it from the conversation \
         with the Open website button.",
    )
}

fn not_running(port: u16, request: &HeaderMap) -> Response {
    say(
        request,
        StatusCode::BAD_GATEWAY,
        "Your Mac isn't serving this any more",
        &format!(
            "Nothing is answering on port {port}. Start the website again from egant \
             (Run website), then open it again."
        ),
    )
}

fn bad_gateway(request: &HeaderMap) -> Response {
    say(
        request,
        StatusCode::BAD_GATEWAY,
        "The website didn't answer properly",
        "Your Mac's server closed the connection. Try again in a moment.",
    )
}

/// A page to a browser navigating, a plain line to anything else (a script's
/// `fetch` wants no HTML).
fn say(request: &HeaderMap, status: StatusCode, title: &str, detail: &str) -> Response {
    if wants_html(request) {
        page(status, title, detail)
    } else {
        let mut response = (status, format!("{title}. {detail}")).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

fn page(status: StatusCode, title: &str, detail: &str) -> Response {
    let html = format!(
        "<!doctype html><meta charset=utf-8>\
         <meta name=viewport content=\"width=device-width,initial-scale=1\">\
         <title>{title}</title>\
         <style>:root{{color-scheme:light dark}}\
         body{{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;\
         display:grid;place-items:center;padding:24px;text-align:center}}\
         main{{max-width:380px}}h1{{font-size:20px;margin:0 0 8px}}\
         p{{margin:0;opacity:.65}}</style>\
         <main><h1>{title}</h1><p>{detail}</p></main>"
    );
    let mut response = (status, html).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile::run::LOOPBACKS;
    use crate::sync::now_ms;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn site(port: u16) -> Site {
        Site {
            port,
            addr: IpAddr::V4(Ipv4Addr::LOCALHOST),
        }
    }

    /// A test that waits on a socket cannot be allowed to wait for ever.
    async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
        timeout(Duration::from_secs(10), future)
            .await
            .expect("the test timed out waiting on a socket")
    }

    /// The head of a reply, up to and including the blank line — not to the
    /// end of the connection, which a keep-alive server never closes.
    async fn read_head(stream: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            within(stream.read_exact(&mut byte)).await.unwrap();
            head.push(byte[0]);
        }
        String::from_utf8_lossy(&head).to_string()
    }

    // -- tickets and grants --------------------------------------------------

    #[test]
    fn a_ticket_is_spent_once_for_a_grant_that_names_the_site() {
        let mut previews = Previews::default();
        let ticket = previews.issue("dev1", site(5173), 1_000);
        let (token, seconds) = previews.redeem(&ticket, 2_000).unwrap();
        assert_eq!(seconds, GRANT_TTL_MS / 1000);
        assert!(previews.redeem(&ticket, 2_001).is_none(), "one use");

        let grant = previews.lookup(&token, 3_000).unwrap();
        assert_eq!((grant.device.as_str(), grant.site.port), ("dev1", 5173));
        // The ticket and the cookie are different secrets.
        assert!(previews.lookup(&ticket, 3_000).is_none());
        assert!(previews.lookup("nonsense", 3_000).is_none());
    }

    #[test]
    fn a_ticket_is_good_for_a_minute_and_a_grant_for_half_a_day() {
        let mut previews = Previews::default();
        let late = previews.issue("d", site(5173), 0);
        assert!(previews.redeem(&late, TICKET_TTL_MS + 1).is_none());

        let ticket = previews.issue("d", site(5173), 0);
        let (token, _) = previews.redeem(&ticket, TICKET_TTL_MS - 1).unwrap();
        assert!(
            previews
                .lookup(&token, TICKET_TTL_MS + GRANT_TTL_MS - 2)
                .is_some()
        );
        assert!(
            previews
                .lookup(&token, TICKET_TTL_MS + GRANT_TTL_MS)
                .is_none()
        );
        assert!(
            previews.lookup(&token, 0).is_none(),
            "expired ones are dropped"
        );
    }

    #[test]
    fn revoking_a_device_takes_back_its_links_and_its_browsers() {
        let mut previews = Previews::default();
        let mine = previews.issue("mine", site(5173), 0);
        let (mine_token, _) = previews.redeem(&mine, 1).unwrap();
        let pending = previews.issue("mine", site(5173), 0);
        let theirs = previews.issue("theirs", site(3000), 0);
        let (theirs_token, _) = previews.redeem(&theirs, 1).unwrap();

        previews.revoke_device("mine");
        assert!(previews.lookup(&mine_token, 2).is_none());
        assert!(previews.redeem(&pending, 2).is_none());
        assert!(previews.lookup(&theirs_token, 2).is_some());

        previews.clear();
        assert!(previews.lookup(&theirs_token, 2).is_none());
    }

    #[test]
    fn outstanding_links_and_grants_are_bounded_and_the_oldest_go_first() {
        let mut previews = Previews::default();
        let first = previews.issue("d", site(5173), 0);
        for n in 1..=MAX_TICKETS as u64 {
            previews.issue("d", site(5173), n);
        }
        assert!(previews.tickets.len() <= MAX_TICKETS);
        assert!(previews.redeem(&first, MAX_TICKETS as u64 + 1).is_none());

        let mut tokens = Vec::new();
        for n in 0..(MAX_GRANTS as u64 + 5) {
            let ticket = previews.issue("d", site(5173), n);
            tokens.push(previews.redeem(&ticket, n).unwrap().0);
        }
        assert!(previews.grants.len() <= MAX_GRANTS);
        assert!(previews.lookup(&tokens[0], 100).is_none());
        assert!(previews.lookup(tokens.last().unwrap(), 100).is_some());
    }

    // -- rewriting -----------------------------------------------------------

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    fn text(map: &HeaderMap, name: &str) -> Option<String> {
        map.get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    }

    #[test]
    fn the_site_is_asked_as_a_browser_on_the_mac_would() {
        let incoming = headers(&[
            ("host", "mac.tail1234.ts.net:8443"),
            ("origin", "https://mac.tail1234.ts.net:8443"),
            ("referer", "https://mac.tail1234.ts.net:8443/docs?x=1"),
            (
                "cookie",
                "sid=abc; egant_preview=secret; theme=dark; egant_device=alsosecret",
            ),
            ("accept", "text/html"),
            ("x-forwarded-for", "100.101.102.103"),
            ("tailscale-user-login", "me@example.com"),
            ("connection", "keep-alive, x-private"),
            ("x-private", "hop"),
            ("keep-alive", "timeout=5"),
        ]);
        let out = upstream_headers(&incoming, 5173, false);
        assert_eq!(text(&out, "host").as_deref(), Some("localhost:5173"));
        assert_eq!(
            text(&out, "origin").as_deref(),
            Some("http://localhost:5173")
        );
        assert_eq!(
            text(&out, "referer").as_deref(),
            Some("http://localhost:5173/docs?x=1")
        );
        assert_eq!(text(&out, "cookie").as_deref(), Some("sid=abc; theme=dark"));
        assert_eq!(text(&out, "accept").as_deref(), Some("text/html"));
        for gone in [
            "x-forwarded-for",
            "tailscale-user-login",
            "connection",
            "x-private",
            "keep-alive",
        ] {
            assert!(!out.contains_key(gone), "{gone} should not reach the site");
        }
    }

    #[test]
    fn a_request_without_an_origin_or_cookies_is_given_neither() {
        let out = upstream_headers(
            &headers(&[("host", "mac.ts.net"), ("cookie", "egant_preview=x")]),
            3000,
            false,
        );
        assert!(!out.contains_key("origin"));
        assert!(!out.contains_key("cookie"));
        assert!(!out.contains_key("referer"));
        // Someone else's Referer is theirs.
        let out = upstream_headers(
            &headers(&[
                ("host", "mac.ts.net"),
                ("referer", "https://elsewhere.example/a"),
            ]),
            3000,
            false,
        );
        assert_eq!(
            text(&out, "referer").as_deref(),
            Some("https://elsewhere.example/a")
        );
    }

    #[test]
    fn a_websocket_handshake_keeps_what_makes_it_one() {
        let incoming = headers(&[
            ("host", "mac.ts.net"),
            ("connection", "Upgrade"),
            ("upgrade", "websocket"),
            ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("sec-websocket-protocol", "vite-hmr"),
            ("origin", "https://mac.ts.net"),
        ]);
        assert!(wants_websocket(&incoming));
        let out = upstream_headers(&incoming, 5173, true);
        assert_eq!(text(&out, "connection").as_deref(), Some("upgrade"));
        assert_eq!(text(&out, "upgrade").as_deref(), Some("websocket"));
        assert_eq!(
            text(&out, "sec-websocket-protocol").as_deref(),
            Some("vite-hmr")
        );
        assert_eq!(
            text(&out, "origin").as_deref(),
            Some("http://localhost:5173")
        );

        assert!(!wants_websocket(&headers(&[("upgrade", "websocket")])));
        assert!(!wants_websocket(&headers(&[
            ("connection", "upgrade"),
            ("upgrade", "h2c")
        ])));
    }

    #[test]
    fn a_redirect_to_the_dev_server_stays_on_this_origin() {
        let to = |location: &str| rewrite_location(location, 5173);
        assert_eq!(to("http://localhost:5173/login?next=/"), "/login?next=/");
        assert_eq!(to("http://127.0.0.1:5173/a"), "/a");
        assert_eq!(to("https://[::1]:5173"), "/");
        assert_eq!(to("http://localhost:5173?x=1"), "/?x=1");
        assert_eq!(to("/relative"), "/relative");
        assert_eq!(
            to("https://accounts.example.com/oauth"),
            "https://accounts.example.com/oauth"
        );
        // Another port, and a lookalike host, are not the dev server.
        assert_eq!(to("http://localhost:3000/x"), "http://localhost:3000/x");
        assert_eq!(
            to("http://localhost:5173.evil.example/x"),
            "http://localhost:5173.evil.example/x"
        );
    }

    #[test]
    fn a_sites_cookies_lose_their_domain_and_egants_names_are_refused() {
        assert_eq!(
            clean_set_cookie("sid=1; Domain=localhost; Path=/; HttpOnly").as_deref(),
            Some("sid=1; Path=/; HttpOnly")
        );
        assert_eq!(clean_set_cookie("a=b").as_deref(), Some("a=b"));
        assert_eq!(clean_set_cookie("egant_preview=x; Path=/"), None);
        assert_eq!(clean_set_cookie("egant_device=x; Path=/"), None);

        let answer = headers(&[
            ("set-cookie", "sid=1; Domain=localhost"),
            ("set-cookie", "egant_device=evil"),
            ("location", "http://localhost:5173/next"),
            ("connection", "close"),
            ("transfer-encoding", "chunked"),
            ("content-type", "text/html"),
        ]);
        let out = downstream_headers(&answer, 5173, false);
        assert_eq!(out.get_all("set-cookie").iter().count(), 1);
        assert_eq!(text(&out, "set-cookie").as_deref(), Some("sid=1"));
        assert_eq!(text(&out, "location").as_deref(), Some("/next"));
        assert!(!out.contains_key("connection") && !out.contains_key("transfer-encoding"));
        assert_eq!(text(&out, "content-type").as_deref(), Some("text/html"));
        assert_eq!(
            text(&out, "cross-origin-opener-policy").as_deref(),
            Some("same-origin-allow-popups")
        );

        // A site that has its own opener policy keeps it.
        let own = headers(&[("cross-origin-opener-policy", "same-origin")]);
        assert_eq!(
            text(
                &downstream_headers(&own, 5173, false),
                "cross-origin-opener-policy"
            )
            .as_deref(),
            Some("same-origin")
        );
        // A protocol switch keeps the headers that carry it.
        let switching = headers(&[("connection", "Upgrade"), ("upgrade", "websocket")]);
        let out = downstream_headers(&switching, 5173, true);
        assert!(out.contains_key("connection") && out.contains_key("upgrade"));
    }

    // -- the whole thing, over real sockets ----------------------------------

    /// A dev server: answers by path, on `addr`. `/ws` switches protocols and
    /// then shouts back whatever it is sent.
    async fn dev_server(addr: &str) -> Option<u16> {
        let listener = TcpListener::bind(addr).await.ok()?;
        let port = listener.local_addr().ok()?.port();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 2048];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&request).to_string();
                    let path = head.split(' ').nth(1).unwrap_or("/").to_string();
                    let reply = match path.as_str() {
                        "/ws" => {
                            let _ = stream
                                .write_all(
                                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                                      Connection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n",
                                )
                                .await;
                            let mut buf = [0u8; 256];
                            while let Ok(n) = stream.read(&mut buf).await {
                                if n == 0 {
                                    return;
                                }
                                let shout = buf[..n].to_ascii_uppercase();
                                if stream.write_all(&shout).await.is_err() {
                                    return;
                                }
                            }
                            return;
                        }
                        "/redirect" => format!(
                            "HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/next\r\n\
                             Content-Length: 0\r\nConnection: close\r\n\r\n"
                        ),
                        "/cookies" => "HTTP/1.1 200 OK\r\nSet-Cookie: sid=1; Domain=localhost; Path=/\r\n\
                                       Set-Cookie: egant_device=evil; Path=/\r\nContent-Length: 0\r\n\
                                       Connection: close\r\n\r\n"
                            .to_string(),
                        _ => {
                            // Echo the headers the site received.
                            let seen: String = head
                                .lines()
                                .skip(1)
                                .filter(|line| !line.is_empty())
                                .map(|line| format!("{line}\n"))
                                .collect();
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\
                                 Connection: close\r\n\r\n{seen}",
                                seen.len()
                            )
                        }
                    };
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        Some(port)
    }

    struct Rig {
        shared: Arc<MobileShared>,
        addr: SocketAddr,
        device: String,
    }

    impl Rig {
        async fn new() -> Rig {
            let shared = Arc::new(MobileShared::new(None));
            let code = super::super::lock(&shared.pairings).issue(now_ms()).0;
            let (device, _) = shared.pair(&code, Some("Test phone"), "").unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let app = router(Ctx {
                shared: shared.clone(),
                port: addr.port(),
            });
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Rig {
                shared,
                addr,
                device: device.id,
            }
        }

        /// A browser that came in through a link to `site`: its cookie.
        fn browser(&self, site: Site) -> String {
            let ticket = self.shared.issue_preview_ticket(&self.device, site);
            self.shared.redeem_preview_ticket(&ticket).unwrap().0
        }

        /// One request, answered in full: (status, headers, body).
        async fn get(&self, path: &str, extra: &[(&str, &str)]) -> (u16, String, String) {
            let mut request = format!(
                "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n",
                self.addr.port()
            );
            for (name, value) in extra {
                request.push_str(&format!("{name}: {value}\r\n"));
            }
            request.push_str("\r\n");
            let mut stream = TcpStream::connect(self.addr).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut raw = Vec::new();
            within(stream.read_to_end(&mut raw)).await.unwrap();
            let raw = String::from_utf8_lossy(&raw).to_string();
            let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
            let status = head
                .split(' ')
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            (status, head.to_string(), body.to_string())
        }
    }

    #[tokio::test]
    async fn without_a_cookie_nothing_gets_through_and_a_page_says_why() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let _ = dev;
        let (status, _, body) = rig.get("/", &[("Accept", "text/html")]).await;
        assert_eq!(status, 401);
        assert!(body.contains("Open this from egant"), "{body}");
        let (status, _, body) = rig.get("/api", &[("Cookie", "egant_preview=guess")]).await;
        assert_eq!(status, 401);
        assert!(
            !body.contains("<html"),
            "a script gets a line, not a page: {body}"
        );
    }

    #[tokio::test]
    async fn only_a_host_egant_answers_to_is_served() {
        let rig = Rig::new().await;
        let mut stream = TcpStream::connect(rig.addr).await.unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut raw = String::new();
        within(stream.read_to_string(&mut raw)).await.unwrap();
        assert!(raw.starts_with("HTTP/1.1 421"), "{raw}");
    }

    #[tokio::test]
    async fn a_link_is_spent_once_and_leaves_a_cookie_that_works() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let ticket = rig.shared.issue_preview_ticket(&rig.device, site(dev));

        let (status, head, _) = rig.get(&format!("{ENTER_PATH}?t={ticket}"), &[]).await;
        assert_eq!(status, 303);
        let head_lower = head.to_ascii_lowercase();
        assert!(head_lower.contains("location: /\r\n"), "{head}");
        assert!(
            head_lower.contains("referrer-policy: no-referrer"),
            "{head}"
        );
        let cookie = head
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .starts_with("set-cookie:")
                    .then(|| line.to_string())
            })
            .unwrap();
        assert!(
            cookie.contains("HttpOnly")
                && cookie.contains("SameSite=Lax")
                && cookie.contains("Path=/")
        );
        assert!(
            !cookie.contains("Secure"),
            "plain http on loopback: {cookie}"
        );
        let value = cookie
            .split("egant_preview=")
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap();

        let (status, _, body) = rig
            .get("/hello", &[("Cookie", &format!("egant_preview={value}"))])
            .await;
        assert_eq!(status, 200);
        // hyper writes header names in lower case.
        assert!(
            body.to_ascii_lowercase().contains("host: localhost:"),
            "{body}"
        );

        let (status, _, body) = rig
            .get(
                &format!("{ENTER_PATH}?t={ticket}"),
                &[("Accept", "text/html")],
            )
            .await;
        assert_eq!(status, 403, "the ticket was spent");
        assert!(body.contains("expired"), "{body}");
        let (status, _, _) = rig.get(ENTER_PATH, &[]).await;
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn the_site_sees_a_local_browser_and_none_of_egants_cookies() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let cookie = rig.browser(site(dev));
        let (status, _, body) = rig
            .get(
                "/page?q=1",
                &[
                    (
                        "Cookie",
                        &format!("sid=abc; egant_preview={cookie}; egant_device=tok"),
                    ),
                    ("Origin", &format!("http://127.0.0.1:{}", rig.addr.port())),
                    ("X-Forwarded-For", "100.1.2.3"),
                ],
            )
            .await;
        assert_eq!(status, 200);
        let seen = body.to_ascii_lowercase();
        assert!(seen.contains(&format!("host: localhost:{dev}\n")), "{body}");
        assert!(
            seen.contains(&format!("origin: http://localhost:{dev}\n")),
            "{body}"
        );
        assert!(seen.contains("cookie: sid=abc\n"), "{body}");
        assert!(
            !seen.contains("egant_"),
            "egant's cookies must not leave: {body}"
        );
        assert!(!seen.contains("x-forwarded-for"), "{body}");
    }

    #[tokio::test]
    async fn a_site_that_listens_on_ipv6_alone_is_reached() {
        // Vite's default on a current Mac: `localhost` is `::1` and only that.
        let Some(dev) = dev_server("[::1]:0").await else {
            return; // no IPv6 loopback here
        };
        let rig = Rig::new().await;
        let cookie = rig.browser(Site {
            port: dev,
            addr: LOOPBACKS[1],
        });
        let (status, _, _) = rig
            .get("/", &[("Cookie", &format!("egant_preview={cookie}"))])
            .await;
        assert_eq!(status, 200);
        // Found on the wrong family, it is still found: the proxy tries both.
        let cookie = rig.browser(site(dev));
        let (status, _, _) = rig
            .get("/", &[("Cookie", &format!("egant_preview={cookie}"))])
            .await;
        assert_eq!(status, 200);
    }

    #[tokio::test]
    async fn redirects_and_cookies_from_the_site_are_made_to_fit_this_origin() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let cookie = format!("egant_preview={}", rig.browser(site(dev)));

        let (status, head, _) = rig.get("/redirect", &[("Cookie", &cookie)]).await;
        assert_eq!(status, 302);
        assert!(
            head.to_ascii_lowercase().contains("location: /next\r\n"),
            "{head}"
        );

        let (status, head, _) = rig.get("/cookies", &[("Cookie", &cookie)]).await;
        assert_eq!(status, 200);
        let lower = head.to_ascii_lowercase();
        assert!(lower.contains("set-cookie: sid=1; path=/"), "{head}");
        assert!(!lower.contains("domain="), "{head}");
        assert!(!lower.contains("egant_device"), "{head}");
        assert!(
            lower.contains("cross-origin-opener-policy: same-origin-allow-popups"),
            "{head}"
        );
    }

    #[tokio::test]
    async fn a_site_that_is_gone_says_so_instead_of_hanging() {
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let rig = Rig::new().await;
        let cookie = format!("egant_preview={}", rig.browser(site(port)));
        let (status, _, body) = rig
            .get("/", &[("Cookie", &cookie), ("Accept", "text/html")])
            .await;
        assert_eq!(status, 502);
        assert!(
            body.contains(&format!("port {port}")) && body.contains("Run website"),
            "{body}"
        );
    }

    #[tokio::test]
    async fn a_revoked_device_is_locked_out_at_once() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let cookie = format!("egant_preview={}", rig.browser(site(dev)));
        assert_eq!(rig.get("/", &[("Cookie", &cookie)]).await.0, 200);
        rig.shared.revoke(&rig.device);
        assert_eq!(rig.get("/", &[("Cookie", &cookie)]).await.0, 401);
    }

    #[tokio::test]
    async fn a_websocket_passes_through_as_bytes_for_hot_reload() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let cookie = rig.browser(site(dev));

        let mut stream = TcpStream::connect(rig.addr).await.unwrap();
        let handshake = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Protocol: vite-hmr\r\nCookie: egant_preview={cookie}\r\n\r\n",
            rig.addr.port()
        );
        stream.write_all(handshake.as_bytes()).await.unwrap();

        let head = read_head(&mut stream).await.to_ascii_lowercase();
        assert!(head.starts_with("http/1.1 101"), "{head}");
        assert!(
            head.contains("upgrade: websocket") && head.contains("sec-websocket-accept: abc"),
            "{head}"
        );

        stream.write_all(b"hello, hot reload").await.unwrap();
        let mut echoed = [0u8; 17];
        within(stream.read_exact(&mut echoed)).await.unwrap();
        assert_eq!(&echoed, b"HELLO, HOT RELOAD");
    }

    /// The real thing rather than a stand-in: this repository's own Vite dev
    /// server — which listens on `::1` alone, refuses a host it doesn't know,
    /// serves root URLs, and hot-reloads over a WebSocket at `/` — seen through
    /// the proxy, end to end. It starts a process, so it is left out of the
    /// default run: `cargo test -p egant vite -- --ignored`.
    #[tokio::test]
    #[ignore = "starts this repository's Vite dev server (needs `npm install`)"]
    async fn a_real_vite_dev_server_works_through_the_proxy() {
        struct Kill(std::process::Child);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let vite = root.join("node_modules/.bin/vite");
        assert!(vite.is_file(), "run `npm install` first");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let _vite = Kill(
            std::process::Command::new(&vite)
                .current_dir(&root)
                .env("VITE_PORT", port.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("start vite"),
        );

        // Found the way the app finds a site.
        let mut found = None;
        for _ in 0..120 {
            if let Some(site) = crate::mobile::run::find_among(vec![port]).await {
                found = Some(site);
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let site = found.expect("vite never came up");
        eprintln!("vite answered on {}", site.socket_addr());

        // What the phone's pill would say about this folder, on real data: the
        // command from the project's own manifest, and the site — tied to the
        // folder by `lsof`, which names Vite's directory.
        use crate::mobile::run;
        let command = run::detect_run_command(&root).expect("this repository has a dev script");
        assert_eq!(
            (command.label, command.command.as_str()),
            ("Run website", "npm run dev")
        );
        let listening = run::listening_in(&root);
        assert!(
            listening.contains(&port),
            "lsof should tie :{port} to this folder: {listening:?}"
        );
        let by_folder = run::find_site(root.clone(), vec![], vec![]).await;
        assert_eq!(by_folder.map(|found| found.port), Some(port));
        // Another folder's session does not claim it — unless its own words
        // said so, which is the fallback for a server lsof can't tie down.
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(run::listening_in(elsewhere.path()).is_empty());
        let unrelated = run::find_site(elsewhere.path().to_path_buf(), vec![], vec![]).await;
        assert_eq!(unrelated.map(|found| found.port), None);
        let announced = run::find_site(elsewhere.path().to_path_buf(), vec![port], vec![]).await;
        assert_eq!(announced.map(|found| found.port), Some(port));
        // Never one of egant's own ports.
        assert!(
            run::find_site(root.clone(), vec![], vec![port])
                .await
                .is_none()
        );

        let rig = Rig::new().await;
        let cookie = format!("egant_preview={}", rig.browser(site));
        let origin = format!("http://127.0.0.1:{}", rig.addr.port());
        let browser = [
            ("Cookie", cookie.as_str()),
            ("Accept", "text/html"),
            ("Origin", origin.as_str()),
        ];

        // The page, with the root URLs that a path prefix would have broken.
        let (status, _, page) = rig.get("/", &browser).await;
        assert_eq!(status, 200, "{page}");
        assert!(
            page.contains("/@vite/client") && page.contains("/src/main.tsx"),
            "{page}"
        );

        // What it then asks for, from the same origin.
        let (status, head, client) = rig.get("/@vite/client", &browser).await;
        assert_eq!(status, 200);
        assert!(head.to_ascii_lowercase().contains("javascript"), "{head}");
        let (status, _, _) = rig.get("/src/main.tsx", &browser).await;
        assert_eq!(status, 200);

        // Hot reload: the WebSocket the client opens at `/?token=…`.
        let token = client
            .split("const wsToken = \"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("the client names its socket token")
            .to_string();
        let mut stream = TcpStream::connect(rig.addr).await.unwrap();
        let handshake = format!(
            "GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: Upgrade\r\n\
             Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: vite-hmr\r\n\
             Origin: {origin}\r\n{cookie_header}\r\n\r\n",
            rig.addr.port(),
            cookie_header = format_args!("Cookie: {cookie}"),
        );
        stream.write_all(handshake.as_bytes()).await.unwrap();
        let head = read_head(&mut stream).await.to_ascii_lowercase();
        assert!(head.starts_with("http/1.1 101"), "{head}");
        assert!(head.contains("sec-websocket-protocol: vite-hmr"), "{head}");

        // Vite greets a new hot-reload client with a text frame.
        let mut frame = [0u8; 2];
        within(stream.read_exact(&mut frame)).await.unwrap();
        assert_eq!(frame[0], 0x81, "a final text frame");
        let mut payload = vec![0u8; (frame[1] & 0x7f) as usize];
        within(stream.read_exact(&mut payload)).await.unwrap();
        let payload = String::from_utf8_lossy(&payload);
        assert!(payload.contains("connected"), "{payload}");
    }

    #[tokio::test]
    async fn a_websocket_without_a_grant_is_refused_before_anything_connects() {
        let dev = dev_server("127.0.0.1:0").await.unwrap();
        let rig = Rig::new().await;
        let _ = dev;
        let mut stream = TcpStream::connect(rig.addr).await.unwrap();
        let handshake = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            rig.addr.port()
        );
        stream.write_all(handshake.as_bytes()).await.unwrap();
        let head = read_head(&mut stream).await;
        assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    }
}
