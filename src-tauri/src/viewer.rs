//! Windows that show a web app a contact shares.
//!
//! The app gets a window and an origin of its own (`ghostly-svc://…`), never
//! the Ghostly window's: it is remote code. Every request it makes lands here,
//! is handed to the peer in the main window, travels over WebRTC to the contact
//! and comes back the same way. The window has no access to Tauri commands,
//! because capabilities are only granted to the `main` window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

pub const SCHEME: &str = "ghostly-svc";
const REQUEST_EVENT: &str = "ghostly-svc-request";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct ViewerState {
    /// Window label → (peer public key, service id). The window decides where a request goes, not its URL.
    windows: Mutex<HashMap<String, (String, String)>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<ServiceResponse>>>,
    next_id: AtomicU64,
}

#[derive(Clone, Serialize)]
struct ServiceRequest {
    id: u64,
    peer: String,
    service: String,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ServiceResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_b64: String,
}

fn is_label_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn open(app: &AppHandle, peer: String, service: String, title: String) -> Result<(), String> {
    if !is_label_safe(&peer) || !is_label_safe(&service) {
        return Err("Invalid service".into());
    }
    let state = app.state::<ViewerState>();
    let label = format!("svc-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    state
        .windows
        .lock()
        .map_err(|_| "viewer state poisoned")?
        .insert(label.clone(), (peer.clone(), service.clone()));

    // One origin per contact and service keeps their storage apart.
    let url = format!("{}://{}.{}/", SCHEME, service, peer)
        .parse()
        .map_err(|e| format!("URL: {}", e))?;
    WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
        .title(format!("{} — Ghostly", title))
        .inner_size(1100.0, 760.0)
        .build()
        .map_err(|e| format!("Window: {}", e))?;
    Ok(())
}

pub fn respond(app: &AppHandle, id: u64, response: ServiceResponse) {
    if let Ok(mut pending) = app.state::<ViewerState>().pending.lock() {
        if let Some(sender) = pending.remove(&id) {
            let _ = sender.send(response);
        }
    }
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("static response")
}

pub async fn handle(app: AppHandle, label: String, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<ViewerState>();
    let Some((peer, service)) = state
        .windows
        .lock()
        .ok()
        .and_then(|w| w.get(&label).cloned())
    else {
        return plain(
            StatusCode::FORBIDDEN,
            "This window does not show a Ghostly service.",
        );
    };

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut pending) = state.pending.lock() {
        pending.insert(id, sender);
    }

    let uri = request.uri();
    let path = match uri.query() {
        Some(query) => format!("{}?{}", uri.path(), query),
        None => uri.path().to_string(),
    };
    let payload = ServiceRequest {
        id,
        peer,
        service,
        method: request.method().to_string(),
        path,
        headers: request
            .headers()
            .iter()
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
            .collect(),
        body_b64: (!request.body().is_empty()).then(|| STANDARD.encode(request.body())),
    };
    if app.emit_to("main", REQUEST_EVENT, payload).is_err() {
        return plain(StatusCode::BAD_GATEWAY, "Ghostly is not running.");
    }

    let answer = tokio::time::timeout(REQUEST_TIMEOUT, receiver).await;
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&id);
    }
    let Ok(Ok(answer)) = answer else {
        return plain(
            StatusCode::GATEWAY_TIMEOUT,
            "This service is not reachable. Services exist while their ghost is online.",
        );
    };

    let mut response = Response::builder().status(answer.status);
    for (name, value) in &answer.headers {
        response = response.header(name.as_str(), value.as_str());
    }
    response
        .body(STANDARD.decode(answer.body_b64).unwrap_or_default())
        .unwrap_or_else(|_| {
            plain(
                StatusCode::BAD_GATEWAY,
                "The service sent an invalid response.",
            )
        })
}

pub fn forget_window(app: &AppHandle, label: &str) {
    if let Ok(mut windows) = app.state::<ViewerState>().windows.lock() {
        windows.remove(label);
    }
}
