//! A way in for the macOS end-to-end tests, and nothing else. WKWebView has no WebDriver, so the tests
//! that drive two Desktop apps on a Mac (e2e/desktop-macos/) reach each window's page through this: a
//! small HTTP server on 127.0.0.1 that runs a script in a window and answers with what it returned.
//!
//! It exists only in a debug build made with `--features e2e-driver` (a release build with it does not
//! compile), and only listens when the app is started with `GHOSTLY_E2E_DRIVER=<port>`. Every request
//! carries `GHOSTLY_E2E_DRIVER_TOKEN` in `x-ghostly-e2e`. The app it is built into also reads an empty
//! clipboard, so a test never sees what is on the clipboard of the machine running it.
//!
//! While it listens, a link the app would hand to the system (`commands::launch`) is written down instead of
//! opened, and `GET /opened` answers with every one so far: a test sees what a click opened, and no browser
//! starts on the machine running it.
//!
//! `GET /window` answers with what the system shows of the Ghostly window: whether it is visible, its title bar's
//! appearance, and the badge on the Dock icon.

#[cfg(all(feature = "e2e-driver", not(debug_assertions)))]
compile_error!(
    "the e2e driver is for debug builds only: `tauri build --debug --features e2e-driver`"
);

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

/// The longest a request's body may be: a script and its arguments.
const MAX_BODY: usize = 4 * 1024 * 1024;
/// How long a script may take to answer. Scripts are synchronous; the tests poll for what takes longer.
const EVAL_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether the driver listens, so links are written down rather than opened.
static RECORDING: AtomicBool = AtomicBool::new(false);
/// The links the app would have opened, in order.
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Writes down a link the app is about to open, when the driver listens. True when it did: the caller opens
/// nothing. The link has passed its command's checks already.
pub fn record_open(url: &str) -> bool {
    if !RECORDING.load(Ordering::SeqCst) {
        return false;
    }
    OPENED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(url.to_string());
    true
}

fn opened() -> Vec<String> {
    OPENED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// One request, as the tests send it.
#[derive(Debug, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub token: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Deserialize)]
struct Eval {
    /// The window's label; the Ghostly window (`main`) when left out.
    window: Option<String>,
    script: String,
}

/// Starts the driver when `GHOSTLY_E2E_DRIVER` names a port (with its token in `GHOSTLY_E2E_DRIVER_TOKEN`).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let Some(port) = std::env::var("GHOSTLY_E2E_DRIVER")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    else {
        return;
    };
    let token = std::env::var("GHOSTLY_E2E_DRIVER_TOKEN").unwrap_or_default();
    if token.is_empty() {
        eprintln!("[e2e-driver] GHOSTLY_E2E_DRIVER_TOKEN is empty: not listening");
        return;
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[e2e-driver] cannot listen on 127.0.0.1:{port}: {e}");
            return;
        }
    };
    RECORDING.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, token) = (app.clone(), token.clone());
            std::thread::spawn(move || serve(&app, &token, stream));
        }
    });
}

fn serve<R: Runtime>(app: &AppHandle<R>, token: &str, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let (status, body) = match read_request(&mut stream) {
        Err(e) => (400, error(&e)),
        Ok(request) if request.token.as_deref() != Some(token) => (403, error("wrong token")),
        Ok(request) => answer(app, &request),
    };
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Gateway Timeout",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn answer<R: Runtime>(app: &AppHandle<R>, request: &Request) -> (u16, String) {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/windows") => {
            let labels: Vec<String> = app.webview_windows().into_keys().collect();
            (200, serde_json::to_string(&labels).unwrap_or_default())
        }
        ("GET", "/opened") => (200, serde_json::to_string(&opened()).unwrap_or_default()),
        ("GET", "/window") => match app.get_webview_window("main") {
            Some(window) => (200, window_state(app, &window).to_string()),
            None => (404, error("no window main")),
        },
        ("POST", "/eval") => {
            let eval: Eval = match serde_json::from_slice(&request.body) {
                Ok(eval) => eval,
                Err(e) => return (400, error(&e.to_string())),
            };
            let label = eval.window.as_deref().unwrap_or("main");
            let Some(window) = app.get_webview_window(label) else {
                return (404, error(&format!("no window {label}")));
            };
            let (tx, rx) = mpsc::channel();
            // The callback gets the script's value as JSON, or "" when it threw or had no value.
            if let Err(e) = window.eval_with_callback(eval.script, move |value| {
                let _ = tx.send(value);
            }) {
                return (400, error(&e.to_string()));
            }
            match rx.recv_timeout(EVAL_TIMEOUT) {
                Ok(value) => (
                    200,
                    if value.is_empty() {
                        "null".into()
                    } else {
                        value
                    },
                ),
                Err(_) => (504, error("the script did not answer")),
            }
        }
        // What a person does to the Ghostly window outside the page, through the app's own handlers
        // (src/app_window.rs): its close button or Cmd+W (a close request, as `close` sends one), a click on the Dock
        // icon, a menu item (its id as a JSON string). The app under test never takes the focus, so no key press or
        // click from the system reaches it.
        ("POST", "/close") => match app.get_webview_window("main") {
            Some(window) => match window.close() {
                Ok(()) => (200, "true".into()),
                Err(e) => (400, error(&e.to_string())),
            },
            None => (404, error("no window main")),
        },
        ("POST", "/reopen") => {
            crate::app_window::show_main(app);
            (200, "true".into())
        }
        ("POST", "/menu") => {
            let id: String = match serde_json::from_slice(&request.body) {
                Ok(id) => id,
                Err(e) => return (400, error(&e.to_string())),
            };
            let handled = crate::app_window::on_menu_event(app, &id);
            (200, handled.to_string())
        }
        // An installed app's window (src/app_sandbox.rs), the only way to open one until the marketplace lands:
        // `{"app", "entry", "guard"}`, where `guard` is `full` (as the app will), or, for the sandbox spike's
        // controls, `header` (no navigation lock) or `control` (no policy either). Answers the window's label.
        ("POST", "/app-open") => {
            #[derive(Deserialize)]
            struct Open {
                app: String,
                entry: String,
                guard: Option<String>,
            }
            let open: Open = match serde_json::from_slice(&request.body) {
                Ok(open) => open,
                Err(e) => return (400, error(&e.to_string())),
            };
            use crate::app_sandbox::Guard;
            let guard = match open.guard.as_deref().unwrap_or("full") {
                "full" => Guard::Full,
                "header" => Guard::HeaderOnly,
                "control" => Guard::Control,
                other => return (400, error(&format!("no guard {other}"))),
            };
            match crate::app_sandbox::open_guarded(app, open.app, open.entry, guard) {
                Ok(label) => (200, serde_json::to_string(&label).unwrap_or_default()),
                Err(e) => (400, error(&e)),
            }
        }
        // What an app window was refused so far: navigations and new windows. Body: the label, as a JSON string.
        ("POST", "/app-refused") => {
            let label: String = match serde_json::from_slice(&request.body) {
                Ok(label) => label,
                Err(e) => return (400, error(&e.to_string())),
            };
            match crate::app_sandbox::refused(app, &label) {
                Some(refused) => (200, serde_json::to_string(&refused).unwrap_or_default()),
                None => (404, error(&format!("no app window {label}"))),
            }
        }
        _ => (404, error("no such route")),
    }
}

/// What the system shows of the Ghostly window, as a person at the Mac would see it: whether it is on screen, the
/// appearance its title bar has (`light` or `dark`), and the label on the app's Dock icon (`null` when none).
fn window_state<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> serde_json::Value {
    let theme = match window.theme() {
        Ok(tauri::Theme::Dark) => Some("dark"),
        Ok(_) => Some("light"),
        Err(_) => None,
    };
    serde_json::json!({
        "visible": window.is_visible().ok(),
        "theme": theme,
        "badge": dock_badge(app),
    })
}

/// The label on the Dock icon, read where AppKit wants it: on the main thread.
#[cfg(target_os = "macos")]
fn dock_badge<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let label = objc2_foundation::MainThreadMarker::new().and_then(|mtm| {
            objc2_app_kit::NSApplication::sharedApplication(mtm)
                .dockTile()
                .badgeLabel()
                .map(|label| label.to_string())
        });
        let _ = tx.send(label);
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(5)).ok().flatten()
}

#[cfg(not(target_os = "macos"))]
fn dock_badge<R: Runtime>(_app: &AppHandle<R>) -> Option<String> {
    None
}

fn error(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

/// One HTTP/1.1 request: the request line, the token header and a body of `content-length` bytes.
pub fn read_request(stream: impl Read) -> Result<Request, String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
        return Err("no request line".into());
    };
    let (method, path) = (method.to_string(), path.to_string());
    let (mut length, mut token) = (0usize, None);
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("the headers never ended".into());
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Err(format!("not a header: {header}"));
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().map_err(|_| "bad content-length")?,
            "x-ghostly-e2e" => token = Some(value.trim().to_string()),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Err("body too large".into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(Request {
        method,
        path,
        token,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_method_path_token_and_body() {
        let raw = b"POST /eval HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Ghostly-E2E: secret\r\nContent-Length: 5\r\n\r\nhello";
        let request = read_request(&raw[..]).unwrap();
        assert_eq!(
            request,
            Request {
                method: "POST".into(),
                path: "/eval".into(),
                token: Some("secret".into()),
                body: b"hello".to_vec()
            }
        );
    }

    #[test]
    fn a_request_without_a_token_or_body_reads_as_such() {
        let request = read_request(&b"GET /windows HTTP/1.1\r\n\r\n"[..]).unwrap();
        assert_eq!((request.token, request.body.len()), (None, 0));
    }

    #[test]
    fn links_are_written_down_only_while_the_driver_listens() {
        // covers: app.external-links
        assert!(!record_open("https://example.com/before"));
        assert!(
            opened().is_empty(),
            "nothing is written down before the driver listens"
        );
        RECORDING.store(true, Ordering::SeqCst);
        assert!(record_open("https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo"));
        assert!(record_open("https://github.com/MiguelMedeiros/ghostly"));
        assert_eq!(
            opened(),
            [
                "https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo",
                "https://github.com/MiguelMedeiros/ghostly"
            ]
        );
    }

    #[test]
    fn refuses_what_is_not_a_request() {
        assert!(read_request(&b""[..]).is_err());
        assert!(read_request(&b"GET /windows HTTP/1.1\r\nno colon\r\n\r\n"[..]).is_err());
        assert!(
            read_request(&b"GET / HTTP/1.1\r\nHost: x\r\n"[..]).is_err(),
            "headers that never end"
        );
        let huge = format!(
            "POST /eval HTTP/1.1\r\ncontent-length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(read_request(huge.as_bytes()).is_err());
        assert!(
            read_request(&b"POST /eval HTTP/1.1\r\ncontent-length: 10\r\n\r\nshort"[..]).is_err()
        );
    }
}
