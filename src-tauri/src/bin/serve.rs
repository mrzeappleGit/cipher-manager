//! Local web server for cipherManager.
//!
//! Reuses the same scanning logic as the desktop app to serve a read-only JSON
//! API plus the embedded web frontend, so the dashboard can be viewed in any
//! browser. Also supports `--export` to dump a JSON snapshot to stdout.
//!
//! Usage:
//!   serve [--host 127.0.0.1] [--port 4600]
//!   serve --export > snapshot.json

// No console window in release: serve autostarts at login from a plain Startup
// .lnk (Bitdefender flags .vbs launchers, and it blocks HKCU Run writes — see
// autostart notes in commands.rs). Console prints vanish in release; the token
// lives in serve-token.txt and health is checked over HTTP. `--export > file`
// still works (redirected handles are inherited). Debug builds keep the console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::sync::{Arc, Mutex};

use include_dir::{include_dir, Dir};
use tiny_http::{Header, Method, Response, Server};

/// Max accepted request-body size (these JSON payloads are tiny).
const MAX_BODY: usize = 1 << 20; // 1 MiB

fn loopback_host_allowed(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ["localhost", "127.0.0.1", "[::1]"].iter().any(|allowed| {
        host == *allowed || host.strip_prefix(&format!("{allowed}:"))
            .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && port.parse::<u16>().is_ok())
    })
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn management_protocol_requires_auth_and_never_dispatches_get_commands() {
        for host in ["localhost", "LOCALHOST:4600", "127.0.0.1:4600", "[::1]", "[::1]:4600"] {
            assert!(loopback_host_allowed(host));
        }
        for host in ["evil.example", "evil.example:4600", "localhost.evil.example", "127.0.0.1:4600@evil.example", "localhost:", "localhost:99999", "[::1]:+4600", ""] {
            assert!(!loopback_host_allowed(host));
        }
        // Owned ephemeral listener only; never contact the user's server/profile.
        let server = Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.server_addr());
        let life = Lifecycle::default();
        let cache = Mutex::new(None);
        let request = |method: &str, path: &str, auth: Option<&str>, body: String| {
            let url = format!("{base}{path}");
            let method = method.to_string();
            let auth = auth.map(String::from);
            let client = std::thread::spawn(move || {
                let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(3)).build();
                let mut req = agent.request(&method, &url);
                if let Some(auth) = auth { req = req.set("Authorization", &auth); }
                let resp = match req.send_string(&body) {
                    Ok(r) | Err(ureq::Error::Status(_, r)) => r,
                    Err(e) => panic!("isolated HTTP test failed: {e}"),
                };
                (resp.status(), resp.into_json::<serde_json::Value>().unwrap())
            });
            let req = server.recv_timeout(std::time::Duration::from_secs(3)).unwrap().unwrap();
            handle_request(req, &None, "isolated-test-token", &cache, &life);
            client.join().unwrap()
        };
        assert_eq!(request("GET", "/api/run_skill", None, "{}".into()).0, 405);
        let h = request("GET", "/api/health", None, "{}".into());
        assert_eq!(h.0, 200);
        assert_eq!(h.1["application"], service::APPLICATION);
        assert_eq!(h.1["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(h.1["instance"], life.instance);
        let body = serde_json::json!({"instance": life.instance}).to_string();
        assert_eq!(request("POST", "/api/shutdown", None, body.clone()).0, 401);
        assert_eq!(request("GET", "/api/shutdown", Some("Bearer isolated-test-token"), body.clone()).0, 405);
        assert_eq!(request("POST", "/api/shutdown", Some("Bearer isolated-test-token"), "{}".into()).0, 409);
        let active_request = life.enter().unwrap();
        assert_eq!(request("POST", "/api/shutdown", Some("Bearer isolated-test-token"), body).0, 409);
        drop(active_request);
        // Busy checks are injected into the library's isolated lifecycle test.
        life.stop(&life.instance, || Ok(None)).unwrap();
        assert_eq!(request("GET", "/api/health", None, "{}".into()).0, 503);
    }
}

use cipher_manager_lib::commands as core;
use cipher_manager_lib::model::*;
use cipher_manager_lib::sizzle;
use cipher_manager_lib::service::{self, Lifecycle};

// The built frontend, embedded at compile time.
static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

/// Overview data that is expensive to compute; cached after first request.
struct Overview {
    projects: Vec<ProjectSummary>,
    usage: UsageStats,
    recaps: Vec<DayRecap>,
    disk: DiskStats,
}

fn compute_overview() -> Overview {
    let (projects, usage) = core::scan_all();
    Overview {
        projects,
        usage,
        recaps: core::daily_recaps(),
        disk: core::disk_stats(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--export") {
        export_snapshot();
        return;
    }

    let host = arg_value(&args, "--host").unwrap_or_else(|| "127.0.0.1".to_string());
    let port = arg_value(&args, "--port")
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4600);
    let addr = format!("{host}:{port}");

    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    // Loopback binds are trusted (same machine). Anything wider — LAN/phone —
    // requires the access token on every request; the first hit carries it as
    // ?token=… and gets a cookie so the SPA's own requests pass transparently.
    // Lifecycle control always requires bearer authentication, including loopback.
    let control_token = match core::ensure_serve_token() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Failed to set up the access token: {e}");
            std::process::exit(1);
        }
    };
    let auth_token = if host == "127.0.0.1" || host == "localhost" {
        None
    } else { Some(control_token.clone()) };

    println!("cipherManager web server running at http://{addr}");
    if auth_token.is_some() {
        println!("Access token required; pair from the desktop app's remote access settings.");
    }
    println!("(reading ~/.claude — press Ctrl+C to stop)");

    // Revive agent sessions from before the last serve shutdown/reboot
    // (no-op unless acting mode is on and something was running).
    cipher_manager_lib::agents::restore_persisted();

    let cache: Arc<Mutex<Option<Overview>>> = Arc::new(Mutex::new(None));
    let server = Arc::new(server);
    let lifecycle = Arc::new(Lifecycle::default());

    // Worker pool: tiny_http supports concurrent recv on a shared Server, so a
    // slow arm (ai_proxy, scan) no longer blocks health checks or the phone.
    // ponytail: fixed 4 workers, no queue metrics; bump the count or move to a
    // real thread pool if agent terminals ever saturate it.
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let server = Arc::clone(&server);
            let cache = Arc::clone(&cache);
            let auth_token = auth_token.clone();
            let control_token = control_token.clone();
            let lifecycle = Arc::clone(&lifecycle);
            std::thread::spawn(move || {
                while !lifecycle.stopping() {
                    match server.recv_timeout(std::time::Duration::from_millis(100)) {
                        Ok(Some(req)) => handle_request(req, &auth_token, &control_token, &cache, &lifecycle),
                        Ok(None) => {},
                        Err(_) => break,
                    }
                }
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
}

fn handle_request(
    mut req: tiny_http::Request,
    auth_token: &Option<String>,
    control_token: &str,
    cache: &Mutex<Option<Overview>>,
    lifecycle: &Lifecycle,
) {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();

    // Desktop-only management protocol: never accept cookies/query tokens or
    // browser origins. The instance binds this stop to the server just probed.
    if path == "/api/shutdown" {
        let bearer = req.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
            .map(|h| h.value.as_str());
        let browser = req.headers().iter().any(|h| h.field.as_str().as_str().eq_ignore_ascii_case("origin"));
        if method != Method::Post {
            let _ = req.respond(error_response(405, "Use POST for server control"));
        } else if browser || !service::shutdown_authorized(bearer, control_token) {
            let _ = req.respond(error_response(401, "Server control requires native bearer authentication"));
        } else {
            let mut body = String::new();
            if req.as_reader().take(4097).read_to_string(&mut body).is_err() || body.len() > 4096 {
                let _ = req.respond(error_response(413, "Invalid shutdown request"));
                return;
            }
            let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let instance = value.get("instance").and_then(|v| v.as_str()).unwrap_or("");
            let response = match lifecycle.stop(instance, service::active_work_reason) {
                Ok(()) => json_response(&serde_json::json!({"ok": true})),
                Err(e) => error_response(409, &e),
            };
            let _ = req.respond(response);
        }
        return;
    }
    let _request = match lifecycle.enter() {
        Ok(guard) => guard,
        Err(e) => { let _ = req.respond(error_response(503, &e)); return; },
    };

    // Even G2 facade: its OWN scoped bearer tokens + CORS, handled before
    // the general gate so a G2 client never needs (or gets) the cm_token.
    if path.starts_with("/api/g2/") {
        let bearer = req
            .headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
            .and_then(|h| h.value.as_str().strip_prefix("Bearer ").map(String::from))
            .unwrap_or_default();
        let mut body = String::new();
        if method == Method::Post {
            if req.body_length().map(|l| l > MAX_BODY).unwrap_or(false) {
                let _ = req.respond(with_g2_cors(error_response(413, "Request body too large")));
                return;
            }
            let mut reader = req.as_reader().take(MAX_BODY as u64);
            let _ = reader.read_to_string(&mut body);
        }
        let resp = handle_g2(&method, &path, &body, &bearer, cache);
        let _ = req.respond(with_g2_cors(resp));
        return;
    }

    // Tokenless loopback must reject attacker-controlled Host headers: matching
    // Origin and Host alone does not prevent a DNS-rebinding website.
    if auth_token.is_none() {
        let host = req.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("host"))
            .map(|h| h.value.as_str()).unwrap_or("");
        if !loopback_host_allowed(host) {
            let _ = req.respond(error_response(403, "Loopback requests require a localhost Host header"));
            return;
        }
    }

    // Desktop-webview CORS + cross-origin guard for /api/* (g2 handled above).
    // Origin-scoped, never wildcard: the loopback API is tokenless, so `*`
    // would let any website read responses.
    let origin = req
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("origin"))
        .map(|h| h.value.as_str().to_string());
    let origin_allowed = matches!(
        origin.as_deref(),
        Some("http://tauri.localhost") | Some("https://tauri.localhost")
    );
    let is_api = path.starts_with("/api/");

    if is_api && method == Method::Options {
        // Preflight (no auth headers yet — must answer before the auth gate).
        let mut resp = Response::from_data(vec![]).with_status_code(204);
        if origin_allowed {
            let hdr = |k: &str, v: &str| Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
            resp = resp
                .with_header(hdr("Access-Control-Allow-Origin", origin.as_deref().unwrap()))
                .with_header(hdr("Access-Control-Allow-Methods", "POST, OPTIONS"))
                .with_header(hdr("Access-Control-Allow-Headers", "Authorization, Content-Type"))
                .with_header(hdr("Access-Control-Max-Age", "3600"));
        }
        let _ = req.respond(resp);
        return;
    }

    if is_api && method != Method::Post
        && !(method == Method::Get && matches!(path.as_str(), "/api/health" | "/api/net_check")) {
        let _ = req.respond(error_response(405, "API commands require POST"));
        return;
    }

    // CSRF: any website can fire a no-cors POST at the tokenless loopback API
    // (drive-by spawn). An Origin that is neither the desktop webview nor
    // same-origin with our Host is refused; no Origin (curl, same-origin
    // fetches) proceeds as before.
    if is_api && !origin_allowed {
        if let Some(o) = origin.as_deref() {
            let origin_host = o.split("://").nth(1).unwrap_or(o);
            let host = req
                .headers()
                .iter()
                .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("host"))
                .map(|h| h.value.as_str().to_string())
                .unwrap_or_default();
            if !origin_host.eq_ignore_ascii_case(&host) {
                let _ = req.respond(error_response(403, "cross-origin requests are not allowed"));
                return;
            }
        }
    }

    // Auth gate (non-loopback binds only).
    let mut grant_cookie = false;
    if let Some(token) = auth_token {
        let by_query = url
            .split_once('?')
            .map(|(_, q)| q.split('&').any(|kv| kv == format!("token={token}")))
            .unwrap_or(false);
        let by_cookie = req.headers().iter().any(|h| {
            h.field.as_str().as_str().eq_ignore_ascii_case("cookie")
                && h.value.as_str().contains(&format!("cm_token={token}"))
        });
        let by_header = req.headers().iter().any(|h| {
            h.field.as_str().as_str().eq_ignore_ascii_case("authorization")
                && h.value.as_str() == format!("Bearer {token}")
        });
        if !(by_query || by_cookie || by_header) {
            let _ = req.respond(error_response(401, "Missing or invalid access token"));
            return;
        }
        grant_cookie = by_query && !by_cookie;
    }

    // Reject oversized bodies before buffering (DoS guard).
    if method == Method::Post && req.body_length().map(|l| l > MAX_BODY).unwrap_or(false) {
        let _ = req.respond(error_response(413, "Request body too large"));
        return;
    }

    let mut body = String::new();
    if method == Method::Post {
        let mut reader = req.as_reader().take(MAX_BODY as u64);
        let _ = reader.read_to_string(&mut body);
    }

    let mut response = if path == "/api/health" {
        json_response(&service::health(&lifecycle.instance))
    } else { route(&path, &body, cache) };
    if is_api && origin_allowed {
        if let Ok(h) = Header::from_bytes(
            &b"Access-Control-Allow-Origin"[..],
            origin.as_deref().unwrap().as_bytes(),
        ) {
            response = response.with_header(h);
        }
    }
    if grant_cookie {
        if let Some(t) = auth_token {
            if let Ok(h) = Header::from_bytes(
                &b"Set-Cookie"[..],
                format!("cm_token={t}; Path=/; HttpOnly; SameSite=Lax").as_bytes(),
            ) {
                response = response.with_header(h);
            }
        }
    }
    let _ = req.respond(response);
}

/// CORS for the G2 plugin's WebView. Wildcard origin is acceptable here: the
/// routes are read-only, bearer-token gated, and scoped to /api/g2/* only.
fn with_g2_cors(r: Response<std::io::Cursor<Vec<u8>>>) -> Response<std::io::Cursor<Vec<u8>>> {
    let hdr = |k: &str, v: &str| Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
    r.with_header(hdr("Access-Control-Allow-Origin", "*"))
        .with_header(hdr("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .with_header(hdr("Access-Control-Allow-Headers", "Authorization, Content-Type"))
        .with_header(hdr("Access-Control-Max-Age", "86400"))
}

/// The G2 facade. Pairing endpoints are unauthenticated (rate-limited,
/// approval happens on the desktop); everything else needs a paired token.
fn handle_g2(
    method: &Method,
    path: &str,
    body: &str,
    bearer: &str,
    cache: &Mutex<Option<Overview>>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    use cipher_manager_lib::g2;

    if *method == Method::Options {
        return Response::from_data(vec![]).with_status_code(204);
    }
    let ep = path.trim_start_matches("/api/g2/");

    // Pairing (no token yet).
    match (method, ep) {
        (&Method::Post, "pair/start") => {
            let device = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("device").and_then(|d| d.as_str()).map(String::from))
                .unwrap_or_default();
            return match g2::pair_start(&device) {
                Ok(v) => json_response(&v),
                Err(e) => error_response(429, &e),
            };
        }
        (&Method::Post, "pair/status") => {
            let code = json_field(body, "code");
            return match g2::pair_status(&code) {
                Ok(v) => json_response(&v),
                Err(e) => error_response(400, &e),
            };
        }
        _ => {}
    }

    // Everything else: scoped bearer token required.
    if !g2::authorize(bearer) {
        return error_response(401, "Pair this device in cipherManager Settings");
    }
    match (method, ep) {
        (&Method::Get, "now") => json_response(&g2::now_dto(&core::read_jobs(), &core::recent_usage())),
        (&Method::Get, "deck") => json_response(&g2::deck_dto()),
        (&Method::Get, "brief") => {
            let mut guard = cache.lock().unwrap();
            if guard.is_none() {
                *guard = Some(compute_overview());
            }
            let ov = guard.as_ref().unwrap();
            json_response(&g2::brief_dto(&core::recent_usage(), &ov.recaps))
        }
        (&Method::Get, "projects") => {
            let mut guard = cache.lock().unwrap();
            if guard.is_none() {
                *guard = Some(compute_overview());
            }
            let ov = guard.as_ref().unwrap();
            json_response(&g2::projects_dto(&ov.projects))
        }
        _ => error_response(404, "Unknown G2 endpoint"),
    }
}

fn route(
    path: &str,
    body: &str,
    cache: &Mutex<Option<Overview>>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    if let Some(api) = path.strip_prefix("/api/") {
        return handle_api(api, body, cache);
    }
    serve_static(path)
}

fn handle_api(
    endpoint: &str,
    body: &str,
    cache: &Mutex<Option<Overview>>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    // Populate the overview cache (lazily, once) and RETURN THE GUARD: the
    // lock must be held across compute-or-read, or a concurrent refresh could
    // empty the cache between our ensure and our read (workers run in
    // parallel now). Serializing overview reads behind one mutex is fine —
    // the cached path is microseconds.
    let ensure = || {
        let mut guard = cache.lock().unwrap();
        if guard.is_none() {
            *guard = Some(compute_overview());
        }
        guard
    };

    match endpoint {
        "refresh" => {
            // Recompute under one continuous lock so no worker ever observes
            // an empty cache mid-refresh.
            let mut guard = cache.lock().unwrap();
            *guard = Some(compute_overview());
            json_response(&guard.as_ref().unwrap().usage)
        }
        "list_projects" => json_response(&ensure().as_ref().unwrap().projects),
        "get_usage_stats" => json_response(&ensure().as_ref().unwrap().usage),
        "get_daily_recaps" => json_response(&ensure().as_ref().unwrap().recaps),
        "get_disk_stats" => json_response(&ensure().as_ref().unwrap().disk),
        "get_app_info" => json_response(&core::get_app_info()),
        "get_recent_usage" => json_response(&core::recent_usage()),
        "get_documents" => json_response(&core::list_documents()),
        "get_skills" => json_response(&core::list_skills()),
        "run_skill" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let bin = {
                let b = get("bin");
                if b.trim().is_empty() { "claude".to_string() } else { b }
            };
            let extra = core::split_args(&get("args"));
            let cwd = {
                let c = get("cwd");
                if c.trim().is_empty() { None } else { Some(c) }
            };
            match core::start_job(get("skill"), get("label"), get("prompt"), bin, extra, cwd) {
                Ok(id) => json_response(&id),
                Err(e) => error_response(400, &e),
            }
        }
        "get_job" => {
            let id = json_field(body, "id");
            match core::read_job(&id) {
                Some(j) => json_response(&j),
                None => error_response(404, "Unknown job"),
            }
        }
        "list_jobs" => json_response(&core::read_jobs()),
        "stop_job" => {
            let id = json_field(body, "id");
            match core::cancel_job(&id) {
                Ok(()) => json_response(&serde_json::json!({ "ok": true })),
                Err(e) => error_response(409, &e),
            }
        }
        "get_audit" => {
            let limit = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("limit").and_then(|l| l.as_u64()))
                .map(|l| l as usize)
                .unwrap_or(100);
            json_response(&core::read_audit(limit))
        }
        "get_deck" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let str_field = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ics_urls = v
                .get("icsUrls")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let cfg = cipher_manager_lib::deck::DeckConfig {
                ics_urls,
                asana_token: str_field("asanaToken"),
                asana_project: str_field("asanaProject"),
                asana_workspace: str_field("asanaWorkspace"),
            };
            json_response(&core::deck_data(cfg))
        }
        "ha_states" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ids: Vec<String> = v
                .get("entityIds")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            match cipher_manager_lib::commands::ha_states_impl(&s("url"), &s("token"), &ids) {
                Ok(d) => json_response(&d),
                Err(e) => error_response(502, &e),
            }
        }
        "ha_call_service" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            match cipher_manager_lib::commands::ha_call_service_impl(
                &s("url"),
                &s("token"),
                &s("domain"),
                &s("service"),
                &s("entityId"),
            ) {
                Ok(()) => json_response(&serde_json::json!({ "ok": true })),
                Err(e) => error_response(502, &e),
            }
        }
        "get_task_detail" => {
            let token = json_field(body, "token");
            let gid = json_field(body, "gid");
            match cipher_manager_lib::deck::task_detail(&token, &gid) {
                Ok(d) => json_response(&d),
                Err(e) => error_response(502, &e),
            }
        }
        "get_task_comments" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let token = v.get("token").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ids: Vec<String> = v
                .get("ids")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            json_response(&cipher_manager_lib::deck::task_comments(&token, &ids, 2))
        }
        "search_any" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let terms: Vec<String> = v
                .get("terms")
                .and_then(|t| t.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let limit = v.get("limit").and_then(|l| l.as_u64()).map(|l| l as usize).unwrap_or(12);
            json_response(&core::run_search_any(&terms, limit))
        }
        "get_recent_sessions" => {
            let limit = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("limit").and_then(|l| l.as_u64()))
                .map(|l| l as usize)
                .unwrap_or(8);
            json_response(&core::recent_sessions(limit))
        }
        "read_document" => {
            let path = json_field(body, "path");
            match core::read_document(&path) {
                Ok(content) => json_response(&content),
                Err(e) => error_response(404, &e),
            }
        }
        "write_skill" => {
            let path = json_field(body, "path");
            let content = json_field(body, "content");
            match core::write_skill_file(&path, &content) {
                Ok(()) => json_response(&()),
                Err(e) => error_response(400, &e),
            }
        }
        "write_vault_file" => {
            let dir = json_field(body, "dir");
            let rel = json_field(body, "rel");
            let content = json_field(body, "content");
            match core::write_vault(&dir, &rel, &content) {
                Ok(()) => json_response(&()),
                Err(e) => error_response(400, &e),
            }
        }
        "sync_vault_git" => {
            let dir = json_field(body, "dir");
            match core::sync_vault_git_impl(&dir) {
                Ok(msg) => json_response(&msg),
                Err(e) => error_response(400, &e),
            }
        }
        "list_user_scripts" => match core::list_user_scripts_impl() {
            Ok(v) => json_response(&v),
            Err(e) => error_response(400, &e),
        },
        "run_user_script" => match core::run_user_script_impl(&json_field(body, "name")) {
            Ok(out) => json_response(&out),
            Err(e) => error_response(400, &e),
        },
        // Meeting recorder — records on THIS machine (the PC running serve),
        // so the phone works as a remote control. ponytail: recorder state is
        // per-process; a recording started in the desktop app can't be stopped
        // from here (and vice versa).
        "start_recording" => match cipher_manager_lib::recorder::start_recording() {
            Ok(sources) => json_response(&sources),
            Err(e) => error_response(400, &e),
        },
        "stop_recording" => match cipher_manager_lib::recorder::stop_recording_impl() {
            Ok(done) => json_response(&done),
            Err(e) => error_response(400, &e),
        },
        "recording_status" => json_response(&cipher_manager_lib::recorder::recording_status()),
        "transcribe_recording" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let map = |k: &str| -> std::collections::HashMap<String, String> {
                v.get(k)
                    .and_then(|x| x.as_object())
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let chunk_secs = v.get("chunkSecs").and_then(|x| x.as_u64());
            match cipher_manager_lib::recorder::transcribe_recording_impl(
                &get("path"),
                &get("url"),
                &map("headers"),
                &map("fields"),
                chunk_secs,
            ) {
                Ok(text) => json_response(&text),
                Err(e) => error_response(400, &e),
            }
        }
        "transcribe_meeting" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
            let map = |k: &str| -> std::collections::HashMap<String, String> {
                v.get(k)
                    .and_then(|x| x.as_object())
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let visuals: Vec<(f64, String)> = v
                .get("visuals")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            let speaker_hints: Vec<(f64, String)> = v
                .get("speakerHints")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            match cipher_manager_lib::recorder::transcribe_meeting_impl(
                get("micPath").as_deref(),
                get("sysPath").as_deref(),
                &get("url").unwrap_or_default(),
                &map("headers"),
                &map("fields"),
                get("fileField").as_deref(),
                &visuals,
                &speaker_hints,
            ) {
                Ok(text) => json_response(&text),
                Err(e) => error_response(400, &e),
            }
        }
        "search_vault" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let terms: Vec<String> = v
                .get("terms")
                .and_then(|t| t.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let limit =
                v.get("limit").and_then(|l| l.as_u64()).map(|l| l as usize).unwrap_or(8);
            match cipher_manager_lib::brain::search_vault_impl(&json_field(body, "dir"), &terms, limit) {
                Ok(hits) => json_response(&hits),
                Err(e) => error_response(400, &e),
            }
        }
        "vault_doctor" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let dir = v.get("dir").and_then(|x| x.as_str()).unwrap_or("").to_string();
            match cipher_manager_lib::doctor::vault_doctor_impl(&dir) {
                Ok(r) => json_response(&r),
                Err(e) => error_response(400, &e),
            }
        }
        "inbox_list" => match cipher_manager_lib::inbox::inbox_list_impl() {
            Ok(r) => json_response(&r),
            Err(e) => error_response(400, &e),
        },
        "inbox_propose" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let dir = v.get("dir").and_then(|x| x.as_str()).unwrap_or("").to_string();
            match v.get("items").cloned() {
                None => error_response(400, "missing items"),
                Some(items_v) => {
                    match serde_json::from_value::<Vec<cipher_manager_lib::inbox::NewProposal>>(items_v) {
                        Err(e) => error_response(400, &format!("bad items: {e}")),
                        Ok(items) => match cipher_manager_lib::inbox::inbox_propose_impl(&dir, items) {
                            Ok(r) => json_response(&r),
                            Err(e) => error_response(400, &e),
                        },
                    }
                }
            }
        }
        "inbox_decide" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let dir = v.get("dir").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let approve = v.get("approve").and_then(|x| x.as_bool()).unwrap_or(false);
            match cipher_manager_lib::inbox::inbox_decide_impl(&dir, &id, approve) {
                Ok(r) => json_response(&r),
                Err(e) => error_response(400, &e),
            }
        }
        "semantic_search" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let limit =
                v.get("limit").and_then(|l| l.as_u64()).map(|l| l as usize).unwrap_or(8);
            match cipher_manager_lib::brain::semantic_search_impl(
                &get("dir"),
                &get("url"),
                &get("key"),
                &get("model"),
                &get("query"),
                limit,
            ) {
                Ok(hits) => json_response(&hits),
                Err(e) => error_response(400, &e),
            }
        }
        "semantic_search_sessions" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let limit =
                v.get("limit").and_then(|l| l.as_u64()).map(|l| l as usize).unwrap_or(6);
            match cipher_manager_lib::brain::semantic_search_sessions_impl(
                &get("url"),
                &get("key"),
                &get("model"),
                &get("query"),
                limit,
            ) {
                Ok(hits) => json_response(&hits),
                Err(e) => error_response(400, &e),
            }
        }
        // Read-only vault access for the phone: meeting notes, summaries, and
        // the rescue rows on the Deck. Both impls canonicalize + confine.
        "list_vault" => match core::list_vault_impl(&json_field(body, "dir")) {
            Ok(v) => json_response(&v),
            Err(e) => error_response(400, &e),
        },
        "read_vault_file" => {
            match core::read_vault(&json_field(body, "dir"), &json_field(body, "path")) {
                Ok(s) => json_response(&s),
                Err(e) => error_response(400, &e),
            }
        }
        // Can THIS process reach the internet? Surfaces the Bitdefender
        // outbound block that silently broke the phone's live deck.
        "net_check" => {
            match ureq::get("https://api.github.com/")
                .timeout(std::time::Duration::from_secs(6))
                .call()
            {
                Ok(_) => json_response(&serde_json::json!({ "ok": true })),
                Err(e) => json_response(&serde_json::json!({ "ok": false, "error": e.to_string() })),
            }
        }
        // Presence only — set/delete are desktop-only; serve resolves the
        // real values internally when proxying, never exposing them.
        "secret_presence" => json_response(&cipher_manager_lib::secrets::secret_presence_impl()),
        // Read-only Brave bookmarks; the web client opens links in its own
        // browser, so open_in_brave stays desktop-only.
        "list_bookmarks" => match core::list_bookmarks() {
            Ok(v) => json_response(&v),
            Err(e) => error_response(400, &e),
        },
        // Cached-only (generate=false), deliberately: even with the worker
        // pool, a 15s headless-Brave run would pin one of only 4 workers per
        // thumbnail. The desktop generates; serve only reads the cache.
        "snapshot_url" => match core::snapshot_url_impl(&json_field(body, "url"), false, false) {
            Ok(v) => json_response(&v),
            Err(e) => error_response(404, &e),
        },
        "list_recordings" => match cipher_manager_lib::recorder::list_recordings_impl() {
            Ok(v) => json_response(&v),
            Err(e) => error_response(400, &e),
        },
        "docker_container" => {
            match cipher_manager_lib::recorder::docker_container_impl(
                &json_field(body, "name"),
                &json_field(body, "action"),
            ) {
                Ok(s) => json_response(&s),
                Err(e) => error_response(400, &e),
            }
        }
        "load_app_state" => {
            let key = json_field(body, "key");
            match core::read_app_state(&key) {
                Ok(v) => json_response(&v),
                Err(e) => error_response(400, &e),
            }
        }
        "save_app_state" => {
            let key = json_field(body, "key");
            let json = json_field(body, "json");
            match core::write_app_state(&key, &json) {
                Ok(()) => json_response(&()),
                Err(e) => error_response(400, &e),
            }
        }
        "save_deck_snapshot" => {
            let content = json_field(body, "content");
            match core::save_deck_snapshot_file(&content) {
                Ok(()) => json_response(&()),
                Err(e) => error_response(400, &e),
            }
        }
        "ai_proxy" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let method = v
                .get("method")
                .and_then(|x| x.as_str())
                .unwrap_or("POST")
                .to_string();
            let req_body = v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let mut headers = std::collections::HashMap::new();
            if let Some(obj) = v.get("headers").and_then(|x| x.as_object()) {
                for (k, val) in obj {
                    if let Some(s) = val.as_str() {
                        headers.insert(k.clone(), s.to_string());
                    }
                }
            }
            match core::http_proxy(url, method, headers, req_body) {
                Ok(r) => json_response(&r),
                Err(e) => error_response(502, &e),
            }
        }
        "tts_proxy" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let method = v
                .get("method")
                .and_then(|x| x.as_str())
                .unwrap_or("POST")
                .to_string();
            let req_body = v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let mut headers = std::collections::HashMap::new();
            if let Some(obj) = v.get("headers").and_then(|x| x.as_object()) {
                for (k, val) in obj {
                    if let Some(s) = val.as_str() {
                        headers.insert(k.clone(), s.to_string());
                    }
                }
            }
            match core::http_proxy_bytes(url, method, headers, req_body) {
                Ok(r) => json_response(&r),
                Err(e) => error_response(502, &e),
            }
        }
        "list_sessions" => {
            let project_id = json_field(body, "projectId");
            json_response(&core::sessions_for_project(&project_id))
        }
        "get_session" => {
            let project_id = json_field(body, "projectId");
            let session_id = json_field(body, "sessionId");
            match core::session_detail(&project_id, &session_id) {
                Ok(detail) => json_response(&detail),
                Err(e) => error_response(404, &e),
            }
        }
        "search" => {
            let query = json_field(body, "query");
            let limit = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("limit").and_then(|l| l.as_u64()))
                .map(|l| l as usize)
                .unwrap_or(200);
            json_response(&core::run_search(&query, limit))
        }
        "detect_highlights" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let path = v.get("path").and_then(|x| x.as_str()).unwrap_or("");
            let n = v.get("topN").and_then(|x| x.as_u64()).unwrap_or(10) as usize;
            match sizzle::detect_highlights_impl(path, n) {
                Ok(h) => json_response(&h),
                Err(e) => error_response(400, &e),
            }
        }
        "start_sizzle" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let src = v.get("src").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let n = v.get("topN").and_then(|x| x.as_u64()).unwrap_or(8) as usize;
            let vertical = v.get("vertical").and_then(|x| x.as_bool()).unwrap_or(false);
            let mashup = v.get("mashup").and_then(|x| x.as_bool()).unwrap_or(false);
            let out_dir = v.get("outDir").and_then(|x| x.as_str()).map(String::from);
            let ollama_url = v.get("ollamaUrl").and_then(|x| x.as_str()).map(String::from);
            let facecam = v.get("facecam").and_then(|x| serde_json::from_value(x.clone()).ok());
            let cloud = v.get("cloud").and_then(|x| serde_json::from_value(x.clone()).ok());
            let stt = v.get("stt").and_then(|x| serde_json::from_value(x.clone()).ok());
            match sizzle::start_sizzle_impl(src, n, vertical, mashup, out_dir, ollama_url, facecam, cloud, stt) {
                Ok(id) => json_response(&id),
                Err(e) => error_response(400, &e),
            }
        }
        "list_clips" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("jobId").and_then(|x| x.as_str()).unwrap_or("");
            let out_dir = v.get("outDir").and_then(|x| x.as_str());
            json_response(&sizzle::list_clips_impl(id, out_dir))
        }
        "sizzle_source" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("jobId").and_then(|x| x.as_str()).unwrap_or("");
            let out_dir = v.get("outDir").and_then(|x| x.as_str());
            match sizzle::sizzle_source_impl(id, out_dir) {
                Ok(s) => json_response(&s),
                Err(e) => error_response(400, &e),
            }
        }
        "recut_clip" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("jobId").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let start = v.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let end = v.get("end").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let out_dir = v.get("outDir").and_then(|x| x.as_str());
            match sizzle::recut_clip_impl(&id, &name, start, end, out_dir) {
                Ok(c) => json_response(&c),
                Err(e) => error_response(400, &e),
            }
        }
        "caption_clip" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let str_map = |key: &str| -> std::collections::HashMap<String, String> {
                v.get(key)
                    .and_then(|x| x.as_object())
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let id = v.get("jobId").and_then(|x| x.as_str()).unwrap_or("");
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let out_dir = v.get("outDir").and_then(|x| x.as_str());
            let stt_url = v.get("sttUrl").and_then(|x| x.as_str()).unwrap_or("");
            let file_field = v.get("fileField").and_then(|x| x.as_str()).unwrap_or("file");
            let style = v.get("style").and_then(|x| x.as_str()).unwrap_or("bold");
            match sizzle::caption_clip_impl(
                id, name, out_dir, stt_url, &str_map("sttHeaders"), &str_map("sttFields"), file_field, style,
            ) {
                Ok(c) => json_response(&c),
                Err(e) => error_response(400, &e),
            }
        }
        "make_compilation" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("jobId").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let names: Vec<String> = v
                .get("names")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let out_dir = v.get("outDir").and_then(|x| x.as_str());
            match sizzle::make_compilation_impl(&id, &names, out_dir) {
                Ok(c) => json_response(&c),
                Err(e) => error_response(400, &e),
            }
        }
        // Agent PTY sessions — interactive claude in a ConPTY, hosted here so
        // sessions outlive the desktop app and the phone can attach. Spawn is
        // gated server-side on the mirrored settings.json actingMode.
        // ponytail: sessions die with a serve restart (in-memory registry).
        "agent_spawn" => match serde_json::from_str::<cipher_manager_lib::agents::SpawnReq>(body) {
            Err(e) => error_response(400, &format!("bad request: {e}")),
            Ok(spawn_req) => match cipher_manager_lib::agents::agent_spawn_impl(spawn_req) {
                Ok(id) => json_response(&serde_json::json!({ "id": id })),
                Err(e) => error_response(400, &e),
            },
        },
        "agent_list" => json_response(&cipher_manager_lib::agents::agent_list_impl()),
        "agent_read" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let offset = v.get("offset").and_then(|x| x.as_u64()).unwrap_or(0);
            match cipher_manager_lib::agents::agent_read_impl(id, offset) {
                Ok(r) => json_response(&r),
                Err(e) => error_response(404, &e),
            }
        }
        "agent_write" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let data = v.get("dataB64").and_then(|x| x.as_str()).unwrap_or("");
            match cipher_manager_lib::agents::agent_write_impl(id, data) {
                Ok(()) => json_response(&serde_json::json!({})),
                Err(e) => error_response(400, &e),
            }
        }
        "agent_resize" => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
            let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
            match cipher_manager_lib::agents::agent_resize_impl(id, cols, rows) {
                Ok(()) => json_response(&serde_json::json!({})),
                Err(e) => error_response(400, &e),
            }
        }
        "agent_kill" => match cipher_manager_lib::agents::agent_kill_impl(&json_field(body, "id")) {
            Ok(()) => json_response(&serde_json::json!({})),
            Err(e) => error_response(404, &e),
        },
        "agent_remove" => {
            match cipher_manager_lib::agents::agent_remove_impl(&json_field(body, "id")) {
                Ok(()) => json_response(&serde_json::json!({})),
                Err(e) => error_response(404, &e),
            }
        }
        _ => error_response(404, "Unknown endpoint"),
    }
}

/// Dump a self-contained JSON snapshot to stdout (for the shareable page).
fn export_snapshot() {
    println!(
        "{}",
        serde_json::to_string(&cipher_manager_lib::snapshot::export_data()).unwrap_or_default()
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}

fn json_field(body: &str, key: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get(key).and_then(|s| s.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn json_response<T: serde::Serialize>(value: &T) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_data(body).with_header(header)
}

fn error_response(code: u16, msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&serde_json::json!({ "error": msg })).unwrap_or_default();
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_data(body).with_status_code(code).with_header(header)
}

fn serve_static(path: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    // SPA: everything that isn't a real asset falls back to index.html.
    let rel = path.trim_start_matches('/');
    let file = if rel.is_empty() {
        DIST.get_file("index.html")
    } else {
        DIST.get_file(rel).or_else(|| DIST.get_file("index.html"))
    };

    match file {
        Some(f) => {
            let name = f.path().to_str().unwrap_or("");
            let ct = content_type(name);
            let header = Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap();
            // Hashed assets are immutable; index.html must revalidate every
            // load or the phone WebView keeps showing a stale bundle.
            let cache = if name.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            let cache_header = Header::from_bytes(&b"Cache-Control"[..], cache.as_bytes()).unwrap();
            Response::from_data(f.contents().to_vec())
                .with_header(header)
                .with_header(cache_header)
        }
        None => Response::from_string("Not found").with_status_code(404),
    }
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}
