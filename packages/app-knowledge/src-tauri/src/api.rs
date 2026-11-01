//! Local HTTP API: lets other programs on THIS device (scripts, AI agents)
//! use the knowledge app with the same contract as a server's
//! `/api/claraos/knowledge/...`.
//!
//! The native side only guards and transports. Every request is handed to
//! the web side, which answers it with the same local data layer the UI uses
//! (no second implementation that could drift). Guards, all fail-closed:
//! - listens on 127.0.0.1 only, and only while switched on in the settings,
//! - `Authorization: Bearer <key>` must match (constant-time comparison),
//! - `Host` must name this loopback address and port (DNS rebinding),
//! - requests carrying an `Origin` header are refused: they come from a web
//!   page in a browser, which must never drive the app,
//! - bodies are limited in size, the web side must answer within a timeout.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

const PREFIX: &str = "/api/claraos/knowledge";
const MAX_BODY: u64 = 80 * 1024 * 1024 + 1024 * 1024;
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);

struct Running {
    port: u16,
    server: Arc<tiny_http::Server>,
}

#[derive(Default)]
pub struct ApiState {
    running: Mutex<Option<Running>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>,
    next_id: Arc<AtomicU64>,
}

/// The web side's answer to one request.
#[derive(Deserialize)]
pub struct Reply {
    status: u16,
    content_type: String,
    disposition: Option<String>,
    body_b64: String,
}

/// One request as handed to the web side.
#[derive(Serialize, Clone)]
struct Incoming {
    id: u64,
    method: String,
    path: String,
    query: String,
    content_type: String,
    body_b64: String,
}

fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header<'a>(req: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn plain(status: u16, detail: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::json!({ "detail": detail }).to_string();
    tiny_http::Response::from_data(body.into_bytes())
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap())
}

fn handle(
    mut req: tiny_http::Request,
    app: &AppHandle,
    port: u16,
    token: &str,
    pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>,
    next_id: &Arc<AtomicU64>,
) {
    let host_ok = header(&req, "Host")
        .map(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
        .unwrap_or(false);
    if !host_ok {
        let _ = req.respond(plain(421, "Unexpected Host header"));
        return;
    }
    if header(&req, "Origin").is_some() {
        let _ = req.respond(plain(403, "Requests from web pages are not allowed"));
        return;
    }
    let auth_ok = header(&req, "Authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| same(t.trim().as_bytes(), token.as_bytes()))
        .unwrap_or(false);
    if !auth_ok {
        let _ = req.respond(plain(401, "Missing or wrong API key"));
        return;
    }
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    if !(path == PREFIX || path.starts_with(&format!("{PREFIX}/"))) {
        let _ = req.respond(plain(404, "Not found"));
        return;
    }
    if req.body_length().map(|n| n as u64 > MAX_BODY).unwrap_or(false) {
        let _ = req.respond(plain(413, "Body too large"));
        return;
    }
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        let _ = req.respond(plain(413, "Body too large"));
        return;
    }

    let id = next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending.lock().unwrap().insert(id, tx);
    let incoming = Incoming {
        id,
        method: req.method().as_str().to_uppercase(),
        path: path[PREFIX.len()..].to_string(),
        query: query.to_string(),
        content_type: header(&req, "Content-Type").unwrap_or("").to_string(),
        body_b64: base64::engine::general_purpose::STANDARD.encode(&body),
    };
    if app.emit_to("main", "local-api-request", incoming).is_err() {
        pending.lock().unwrap().remove(&id);
        let _ = req.respond(plain(503, "App window not ready"));
        return;
    }
    let reply = rx.recv_timeout(ANSWER_TIMEOUT);
    pending.lock().unwrap().remove(&id);
    let Ok(reply) = reply else {
        let _ = req.respond(plain(504, "The app did not answer in time"));
        return;
    };
    let data = base64::engine::general_purpose::STANDARD
        .decode(reply.body_b64.as_bytes())
        .unwrap_or_default();
    let mut resp = tiny_http::Response::from_data(data)
        .with_status_code(reply.status)
        .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap())
        .with_header(tiny_http::Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap());
    if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", reply.content_type.as_bytes()) {
        resp = resp.with_header(h);
    }
    if let Some(d) = reply.disposition {
        if let Ok(h) = tiny_http::Header::from_bytes("Content-Disposition", d.as_bytes()) {
            resp = resp.with_header(h);
        }
    }
    let _ = req.respond(resp);
}

fn stop_running(state: &ApiState) {
    if let Some(r) = state.running.lock().unwrap().take() {
        r.server.unblock();
    }
}

/// Starts (or restarts) the API on 127.0.0.1:<port>. Returns the port.
#[tauri::command]
pub fn api_start(app: AppHandle, state: State<'_, ApiState>, port: u16, token: String) -> Result<u16, String> {
    if cfg!(mobile) {
        return Err("not available on this device".into());
    }
    if token.len() < 32 {
        return Err("key too short".into());
    }
    if port < 1024 {
        return Err("port must be 1024 or higher".into());
    }
    stop_running(&state);
    let server = Arc::new(tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| e.to_string())?);
    let worker = server.clone();
    let pending = state.pending.clone();
    let next_id = state.next_id.clone();
    std::thread::spawn(move || {
        for req in worker.incoming_requests() {
            let (app, token, pending, next_id) = (app.clone(), token.clone(), pending.clone(), next_id.clone());
            std::thread::spawn(move || handle(req, &app, port, &token, &pending, &next_id));
        }
    });
    *state.running.lock().unwrap() = Some(Running { port, server });
    Ok(port)
}

#[tauri::command]
pub fn api_stop(state: State<'_, ApiState>) {
    stop_running(&state);
}

/// Port the API currently listens on, if it runs.
#[tauri::command]
pub fn api_status(state: State<'_, ApiState>) -> Option<u16> {
    state.running.lock().unwrap().as_ref().map(|r| r.port)
}

/// The web side's answer to request `id`.
#[tauri::command]
pub fn api_respond(state: State<'_, ApiState>, id: u64, reply: Reply) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(reply);
    }
}
