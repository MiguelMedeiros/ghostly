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

pub fn open<R: tauri::Runtime>(
    app: &AppHandle<R>,
    peer: String,
    service: String,
    title: String,
) -> Result<(), String> {
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

pub fn respond<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, response: ServiceResponse) {
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

pub fn forget_window<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) {
    if let Ok(mut windows) = app.state::<ViewerState>().windows.lock() {
        windows.remove(label);
    }
}

/// A viewer window is one contact's app in one origin. What it asks for has to
/// be that origin, or its contact would be serving code into another one.
#[cfg(test)]
mod tests {
    // covers: services.desktop-viewer
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

/// Opening a viewer, and a request's round trip through the main window.
#[cfg(test)]
mod routing_tests {
    use super::*;
    use std::sync::mpsc;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::Listener;

    const PEER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(ViewerState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn bind(app: &tauri::App<MockRuntime>, label: &str) {
        app.state::<ViewerState>()
            .windows
            .lock()
            .unwrap()
            .insert(label.into(), (PEER.into(), "atlas".into()));
    }

    /// Every request the main window is asked to carry.
    fn requests(app: &tauri::App<MockRuntime>) -> mpsc::Receiver<serde_json::Value> {
        let (tx, rx) = mpsc::channel();
        app.listen_any(REQUEST_EVENT, move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).unwrap());
        });
        rx
    }

    fn request(method: &str, url: &str, body: &[u8]) -> Request<Vec<u8>> {
        Request::builder()
            .method(method)
            .uri(url)
            .header("content-type", "text/plain")
            .body(body.to_vec())
            .unwrap()
    }

    #[test]
    fn opens_a_window_of_its_own_only_for_a_valid_contact_and_service() {
        let app = app();
        let long = "a".repeat(65);
        for (peer, service) in [
            ("", "atlas"),
            (PEER, ""),
            ("peer.evil", "atlas"),
            (PEER, "atlas/x"),
            (PEER, "at las"),
            (PEER, "ätlas"),
            (PEER, "atlas_1"),
            (long.as_str(), "atlas"),
        ] {
            assert_eq!(
                open(app.handle(), peer.into(), service.into(), "t".into()).unwrap_err(),
                "Invalid service",
                "{peer} {service}"
            );
        }
        assert!(app.webview_windows().is_empty());

        open(app.handle(), PEER.into(), "atlas".into(), "Atlas".into()).unwrap();
        open(app.handle(), PEER.into(), "notes".into(), "Notes".into()).unwrap();
        let windows = app.webview_windows();
        let mut labels: Vec<_> = windows.keys().cloned().collect();
        labels.sort();
        assert_eq!(labels, ["svc-0", "svc-1"]);
        assert_eq!(
            windows["svc-0"].url().unwrap().as_str(),
            format!("{SCHEME}://atlas.{PEER}/")
        );
        let bound = app.state::<ViewerState>().windows.lock().unwrap().clone();
        assert_eq!(bound["svc-1"], (PEER.to_string(), "notes".to_string()));
    }

    #[test]
    fn a_request_is_carried_by_the_main_window_and_its_answer_served() {
        let app = app();
        bind(&app, "svc-1");
        let asked = requests(&app);
        let pending = tauri::async_runtime::spawn(handle(
            app.handle().clone(),
            "svc-1".into(),
            request(
                "POST",
                &format!("{SCHEME}://atlas.{PEER}/api/items?x=1"),
                b"hi",
            ),
        ));
        let carried = asked.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(carried["peer"], PEER);
        assert_eq!(carried["service"], "atlas");
        assert_eq!(carried["method"], "POST");
        assert_eq!(carried["path"], "/api/items?x=1");
        assert_eq!(carried["body_b64"], STANDARD.encode(b"hi"));
        assert!(carried["headers"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(["content-type", "text/plain"])));

        respond(
            app.handle(),
            carried["id"].as_u64().unwrap(),
            ServiceResponse {
                status: 201,
                headers: vec![("x-served-by".into(), "atlas".into())],
                body_b64: STANDARD.encode(b"created"),
            },
        );
        let response = tauri::async_runtime::block_on(pending).unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()["x-served-by"], "atlas");
        assert_eq!(response.body(), b"created");
        assert!(app
            .state::<ViewerState>()
            .pending
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn nobody_answering_is_a_timeout_and_a_late_answer_goes_nowhere() {
        let app = app();
        bind(&app, "svc-1");
        let asked = requests(&app);
        // Windows and Android spell the same origin this way.
        let response = tauri::async_runtime::block_on(handle(
            app.handle().clone(),
            "svc-1".into(),
            request("GET", &format!("http://{SCHEME}.atlas.{PEER}/"), b""),
        ));
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        let carried = asked.try_recv().unwrap();
        assert!(carried["body_b64"].is_null());
        respond(
            app.handle(),
            carried["id"].as_u64().unwrap(),
            ServiceResponse {
                status: 200,
                headers: vec![],
                body_b64: String::new(),
            },
        );
        assert!(app
            .state::<ViewerState>()
            .pending
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_malformed_answer_is_a_bad_gateway_or_an_empty_body() {
        let app = app();
        bind(&app, "svc-1");
        let asked = requests(&app);
        let serve = |answer: ServiceResponse| {
            let pending = tauri::async_runtime::spawn(handle(
                app.handle().clone(),
                "svc-1".into(),
                request("GET", &format!("{SCHEME}://atlas.{PEER}/"), b""),
            ));
            let id = asked.recv_timeout(Duration::from_secs(5)).unwrap()["id"]
                .as_u64()
                .unwrap();
            respond(app.handle(), id, answer);
            tauri::async_runtime::block_on(pending).unwrap()
        };
        let bad_header = serve(ServiceResponse {
            status: 200,
            headers: vec![("bad header".into(), "x".into())],
            body_b64: String::new(),
        });
        assert_eq!(bad_header.status(), StatusCode::BAD_GATEWAY);
        let bad_status = serve(ServiceResponse {
            status: 1000,
            headers: vec![],
            body_b64: String::new(),
        });
        assert_eq!(bad_status.status(), StatusCode::BAD_GATEWAY);
        let bad_body = serve(ServiceResponse {
            status: 200,
            headers: vec![],
            body_b64: "not base64!".into(),
        });
        assert_eq!(
            (bad_body.status(), bad_body.body().len()),
            (StatusCode::OK, 0)
        );
    }

    #[test]
    fn a_closed_or_unknown_window_is_served_nothing() {
        let app = app();
        bind(&app, "svc-1");
        let asked = requests(&app);
        forget_window(app.handle(), "svc-1");
        for label in ["svc-1", "svc-2", "main"] {
            let response = tauri::async_runtime::block_on(handle(
                app.handle().clone(),
                label.into(),
                request("GET", &format!("{SCHEME}://atlas.{PEER}/"), b""),
            ));
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{label}");
        }
        assert!(asked.try_recv().is_err(), "nothing reached the main window");
    }
}
