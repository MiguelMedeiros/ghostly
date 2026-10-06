//! Windows that run an installed mini-app (WISP 12xx, "Where it runs"). The spike for Ghostly 1.2's
//! marketplace: nothing in the app opens one yet; only the macOS test driver does (`e2e_driver.rs`, debug
//! builds with `--features e2e-driver`), so the sandbox can be measured before any feature leans on it.
//!
//! - One window per app instance, labelled `app-<random>`. Rust keeps label → app; the app's identity is
//!   that binding, never anything the page says.
//! - The window loads the runner from the `ghostly-app` scheme, with the runner's CSP as an HTTP header: the
//!   `sandbox` directive gives the page an opaque origin (`"null"`), no storage and no network.
//! - The runner asks `app_broker` for the app's entry (`start`), says `writing`, and writes the entry into
//!   itself. `app_broker` is the only command an `app-*` window may call (`only_main` in `main.rs`, and the
//!   capability in `capabilities/app.json`).
//! - The window never leaves the runner: every navigation after the first load is refused, and new windows
//!   are denied without opening the system browser (for an app, a link out is a way to send data out).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const SCHEME: &str = "ghostly-app";
/// Every app window's label starts with this; nothing else may call `app_broker`.
pub const LABEL_PREFIX: &str = "app-";

/// The runner's policy (WISP 12xx, "The runner's CSP"), sent as a header so `sandbox` holds even if the page
/// is opened some other way. Tauri's configured CSP is not added to a custom scheme's responses.
pub const RUNNER_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; \
media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; \
form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/// The largest request an app may send the broker (WISP 12xx: 64 KiB).
const MAX_REQUEST_BYTES: usize = 64 * 1024;

/// The runner, shipped inside the app, never fetched. It deletes the WebRTC constructors before any app
/// code, refuses to start outside an `app-*` window or with an origin that is not opaque, then writes the
/// entry `app_broker` hands it into itself.
const RUNNER: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><title>Ghostly app</title>
<script>
(() => {
  "use strict";
  for (const name of Object.getOwnPropertyNames(window)) {
    if (/^(webkit)?RTC/.test(name)) { try { delete window[name]; } catch (e) {} }
  }
  const internals = window.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  if (self.origin !== "null" || !internals || typeof label !== "string" || !label.startsWith("app-")) {
    document.documentElement.textContent = "This app cannot run here.";
    return;
  }
  const invoke = internals.invoke.bind(internals);
  const broker = (type, args) => invoke("app_broker", { request: { type, args: args === undefined ? null : args } });
  Object.defineProperty(window, "ghostly", { value: Object.freeze({
    context: () => broker("context"),
    close: () => broker("close"),
  }) });
  broker("start").then((entry) => broker("writing").then(() => {
    document.open();
    document.write(entry);
    document.close();
  })).catch((error) => { document.documentElement.textContent = "This app could not start: " + error; });
})();
</script></head><body></body></html>"#;

/// How a window is guarded: one switch per layer. Apps always get `Guard::FULL`; the test driver can turn
/// layers off, which is how the spike shows what each one stops (`Guard::parse`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Guard {
    /// The runner's CSP header (and the runner's own check that its origin is `"null"`).
    header: bool,
    /// The navigation lock: the runner once, then nothing (frames included).
    lock: bool,
    /// macOS: a content rule list that blocks every load but `ghostly-app:` (`webkit`).
    rules: bool,
    /// macOS: WebKit's preconnect, DNS prefetch and WebRTC switched off for the window (`webkit`).
    prefs: bool,
    /// A proxy that goes nowhere, with a data store of its own. Measured, not used: WKWebView never sent a
    /// request to it (macOS 15.6); kept for the test driver so Linux can be measured the same way.
    proxy: bool,
}

impl Guard {
    pub const FULL: Guard = Guard {
        header: true,
        lock: true,
        rules: true,
        prefs: true,
        proxy: false,
    };

    /// `full`, `control` (nothing), or layers joined by `+`: `header`, `lock`, `rules`, `prefs`, `proxy`.
    #[cfg(any(test, feature = "e2e-driver"))]
    pub fn parse(name: &str) -> Option<Guard> {
        if name == "full" {
            return Some(Guard::FULL);
        }
        let mut guard = Guard {
            header: false,
            lock: false,
            rules: false,
            prefs: false,
            proxy: false,
        };
        if name == "control" {
            return Some(guard);
        }
        for layer in name.split('+') {
            match layer {
                "header" => guard.header = true,
                "lock" => guard.lock = true,
                "rules" => guard.rules = true,
                "prefs" => guard.prefs = true,
                "proxy" => guard.proxy = true,
                _ => return None,
            }
        }
        Some(guard)
    }
}

/// The spike's proxy that goes nowhere: it answers every request with 403, connects nowhere, and writes down
/// what it was asked for (`caught`).
#[cfg(any(test, feature = "e2e-driver"))]
fn black_hole() -> Option<u16> {
    use std::io::{BufRead, BufReader, Write};
    static PORT: std::sync::OnceLock<Option<u16>> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        let port = listener.local_addr().ok()?.port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                let mut line = String::new();
                let _ = BufReader::new(&stream).read_line(&mut line);
                let target = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                if let Ok(mut caught) = CAUGHT.lock() {
                    if caught.len() < 256 {
                        caught.push(target);
                    }
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
            }
        });
        Some(port)
    })
}

#[cfg(any(test, feature = "e2e-driver"))]
static CAUGHT: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// What the spike's proxy was asked for, so far.
#[cfg(any(test, feature = "e2e-driver"))]
#[cfg_attr(not(feature = "e2e-driver"), allow(dead_code))]
pub fn caught() -> Vec<String> {
    CAUGHT.lock().map(|c| c.clone()).unwrap_or_default()
}

struct AppWindow {
    /// The app this window runs: its reference (`<publisher>/<name>` once bundles exist).
    app: String,
    /// The verified entry, handed over once on `start`.
    entry: Option<String>,
    started: bool,
    guard: Guard,
    /// What the window was refused (navigations and new windows), for the spike's measurements.
    refused: Vec<String>,
}

#[derive(Default)]
pub struct AppSandboxState {
    windows: Mutex<HashMap<String, AppWindow>>,
}

impl AppSandboxState {
    fn with<T>(&self, label: &str, f: impl FnOnce(&mut AppWindow) -> T) -> Option<T> {
        self.windows.lock().ok()?.get_mut(label).map(f)
    }
}

/// Whether `label` names an app window. Exactly the prefix and something after it.
pub fn is_app_label(label: &str) -> bool {
    label.len() > LABEL_PREFIX.len()
        && label.starts_with(LABEL_PREFIX)
        && label[LABEL_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric())
}

/// Whether `url` is the runner, in either spelling: `ghostly-app://localhost/` on macOS and Linux, and
/// `http://ghostly-app.localhost/` (or `https://`) where wry cannot register a scheme (Windows, Android).
/// The host is `localhost` so Tauri takes the page for a local one on every platform.
pub fn is_runner(url: &url::Url) -> bool {
    let at_root = url.path() == "/" && url.query().is_none() && url.fragment().is_none();
    let host = url.host_str().unwrap_or_default();
    at_root
        && url.username().is_empty()
        && url.port().is_none()
        && match url.scheme() {
            SCHEME => host.eq_ignore_ascii_case("localhost"),
            "http" | "https" => host.eq_ignore_ascii_case(&format!("{SCHEME}.localhost")),
            _ => false,
        }
}

/// The window may go to the runner once, to load it, and nowhere after that: not a reload (a second start),
/// not another page, not a frame of any kind. Before the first load, nothing else either.
fn may_navigate(url: &url::Url, started: bool) -> bool {
    !started && is_runner(url)
}

/// Opens an app in a window of its own and answers its label. Nothing calls it yet: the Apps screen will,
/// from an async command (on macOS the window is built on the main thread, so this must not run there).
#[allow(dead_code)]
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    app_id: String,
    entry: String,
) -> Result<String, String> {
    open_guarded(app, app_id, entry, Guard::FULL)
}

pub fn open_guarded<R: Runtime>(
    app: &AppHandle<R>,
    app_id: String,
    entry: String,
    guard: Guard,
) -> Result<String, String> {
    let label = format!("{LABEL_PREFIX}{:016x}", rand::random::<u64>());
    app.state::<AppSandboxState>()
        .windows
        .lock()
        .map_err(|_| "app state poisoned")?
        .insert(
            label.clone(),
            AppWindow {
                app: app_id.clone(),
                entry: Some(entry),
                started: false,
                guard,
                refused: Vec::new(),
            },
        );
    let built = build_window(app, &label, &app_id, guard);
    if let Err(e) = built {
        forget_window(app, &label);
        return Err(e);
    }
    Ok(label)
}

/// The window, with every layer that does not depend on the platform.
fn window_builder<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    label: &str,
    app_id: &str,
    guard: Guard,
) -> Result<WebviewWindowBuilder<'a, R, AppHandle<R>>, String> {
    let url = format!("{SCHEME}://localhost/")
        .parse()
        .map_err(|e| format!("URL: {e}"))?;
    let (nav_app, nav_label) = (app.clone(), label.to_string());
    let (new_app, new_label) = (app.clone(), label.to_string());
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(url))
        .title(format!("{app_id} (Ghostly)"))
        .on_navigation(move |to| {
            nav_app
                .state::<AppSandboxState>()
                .with(&nav_label, |window| {
                    let allowed = !window.guard.lock || may_navigate(to, window.started);
                    if !allowed {
                        window.refused.push(format!("navigation {to}"));
                    }
                    allowed
                })
                .unwrap_or(false)
        })
        // Never a window, never the system browser.
        .on_new_window(move |to, _| {
            new_app
                .state::<AppSandboxState>()
                .with(&new_label, |window| {
                    window.refused.push(format!("new window {to}"))
                });
            tauri::webview::NewWindowResponse::Deny
        })
        .inner_size(480.0, 360.0);
    #[cfg(any(test, feature = "e2e-driver"))]
    if guard.proxy {
        let port = black_hole().ok_or("No proxy")?;
        builder = builder.incognito(true).proxy_url(
            format!("http://127.0.0.1:{port}")
                .parse()
                .map_err(|e| format!("URL: {e}"))?,
        );
    }
    #[cfg(not(any(test, feature = "e2e-driver")))]
    let _ = guard;
    Ok(builder)
}

#[cfg(any(not(target_os = "macos"), test))]
fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    app_id: &str,
    guard: Guard,
) -> Result<(), String> {
    window_builder(app, label, app_id, guard)?
        .build()
        .map(|_| ())
        .map_err(|e| format!("Window: {e}"))
}

/// On macOS the window gets a WebKit configuration of its own (`webkit`), which has to be made and used on
/// the main thread; this waits for it there.
#[cfg(all(target_os = "macos", not(test)))]
fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    app_id: &str,
    guard: Guard,
) -> Result<(), String> {
    if objc2_foundation::MainThreadMarker::new().is_some() {
        return Err("Open apps from a command, not the main thread".into());
    }
    if guard.rules {
        webkit::compile_rules(app)?;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let (handle, label, app_id) = (app.clone(), label.to_string(), app_id.to_string());
    app.run_on_main_thread(move || {
        let built = (|| {
            let mut builder = window_builder(&handle, &label, &app_id, guard)?;
            if guard.rules || guard.prefs {
                builder = builder.with_webview_configuration(webkit::configuration(guard)?);
            }
            builder
                .build()
                .map(|_| ())
                .map_err(|e| format!("Window: {e}"))
        })();
        let _ = tx.send(built);
    })
    .map_err(|e| format!("Window: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "The window did not open".to_string())?
}

/// What a window was refused so far (the spike's measurements read it).
#[cfg_attr(not(feature = "e2e-driver"), allow(dead_code))]
pub fn refused<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Vec<String>> {
    app.state::<AppSandboxState>()
        .with(label, |window| window.refused.clone())
}

pub fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(state) = app.try_state::<AppSandboxState>() {
        if let Ok(mut windows) = state.windows.lock() {
            windows.remove(label);
        }
    }
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .body(message.as_bytes().to_vec())
        .expect("static response")
}

/// The `ghostly-app` scheme: the runner, to an app window, at its one address. Nothing else is served; an
/// app's files come through `app_broker`.
pub fn handle<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let Some(guard) = app
        .state::<AppSandboxState>()
        .with(label, |window| window.guard)
        .filter(|_| is_app_label(label))
    else {
        return plain(StatusCode::FORBIDDEN, "Not an app window.");
    };
    let runner = url::Url::parse(&request.uri().to_string()).is_ok_and(|url| is_runner(&url));
    if request.method() != tauri::http::Method::GET || !runner {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    }
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/html; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-store");
    if guard.header {
        response = response.header("content-security-policy", RUNNER_CSP);
    }
    #[cfg(any(test, feature = "e2e-driver"))]
    let runner = if !guard.header {
        RUNNER.replace(r#"self.origin !== "null" || "#, "")
    } else {
        RUNNER.to_string()
    };
    #[cfg(not(any(test, feature = "e2e-driver")))]
    let runner = RUNNER;
    response
        .body(runner.as_bytes().to_vec())
        .expect("runner response")
}

#[derive(Debug, Deserialize)]
pub struct BrokerRequest {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    args: Value,
}

/// What the broker answers an app window. `label` is the caller's, as Tauri knows it; the request carries no
/// identity, and anything in it that looks like one is ignored.
pub fn broker(
    state: &AppSandboxState,
    label: &str,
    request: BrokerRequest,
) -> Result<Value, String> {
    if !is_app_label(label) {
        return Err("Not an app window".into());
    }
    if serde_json::to_vec(&request.args).map_or(true, |args| args.len() > MAX_REQUEST_BYTES) {
        return Err("Request too large".into());
    }
    state
        .with(label, |window| match request.kind.as_str() {
            // The entry, once: a second start (a reload that got through) is refused.
            "start" if !window.started => {
                window.started = true;
                window
                    .entry
                    .take()
                    .map(Value::String)
                    .ok_or("No entry".to_string())
            }
            "start" => Err("Already started".into()),
            "writing" if window.started => Ok(Value::Null),
            "context" => Ok(json!({ "app": window.app, "window": label })),
            _ => Err("Unknown request".into()),
        })
        .unwrap_or_else(|| Err("Not an app window".into()))
}

/// The one command an app window may call (`only_main` lets it through from `app-*` windows only).
#[tauri::command]
pub fn app_broker<R: Runtime>(
    webview: tauri::Webview<R>,
    state: tauri::State<'_, AppSandboxState>,
    request: BrokerRequest,
) -> Result<Value, String> {
    broker(&state, webview.label(), request)
}

/// The content rule list of an app window on macOS: every load blocked but the runner's own scheme.
const RULES_ID: &str = "ghostly-app-sandbox-1";
const RULES: &str = r#"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ghostly-app:"},"action":{"type":"ignore-previous-rules"}}]"#;

/// The WebKit features an app window has off on macOS: `<link rel=preconnect>` (and in Early Hints), DNS
/// prefetch, `<link rel=prefetch>`, and WebRTC itself, which also reaches frames the runner never ran in.
const OFF: &[&str] = &[
    "DNSPrefetchingEnabled",
    "LinkPreconnect",
    "LinkPreconnectEarlyHintsEnabled",
    "LinkPrefetchEnabled",
    "PeerConnectionEnabled",
];

/// The WebKit side of an app window on macOS: what the CSP does not govern there. Measured (WISP 12xx, Desktop
/// spike): `<link rel=preconnect>` opened a TCP connection under the runner's full policy.
/// - A content rule list that blocks every load but `ghostly-app:` (public API).
/// - WebKit's own switches (`WKPreferences._features`, private API, as Ghostly ships outside the App Store):
///   `OFF` below. A WebKit without one of them opens no app, so a rename shows up as a refusal, not a leak.
#[cfg(target_os = "macos")]
#[cfg_attr(test, allow(dead_code))]
mod webkit {
    use super::Guard;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::{NSArray, NSError, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebViewConfiguration};
    use std::cell::RefCell;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Runtime};

    use super::{OFF, RULES, RULES_ID};

    thread_local! {
        /// Compiled once, on the main thread, where WebKit wants it.
        static RULE_LIST: RefCell<Option<Retained<WKContentRuleList>>> = const { RefCell::new(None) };
    }

    /// Compiles the rule list, once, and waits for it. Not on the main thread, where WebKit answers.
    pub fn compile_rules<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        static COMPILED: OnceLock<Result<(), String>> = OnceLock::new();
        COMPILED
            .get_or_init(|| {
                let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
                app.run_on_main_thread(move || {
                    let Some(mtm) = MainThreadMarker::new() else {
                        let _ = tx.send(Err("not the main thread".into()));
                        return;
                    };
                    let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
                        let _ = tx.send(Err("no rule list store".into()));
                        return;
                    };
                    let done = block2::RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
                        let answer = match unsafe { Retained::retain(list) } {
                            Some(list) => {
                                RULE_LIST.with(|slot| *slot.borrow_mut() = Some(list));
                                Ok(())
                            }
                            None => Err(unsafe { error.as_ref() }
                                .map(|e| e.localizedDescription().to_string())
                                .unwrap_or_else(|| "rule list not compiled".into())),
                        };
                        let _ = tx.send(answer);
                    });
                    unsafe {
                        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                            Some(&NSString::from_str(RULES_ID)),
                            Some(&NSString::from_str(RULES)),
                            Some(&done),
                        );
                    }
                })
                .map_err(|e| e.to_string())?;
                rx.recv_timeout(std::time::Duration::from_secs(10))
                    .map_err(|_| "rule list not compiled in time".to_string())?
            })
            .clone()
    }

    /// Every WebKit feature this WebKit knows: its key and the `_WKFeature` itself.
    pub fn features() -> Vec<(String, Retained<AnyObject>)> {
        let Some(class) = AnyClass::get(c"WKPreferences") else {
            return Vec::new();
        };
        let list: Option<Retained<NSArray<AnyObject>>> = unsafe { msg_send![class, _features] };
        list.map(|list| {
            list.iter()
                .map(|feature| {
                    let key: Retained<NSString> = unsafe { msg_send![&*feature, key] };
                    (key.to_string(), feature)
                })
                .collect()
        })
        .unwrap_or_default()
    }

    /// The keys of WebKit features whose name says preconnect, prefetch or WebRTC (the spike's list).
    pub fn candidates() -> Vec<String> {
        features()
            .into_iter()
            .map(|(key, _)| key)
            .filter(|key| {
                let key = key.to_ascii_lowercase();
                ["preconnect", "prefetch", "peerconnection", "webrtc", "dns"]
                    .iter()
                    .any(|word| key.contains(word))
            })
            .collect()
    }

    /// The window's configuration: made here, on the main thread, and handed to wry.
    pub fn configuration(guard: Guard) -> Result<Retained<WKWebViewConfiguration>, String> {
        let mtm = MainThreadMarker::new().ok_or("not the main thread")?;
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        if guard.rules {
            let list = RULE_LIST
                .with(|slot| slot.borrow().clone())
                .ok_or("rule list not compiled")?;
            unsafe { config.userContentController().addContentRuleList(&list) };
        }
        if guard.prefs {
            let preferences = unsafe { config.preferences() };
            let features = features();
            for key in OFF {
                let (_, feature) = features
                    .iter()
                    .find(|(k, _)| k == key)
                    .ok_or_else(|| format!("WebKit has no {key}"))?;
                let _: () = unsafe {
                    msg_send![&*preferences, _setEnabled: Bool::NO, forFeature: &**feature]
                };
            }
        }
        Ok(config)
    }
}

/// The WebKit features the spike looks at (macOS), for the test driver.
#[cfg(feature = "e2e-driver")]
pub fn webkit_candidates() -> Vec<String> {
    #[cfg(target_os = "macos")]
    return webkit::candidates();
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

#[cfg(test)]
mod tests {
    // covers: apps.desktop-sandbox
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(AppSandboxState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn url(value: &str) -> url::Url {
        url::Url::parse(value).unwrap()
    }

    fn request(kind: &str, args: Value) -> BrokerRequest {
        BrokerRequest {
            kind: kind.into(),
            args,
        }
    }

    #[test]
    fn app_labels_are_the_prefix_and_a_name() {
        for label in ["app-1", "app-0123456789abcdef", "app-X"] {
            assert!(is_app_label(label), "{label}");
        }
        for label in [
            "app-", "app", "apps-1", "xapp-1", "App-1", "main", "svc-1", "app-1/2", "app-1-2",
            "app-é",
        ] {
            assert!(!is_app_label(label), "{label}");
        }
    }

    #[test]
    fn the_runner_has_one_address_in_two_spellings() {
        for runner in [
            "ghostly-app://localhost/",
            "ghostly-app://LOCALHOST/",
            "http://ghostly-app.localhost/",
            "https://ghostly-app.localhost/",
        ] {
            assert!(is_runner(&url(runner)), "{runner}");
        }
        for other in [
            "ghostly-app://localhost/x",
            "ghostly-app://localhost/?a=1",
            "ghostly-app://localhost/#top",
            "ghostly-app://other/",
            "ghostly-app://localhost:1/",
            "ghostly-app://u@localhost/",
            "http://ghostly-app.localhost/index.html",
            "http://ghostly-app.localhost:8080/",
            "http://ghostly-app.localhost.evil.test/",
            "http://localhost/",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "ghostly-svc://atlas.peer/",
            "about:blank",
            "about:srcdoc",
            "data:text/html,x",
            "javascript:alert(1)",
            "blob:ghostly-app://localhost/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        ] {
            assert!(!is_runner(&url(other)), "{other}");
        }
    }

    #[test]
    fn the_window_goes_to_the_runner_once_and_nowhere_else() {
        assert!(may_navigate(&url("ghostly-app://localhost/"), false));
        assert!(may_navigate(&url("http://ghostly-app.localhost/"), false));
        // A reload after the entry was handed over, and every other page or frame, before or after.
        assert!(!may_navigate(&url("ghostly-app://localhost/"), true));
        for other in [
            "about:blank",
            "about:srcdoc",
            "https://example.com/",
            "http://127.0.0.1:4310/",
            "tauri://localhost/",
            "data:text/html,x",
        ] {
            assert!(!may_navigate(&url(other), false), "{other}");
            assert!(!may_navigate(&url(other), true), "{other}");
        }
    }

    #[test]
    fn the_runner_is_served_with_its_policy_to_an_app_window_only() {
        let app = app();
        let label = "app-1";
        app.state::<AppSandboxState>()
            .windows
            .lock()
            .unwrap()
            .insert(
                label.into(),
                AppWindow {
                    app: "ana/chess".into(),
                    entry: Some("<p>hi</p>".into()),
                    started: false,
                    guard: Guard::FULL,
                    refused: Vec::new(),
                },
            );
        let get = |label: &str, uri: &str| {
            let request = Request::builder().uri(uri).body(Vec::new()).unwrap();
            handle(app.handle(), label, &request)
        };
        let served = get(label, "ghostly-app://localhost/");
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(served.headers()["content-security-policy"], RUNNER_CSP);
        assert_eq!(served.headers()["x-content-type-options"], "nosniff");
        assert!(String::from_utf8_lossy(served.body()).contains("app_broker"));
        assert_eq!(
            get(label, "http://ghostly-app.localhost/").status(),
            StatusCode::OK
        );
        assert_eq!(
            get(label, "ghostly-app://localhost/x.js").status(),
            StatusCode::NOT_FOUND
        );
        for other in ["main", "svc-1", "app-2"] {
            assert_eq!(
                get(other, "ghostly-app://localhost/").status(),
                StatusCode::FORBIDDEN,
                "{other}"
            );
        }
    }

    #[test]
    fn the_policy_is_the_wisps() {
        for directive in [
            "sandbox allow-scripts;",
            "default-src 'none';",
            "script-src 'unsafe-inline' 'wasm-unsafe-eval';",
            "connect-src 'none';",
            "frame-src 'none';",
            "worker-src 'none';",
            "form-action 'none';",
            "base-uri 'none';",
            "frame-ancestors 'self'",
        ] {
            assert!(RUNNER_CSP.contains(directive), "{directive}");
        }
        assert!(!RUNNER_CSP.contains("allow-same-origin"));
        assert!(!RUNNER_CSP.contains("allow-top-navigation"));
        assert!(!RUNNER_CSP.contains("allow-popups"));
        assert!(!RUNNER_CSP.contains("allow-forms"));
    }

    #[test]
    fn the_broker_knows_the_caller_by_its_window_and_hands_the_entry_over_once() {
        let state = AppSandboxState::default();
        for (label, app) in [("app-1", "ana/chess"), ("app-2", "bob/snake")] {
            state.windows.lock().unwrap().insert(
                label.into(),
                AppWindow {
                    app: app.into(),
                    entry: Some(format!("<p>{app}</p>")),
                    started: false,
                    guard: Guard::FULL,
                    refused: Vec::new(),
                },
            );
        }
        // An app that names another app, or another window, is still itself.
        let context = broker(
            &state,
            "app-1",
            request("context", json!({"app": "bob/snake", "window": "app-2"})),
        )
        .unwrap();
        assert_eq!(context, json!({"app": "ana/chess", "window": "app-1"}));
        assert_eq!(
            broker(&state, "app-2", request("context", Value::Null)).unwrap()["app"],
            "bob/snake"
        );

        assert_eq!(
            broker(&state, "app-1", request("writing", Value::Null)).unwrap_err(),
            "Unknown request"
        );
        assert_eq!(
            broker(&state, "app-1", request("start", Value::Null)).unwrap(),
            json!("<p>ana/chess</p>")
        );
        assert_eq!(
            broker(&state, "app-1", request("start", Value::Null)).unwrap_err(),
            "Already started"
        );
        assert!(broker(&state, "app-1", request("writing", Value::Null)).is_ok());
        assert_eq!(
            broker(&state, "app-1", request("storage.get", json!("k"))).unwrap_err(),
            "Unknown request"
        );

        for label in ["main", "svc-1", "app-3", "app-"] {
            assert_eq!(
                broker(&state, label, request("context", Value::Null)).unwrap_err(),
                "Not an app window",
                "{label}"
            );
        }
        let big = "x".repeat(MAX_REQUEST_BYTES);
        assert_eq!(
            broker(&state, "app-2", request("context", json!(big))).unwrap_err(),
            "Request too large"
        );
    }

    #[test]
    fn apps_get_every_layer_and_the_driver_can_take_them_off_one_by_one() {
        assert_eq!(
            Guard::FULL,
            Guard {
                header: true,
                lock: true,
                rules: true,
                prefs: true,
                proxy: false
            }
        );
        assert_eq!(Guard::parse("full"), Some(Guard::FULL));
        let control = Guard::parse("control").unwrap();
        assert!(
            !control.header && !control.lock && !control.rules && !control.prefs && !control.proxy
        );
        let some = Guard::parse("header+lock").unwrap();
        assert!(some.header && some.lock && !some.rules && !some.prefs);
        assert_eq!(Guard::parse("header+nothing"), None);
        assert_eq!(Guard::parse(""), None);
    }

    /// Measured on WKWebView: the rule list alone stops every load the CSP stops and `<link rel=preconnect>`,
    /// which the CSP does not; it must let the runner itself through.
    #[test]
    fn the_rule_list_blocks_everything_but_the_runner() {
        let rules: Value = serde_json::from_str(RULES).unwrap();
        assert_eq!(
            rules,
            json!([
                {"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
                {"trigger": {"url-filter": "^ghostly-app:"}, "action": {"type": "ignore-previous-rules"}},
            ])
        );
        assert!(!RULES_ID.is_empty());
    }

    /// WebKit's switches are private: a WebKit that renamed one would leave it on. Each one an app window turns
    /// off must exist in the WebKit on this Mac (an app window refuses to open otherwise).
    #[cfg(target_os = "macos")]
    #[test]
    fn webkit_knows_every_switch_an_app_window_turns_off() {
        let known: Vec<String> = webkit::features().into_iter().map(|(key, _)| key).collect();
        for key in OFF {
            assert!(
                known.iter().any(|k| k == key),
                "WebKit has no {key}: {known:?}"
            );
        }
    }

    #[test]
    fn opening_an_app_makes_an_app_window_on_the_runner() {
        let app = app();
        let label = open(app.handle(), "ana/chess".into(), "<p>chess</p>".into()).unwrap();
        assert!(is_app_label(&label), "{label}");
        let window = app.get_webview_window(&label).unwrap();
        assert!(is_runner(&window.url().unwrap()));
        assert_eq!(refused(app.handle(), &label), Some(Vec::new()));
        forget_window(app.handle(), &label);
        assert_eq!(refused(app.handle(), &label), None);
    }
}
