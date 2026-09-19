//! Windows that show a web app a contact shares.
//!
//! The app gets a window and an origin of its own (`ghostly-svc://…`), never
//! the Ghostly window's: it is remote code. Every request it makes lands here,
//! is handed to the peer in the main window, travels over WebRTC to the contact
//! and comes back the same way. The window cannot call Tauri commands: the app
//! declares them in `build.rs`, so each call is checked against the
//! capabilities, which only grant them to `main`, and `main.rs` refuses every
//! invoke from another window on top of that.

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
#[cfg(not(test))]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Short here so a test that expects a request to be refused fails at once when
/// the refusal is missing, instead of waiting out the real timeout.
#[cfg(test)]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(1);

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

/// Whether a request is for the one origin its window was opened for.
///
/// Windows and Android cannot register a non-standard scheme, so wry navigates
/// to `http://<scheme>.<host>` there and turns it back before the handler sees
/// it; both spellings name the same origin, so both are accepted.
fn is_own_origin(host: Option<&str>, peer: &str, service: &str) -> bool {
    let own = format!("{}.{}", service, peer);
    match host {
        Some(host) => {
            host.eq_ignore_ascii_case(&own)
                || host.eq_ignore_ascii_case(&format!("{}.{}", SCHEME, own))
        }
        None => false,
    }
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

pub async fn handle<R: tauri::Runtime>(
    app: AppHandle<R>,
    label: String,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
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

    // The window is bound to one contact and service, and requests are routed by
    // that binding rather than by the URL. So an app that navigates or frames
    // another contact's host would still be served by its own contact, while the
    // document it gets runs in that other contact's origin, with that app's
    // storage and cookies. Refuse before anything of theirs is served there.
    if !is_own_origin(request.uri().host(), &peer, &service) {
        return plain(
            StatusCode::FORBIDDEN,
            "This window only shows the service it was opened for.",
        );
    }

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

/// A viewer window is one contact's app in one origin. What it asks for has to
/// be that origin, or its contact would be serving code into another one.
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};

    const PEER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(ViewerState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    /// The window shows `atlas` from PEER; every other host is another origin.
    fn status_for(url: &str) -> StatusCode {
        let app = app();
        app.state::<ViewerState>()
            .windows
            .lock()
            .unwrap()
            .insert("svc-1".into(), (PEER.into(), "atlas".into()));
        let request = Request::builder()
            .uri(url)
            .body(Vec::new())
            .expect("request");
        tauri::async_runtime::block_on(handle(app.handle().clone(), "svc-1".into(), request))
            .status()
    }

    #[test]
    fn another_contacts_origin_is_refused() {
        // Navigated or framed by the app this window shows: served by PEER, but
        // running as OTHER's app, which is where that app keeps its data.
        assert_eq!(
            status_for(&format!("{}://atlas.{}/", SCHEME, OTHER)),
            StatusCode::FORBIDDEN
        );
        // The same contact, a service the window was not opened for.
        assert_eq!(
            status_for(&format!("{}://notes.{}/", SCHEME, PEER)),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn its_own_origin_is_recognised() {
        let own = format!("atlas.{}", PEER);
        assert!(is_own_origin(Some(&own), PEER, "atlas"));
        // How Windows and Android spell the same origin.
        assert!(is_own_origin(
            Some(&format!("{}.{}", SCHEME, own)),
            PEER,
            "atlas"
        ));
        assert!(!is_own_origin(
            Some(&format!("atlas.{}", OTHER)),
            PEER,
            "atlas"
        ));
        assert!(!is_own_origin(Some(&format!("evil{}", own)), PEER, "atlas"));
        assert!(!is_own_origin(
            Some(&format!("{}.evil.test", own)),
            PEER,
            "atlas"
        ));
        assert!(!is_own_origin(None, PEER, "atlas"));
    }
}
