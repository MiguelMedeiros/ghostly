//! Windows that run an installed mini-app (WISP 1200, "Where it runs", Desktop row).
//!
//! - One window per app instance, labelled `app-<random>`, opened by the Ghostly window (`app_open`) with the
//!   entry the engine checked. Rust keeps label → app; the app's identity is that binding, never anything the
//!   page says.
//! - The window loads the runner from the `ghostly-app` scheme, with the runner's CSP as an HTTP header (the
//!   network runner's for an app granted `internet`): the `sandbox` directive gives the page an opaque origin
//!   (`"null"`), no storage and no network (HTTPS and WSS only, with `internet`).
//! - The runner asks `app_broker` for the app's entry (`start`), says `writing`, and writes the entry into
//!   itself. `app_broker` is the only command an `app-*` window may call (`only_main` in `lib.rs`, and the
//!   capability in `capabilities/app.json`).
//! - Every other request is the web broker's (`apps/ui/src/lib/apps/broker.ts`), which runs in the Ghostly
//!   window: Rust checks the caller, the size and the rate, hands the request to the Ghostly window with the
//!   caller's label, and returns its answer as `app_broker`'s result. The broker's events go back to that window
//!   alone (`app_post`), evaluated into the runner's receiver.
//! - The window never leaves the runner: every navigation after the first load is refused, and new windows
//!   are denied without opening the system browser (for an app, a link out is a way to send data out).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

pub const SCHEME: &str = "ghostly-app";
/// Every app window's label starts with this; nothing else may call `app_broker`.
pub const LABEL_PREFIX: &str = "app-";

/// The runner's policy (WISP 1200, "The runner's CSP"), sent as a header so `sandbox` holds even if the page
/// is opened some other way. Tauri's configured CSP is not added to a custom scheme's responses.
pub const RUNNER_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; \
media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; \
form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/// The network runner's policy (WISP 1200, "The network runner's CSP"), for an app the person granted
/// `internet`: HTTPS and WSS for fetches, sockets, images, media and fonts, and nothing else wider.
pub const NET_RUNNER_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; \
media-src data: blob: https:; font-src data: https:; connect-src https: wss:; frame-src 'none'; \
worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/// The largest request an app may send the broker (WISP 1200: 64 KiB), as JSON.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// The most requests an app may send the broker in a second (WISP 1200: 50), every call counted.
const MAX_REQUESTS_PER_SECOND: usize = 50;
/// The largest id a request may carry: a safe integer in JavaScript.
const MAX_ID: u64 = (1 << 53) - 1;
/// How long a request waits for the Ghostly window's broker (a file read included).
#[cfg(not(test))]
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const ANSWER_TIMEOUT: Duration = Duration::from_secs(1);

/// To the Ghostly window: a request of an app window, `{"label", "request"}`.
pub const REQUEST_EVENT: &str = "ghostly-app-request";
/// To the Ghostly window: an app window closed, its label.
pub const CLOSED_EVENT: &str = "ghostly-app-closed";

/// The runner, shipped inside the app, never fetched. Before any app code it deletes the WebRTC constructors,
/// refuses to start outside an `app-*` window or with an origin that is not opaque, and defines the broker's
/// event receiver and `window.ghostly` (the same API as the web runner, apps/web/public/app-frame.html); then
/// it writes the entry `app_broker` hands it into itself.
///
/// Tauri's IPC object stays in the page: Tauri defines `window.__TAURI_INTERNALS__` as a property that cannot
/// be deleted or replaced, and answers every call through `window.__TAURI_INTERNALS__.runCallback` (WISP 1200,
/// threats: the capability and `only_main` are the gates).
const RUNNER: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><title>Ghostly app</title>
<script>
(() => {
  "use strict";
  for (const name of Object.getOwnPropertyNames(window)) {
    if (/^(webkit)?RTC/.test(name)) { try { delete window[name]; } catch (e) {} }
  }
  const stop = (why) => {
    document.documentElement.textContent = "This app cannot run here.";
    document.documentElement.setAttribute("data-ghostly-refused", why);
  };
  const internals = window.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  if (self.origin !== "null" || !internals || typeof label !== "string" || !/^app-[A-Za-z0-9]+$/.test(label)) return stop("origin");
  if (Object.getOwnPropertyNames(window).some((name) => /^(webkit)?RTC/.test(name))) return stop("webrtc");

  const invoke = internals.invoke.bind(internals);
  const broker = (request) => invoke("app_broker", { request });
  const listeners = { message: new Set(), peer: new Set() };
  // The broker's events, `{event, data}`, which Rust evaluates into this window alone (`app_post`).
  Object.defineProperty(window, "__ghostlyEvent", { value: (message) => {
    if (!message || typeof message !== "object") return;
    const kind = message.event === "chat.message" ? "message" : message.event === "chat.peer" ? "peer" : null;
    if (kind) for (const listener of Array.from(listeners[kind])) { try { listener(message.data); } catch (error) { setTimeout(() => { throw error; }); } }
  } });
  // What a request may carry, as the broker reads it: plain JSON, no deeper than 64.
  const isJson = (value, depth) => {
    if (depth > 64) return false;
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
    if (typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return (proto === Object.prototype || proto === null) && Object.values(value).every((item) => isJson(item, depth + 1));
  };
  const bytesOf = (text) => {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  };
  let nextId = 1;
  const send = (type, args) => {
    if (!isJson(args, 0)) return Promise.reject(new TypeError("Not a JSON value"));
    const id = nextId++;
    return broker({ id, type, args }).then((answer) => {
      if (!answer || typeof answer !== "object" || answer.id !== id) throw new Error("refused");
      if (answer.ok !== true) throw new Error(typeof answer.error === "string" ? answer.error : "refused");
      return typeof answer.bytes === "string" ? bytesOf(answer.bytes) : answer.value;
    }, (error) => { throw new Error(typeof error === "string" ? error : "refused"); });
  };
  const call = (type) => (...args) => send(type, args);
  Object.defineProperty(window, "ghostly", { enumerable: true, value: Object.freeze({
    context: call("context"),
    file: (path) => send("file", [path]),
    storage: Object.freeze({
      get: call("storage.get"),
      set: call("storage.set"),
      delete: call("storage.delete"),
      keys: call("storage.keys"),
    }),
    chat: Object.freeze({
      send: (value) => send("chat.send", [value]).then(() => undefined),
      on: (event, listener) => {
        const set = listeners[event];
        if (!set || typeof listener !== "function") throw new TypeError("chat.on takes \"message\" or \"peer\" and a function");
        set.add(listener);
        return () => { set.delete(listener); };
      },
    }),
    close: () => send("close", []).then(() => undefined),
  }) });

  // On Linux the window's filter goes in just after it is made: until then the broker says "Not ready".
  const begin = (tries) => broker({ type: "start" }).then((entry) => send("writing", []).then(() => {
    document.open();
    document.write(entry);
    document.close();
  }, () => stop("broker")), (error) => {
    if (String(error).includes("Not ready") && tries < 400) setTimeout(() => begin(tries + 1), 25);
    else stop("broker");
  });
  begin(0);
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
    /// A content rule list that blocks every load but `ghostly-app:`: `WKContentRuleList` on macOS (`webkit`),
    /// `WebKitUserContentFilter` on Linux (`webkitgtk`), same JSON. Required: no app runs without it there.
    rules: bool,
    /// Best effort: WebKit's preconnect, DNS prefetch and WebRTC switched off for the window (macOS private
    /// features, Linux `WebKitSettings`).
    prefs: bool,
    /// A proxy that goes nowhere, with a data store of its own. Measured, not used: WKWebView never sent a
    /// request to it (macOS 15.6); kept for the test driver so Linux can be measured the same way.
    proxy: bool,
    /// Test driver only, Linux: WebRTC switched ON in the window (WebKitGTK has it off by default), so the
    /// nested-frame WebRTC case can be shown closed by the other layers rather than by its absence.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    webrtc: bool,
}

impl Guard {
    pub const FULL: Guard = Guard {
        header: true,
        lock: true,
        rules: true,
        prefs: true,
        proxy: false,
        webrtc: false,
    };

    /// `full`, `control` (nothing), or layers joined by `+`: `header`, `lock`, `rules`, `prefs`, `proxy`, and
    /// `webrtc` (Linux: WebRTC on, the opposite of a layer). `full+webrtc` is every layer with WebRTC on.
    #[cfg(any(test, feature = "e2e-driver"))]
    pub fn parse(name: &str) -> Option<Guard> {
        if name == "full" {
            return Some(Guard::FULL);
        }
        if name == "full+webrtc" {
            return Some(Guard {
                webrtc: true,
                ..Guard::FULL
            });
        }
        let mut guard = Guard {
            header: false,
            lock: false,
            rules: false,
            prefs: false,
            proxy: false,
            webrtc: false,
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
                "webrtc" => guard.webrtc = true,
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

/// Where an app shows (WISP 1200 · Manifest, `view`), which sets its window's first size. `chat`, the default:
/// a game beside the Ghostly window, as before. `full`: the Ghostly window's own first size (`tauri.conf.json`).
/// Any other value is refused with the request.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppView {
    #[default]
    Chat,
    Full,
}

impl AppView {
    fn size(self) -> (f64, f64) {
        match self {
            AppView::Chat => (560.0, 640.0),
            AppView::Full => (900.0, 700.0),
        }
    }
}

struct AppWindow {
    /// The app this window runs: its reference (`<publisher>/<name>`).
    app: String,
    /// The verified entry, handed over once on `start`.
    entry: Option<String>,
    started: bool,
    /// Whether every required layer is in place, so the entry may be handed over (`start`). On Linux the
    /// filter goes into the window just after it is made (`webkitgtk`); elsewhere it is ready when made.
    ready: bool,
    guard: Guard,
    /// The person granted the app `internet`: the network runner's policy and rule list.
    internet: bool,
    /// Opened by the Ghostly window (`app_open`), whose broker answers this window's requests. The test
    /// driver's windows have none: only `start` and `writing` are answered there.
    brokered: bool,
    /// When the window's last requests came, for the rate.
    recent: VecDeque<Instant>,
    /// Requests the Ghostly window's broker has not answered yet, by the app's id.
    pending: HashMap<u64, oneshot::Sender<Value>>,
    /// What the window was refused (navigations and new windows), for the spike's measurements.
    refused: Vec<String>,
    /// Its first size.
    view: AppView,
}

impl AppWindow {
    fn new(app: String, entry: String, guard: Guard, internet: bool, brokered: bool) -> AppWindow {
        AppWindow {
            app,
            entry: Some(entry),
            started: false,
            ready: !cfg!(all(target_os = "linux", not(test))),
            guard,
            internet,
            brokered,
            recent: VecDeque::new(),
            pending: HashMap::new(),
            refused: Vec::new(),
            view: AppView::Chat,
        }
    }
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
/// not another page, not a frame of any kind (`about:srcdoc` and `about:blank` included). Before the first
/// load, nothing else either.
fn may_navigate(url: &url::Url, started: bool) -> bool {
    !started && is_runner(url)
}

/// What the Ghostly window opens: an installed app's entry, as the engine checked it, and what the person
/// granted it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// `<publisher key in z-base32>/<name>`.
    app: String,
    /// The app's name, for the window's title (outside the page, where the app cannot change it).
    title: String,
    entry: String,
    /// The person granted `internet` (the engine's record): the network runner.
    #[serde(default)]
    internet: bool,
    /// The manifest's `view`: `chat` when absent.
    #[serde(default)]
    view: AppView,
}

/// Why apps do not open on Windows yet: WebView2 has no content rule list, and its equivalents (a request
/// filter, its preconnect and WebRTC switches) are not measured. WISP 1200, Desktop row.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const WINDOWS_REFUSAL: &str =
    "Apps do not run on Windows yet: the app window's protections are not measured there.";

/// Opens an app for the Ghostly window's broker, in a window of its own, and answers its label. Not from the
/// main thread (on macOS the window is built there, and this waits for it): `app_open` runs it off it.
pub fn open<R: Runtime>(app: &AppHandle<R>, request: OpenRequest) -> Result<String, String> {
    open_window(
        app,
        request.app,
        &request.title,
        request.entry,
        Guard::FULL,
        request.internet,
        true,
        request.view,
    )
}

/// The test driver's way: a window with the layers `guard` keeps and no broker behind it.
#[cfg(any(test, feature = "e2e-driver"))]
pub fn open_guarded<R: Runtime>(
    app: &AppHandle<R>,
    app_id: String,
    entry: String,
    guard: Guard,
    internet: bool,
) -> Result<String, String> {
    let title = app_id.clone();
    open_window(
        app,
        app_id,
        &title,
        entry,
        guard,
        internet,
        false,
        AppView::Chat,
    )
}

#[allow(clippy::too_many_arguments)]
fn open_window<R: Runtime>(
    app: &AppHandle<R>,
    app_id: String,
    title: &str,
    entry: String,
    guard: Guard,
    internet: bool,
    brokered: bool,
    view: AppView,
) -> Result<String, String> {
    if cfg!(target_os = "windows") {
        return Err(WINDOWS_REFUSAL.into());
    }
    let label = format!("{LABEL_PREFIX}{:016x}", rand::random::<u64>());
    let mut window = AppWindow::new(app_id, entry, guard, internet, brokered);
    window.view = view;
    app.state::<AppSandboxState>()
        .windows
        .lock()
        .map_err(|_| "app state poisoned")?
        .insert(label.clone(), window);
    let built = build_window(app, &label, title, guard, internet);
    if let Err(e) = built {
        forget(app, &label);
        return Err(e);
    }
    Ok(label)
}

/// The window, with every layer that does not depend on the platform.
fn window_builder<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    label: &str,
    title: &str,
    guard: Guard,
) -> Result<WebviewWindowBuilder<'a, R, AppHandle<R>>, String> {
    let url = format!("{SCHEME}://localhost/")
        .parse()
        .map_err(|e| format!("URL: {e}"))?;
    let (nav_app, nav_label) = (app.clone(), label.to_string());
    let (new_app, new_label) = (app.clone(), label.to_string());
    let (width, height) = app
        .state::<AppSandboxState>()
        .with(label, |window| window.view)
        .unwrap_or_default()
        .size();
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(url))
        .title(format!("{title} (Ghostly)"))
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
        .inner_size(width, height);
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

#[cfg(any(all(not(target_os = "macos"), not(target_os = "linux")), test))]
fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: &str,
    guard: Guard,
    _internet: bool,
) -> Result<(), String> {
    window_builder(app, label, title, guard)?
        .build()
        .map(|_| ())
        .map_err(|e| format!("Window: {e}"))
}

/// On Linux wry gives no way to configure the WebKitWebView before it exists, so the window is hardened just
/// after (`webkitgtk::harden`, on the GTK thread), and the broker holds the entry back until it is
/// (`AppWindow::ready`). A filter that cannot be made closes the window.
#[cfg(all(target_os = "linux", not(test)))]
fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: &str,
    guard: Guard,
    internet: bool,
) -> Result<(), String> {
    let window = window_builder(app, label, title, guard)?
        .build()
        .map_err(|e| format!("Window: {e}"))?;
    let store = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cache: {e}"))?
        .join("app-filters");
    let (handle, label) = (app.clone(), label.to_string());
    window
        .with_webview(move |platform| {
            let webview = platform.inner();
            webkitgtk::harden(&webview, guard, internet, &store, move |result| {
                let state = handle.state::<AppSandboxState>();
                match result {
                    Ok(()) => {
                        state.with(&label, |window| window.ready = true);
                    }
                    Err(e) => {
                        crate::diagnostics::log(&format!("app window: not hardened ({e}), closed"));
                        if let Some(window) = handle.get_webview_window(&label) {
                            let _ = window.close();
                        }
                        forget(&handle, &label);
                    }
                }
            });
        })
        .map_err(|e| format!("Window: {e}"))
}

/// On macOS the window gets a WebKit configuration of its own (`webkit`), which has to be made and used on
/// the main thread; this waits for it there.
#[cfg(all(target_os = "macos", not(test)))]
fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: &str,
    guard: Guard,
    internet: bool,
) -> Result<(), String> {
    if objc2_foundation::MainThreadMarker::new().is_some() {
        return Err("Open apps from a command, not the main thread".into());
    }
    if guard.rules {
        webkit::compile_rules(app, internet)?;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let (handle, label, title) = (app.clone(), label.to_string(), title.to_string());
    app.run_on_main_thread(move || {
        let built = (|| {
            let mut builder = window_builder(&handle, &label, &title, guard)?;
            if guard.rules || guard.prefs {
                builder =
                    builder.with_webview_configuration(webkit::configuration(guard, internet)?);
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

/// Drops a window's state, and with it every request still waiting (each gets "No answer"). True when it had
/// one.
fn forget<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<bool> {
    let state = app.try_state::<AppSandboxState>()?;
    let window = state.windows.lock().ok()?.remove(label)?;
    crate::diagnostics::log(&format!("app window {label} ({}) closed", window.app));
    Some(window.brokered)
}

/// A window is gone (`WindowEvent::Destroyed`): its state goes, and the Ghostly window's broker hears it, so
/// the app stops there too (its chat closed on the contact's side).
pub fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if forget(app, label) == Some(true) {
        let _ = app.emit_to("main", CLOSED_EVENT, label);
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

/// The `ghostly-app` scheme: the runner, to an app window, at its one address, under the policy of what the
/// person granted. Nothing else is served; an app's files come through `app_broker`.
pub fn handle<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let Some((guard, internet)) = app
        .state::<AppSandboxState>()
        .with(label, |window| (window.guard, window.internet))
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
        .header("x-dns-prefetch-control", "off")
        .header("cache-control", "no-store");
    if guard.header {
        let policy = if internet { NET_RUNNER_CSP } else { RUNNER_CSP };
        response = response.header("content-security-policy", policy);
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

/// What `admit` makes of an app window's request.
#[derive(Debug)]
pub enum Admitted {
    /// Answered here: the runner's own `start`.
    Answer(Value),
    /// For the Ghostly window's broker: its id, and where the answer comes.
    Relay(u64, oneshot::Receiver<Value>),
}

/// Whether a request of the app window `label` goes on, at `now`. The caller is known by its label alone; the
/// request carries no identity, and anything in it that looks like one is only passed on as the app's own
/// data. Every call counts toward the rate, refused ones too, as the web broker counts them.
pub fn admit(
    state: &AppSandboxState,
    label: &str,
    request: &Value,
    now: Instant,
) -> Result<Admitted, String> {
    if !is_app_label(label) {
        return Err("Not an app window".into());
    }
    state
        .with(label, |window| {
            window.recent.push_back(now);
            while window
                .recent
                .front()
                .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(1))
            {
                window.recent.pop_front();
            }
            if window.recent.len() > MAX_REQUESTS_PER_SECOND {
                return Err("too-fast".to_string());
            }
            if serde_json::to_vec(request).map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES) {
                return Err("too-large".into());
            }
            let kind = request.get("type").and_then(Value::as_str);
            match kind {
                Some("start") if !window.ready => Err("Not ready".into()),
                // The entry, once: a second start (a reload that got through) is refused.
                Some("start") if !window.started => {
                    window.started = true;
                    // The runner's wait for the window ("Not ready", up to 40 asks a second on Linux) is not the
                    // app's: the app's own second starts with its entry.
                    window.recent.clear();
                    window
                        .entry
                        .take()
                        .map(|entry| Admitted::Answer(Value::String(entry)))
                        .ok_or("No entry".to_string())
                }
                Some("start") => Err("Already started".into()),
                Some(_) => {
                    let id = request
                        .get("id")
                        .and_then(Value::as_u64)
                        .filter(|id| *id <= MAX_ID)
                        .ok_or("bad-request")?;
                    if !window.started {
                        return Err("Not started".into());
                    }
                    if !window.brokered {
                        // The test driver's window: the runner may write its entry, and nothing else answers.
                        return match kind {
                            Some("writing") => {
                                Ok(Admitted::Answer(json!({ "id": id, "ok": true })))
                            }
                            _ => Err("No broker".into()),
                        };
                    }
                    if window.pending.contains_key(&id) {
                        return Err("bad-request".into());
                    }
                    let (sender, receiver) = oneshot::channel();
                    window.pending.insert(id, sender);
                    Ok(Admitted::Relay(id, receiver))
                }
                None => Err("bad-request".into()),
            }
        })
        .unwrap_or_else(|| Err("Not an app window".into()))
}

/// The one command an app window may call (`only_main` lets it through from `app-*` windows only). The
/// request is `{"id", "type", "args"}`; the result is the broker's answer, `{"id", "ok", "value" | "error"}`
/// (or `"bytes"`, base64, for a file).
#[tauri::command]
pub async fn app_broker<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    request: Value,
) -> Result<Value, String> {
    let label = webview.label().to_string();
    let state = app.state::<AppSandboxState>();
    let (id, receiver) = match admit(&state, &label, &request, Instant::now())? {
        Admitted::Answer(answer) => return Ok(answer),
        Admitted::Relay(id, receiver) => (id, receiver),
    };
    let sent = app.emit_to(
        "main",
        REQUEST_EVENT,
        json!({ "label": label, "request": request }),
    );
    let answer = match sent {
        Ok(()) => tokio::time::timeout(ANSWER_TIMEOUT, receiver).await.ok(),
        Err(_) => None,
    };
    state.with(&label, |window| window.pending.remove(&id));
    match answer {
        Some(Ok(answer)) => Ok(answer),
        _ => Err("No answer".into()),
    }
}

/// What the Ghostly window's broker sends an app window (`post`): an answer (`{"id", …}`) goes to the request
/// waiting for it, of that window only; an event (`{"event", "data"}`) is evaluated into that window's runner.
pub fn post<R: Runtime>(app: &AppHandle<R>, label: &str, message: Value) -> Result<(), String> {
    if !is_app_label(label) {
        return Err("Not an app window".into());
    }
    let state = app.state::<AppSandboxState>();
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let waiting = state
            .with(label, |window| window.pending.remove(&id))
            .ok_or("No app window")?;
        // A request that waited too long, or a window that closed: nobody to tell.
        if let Some(sender) = waiting {
            let _ = sender.send(message);
        }
        return Ok(());
    }
    if message.get("event").and_then(Value::as_str).is_none() {
        return Err("Neither an answer nor an event".into());
    }
    if state.with(label, |_| ()).is_none() {
        return Err("No app window".into());
    }
    let script = event_script(&message)?;
    app.get_webview_window(label)
        .ok_or("No app window")?
        .eval(script)
        .map_err(|e| e.to_string())
}

/// The script that hands an event to the runner: the message as JSON, which is a JavaScript expression.
fn event_script(message: &Value) -> Result<String, String> {
    let json = serde_json::to_string(message).map_err(|e| e.to_string())?;
    Ok(format!("window.__ghostlyEvent({json})"))
}

/// Opens an installed app in a window of its own (the Ghostly window only), off the main thread. Answers the
/// window's label, which the Ghostly window's broker knows the app by.
#[tauri::command]
pub async fn app_open<R: Runtime>(
    app: AppHandle<R>,
    request: OpenRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || open(&app, request))
        .await
        .map_err(|e| e.to_string())?
}

/// An answer or an event from the Ghostly window's broker to an app window (the Ghostly window only).
#[tauri::command]
pub fn app_post<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    message: Value,
) -> Result<(), String> {
    post(&app, &label, message)
}

/// Closes an app window (the Ghostly window only): the broker stopped the app.
#[tauri::command]
pub fn app_close<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    if !is_app_label(&label) {
        return Err("Not an app window".into());
    }
    forget(&app, &label);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The content rule list of an app window on macOS and Linux: every load blocked but the runner's own scheme.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const RULES_ID: &str = "ghostly-app-sandbox-1";
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const RULES: &str = r#"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ghostly-app:"},"action":{"type":"ignore-previous-rules"}}]"#;

/// The rule list of a window whose app the person granted `internet`: the same, with HTTPS and WSS let through.
/// Plain HTTP and WS stay blocked here as in the network runner's CSP, and WebRTC stays off.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const NET_RULES_ID: &str = "ghostly-app-sandbox-net-1";
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const NET_RULES: &str = r#"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ghostly-app:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^https:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^wss:"},"action":{"type":"ignore-previous-rules"}}]"#;

/// The rule list a window gets: its id and its JSON.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn rules_for(internet: bool) -> (&'static str, &'static str) {
    if internet {
        (NET_RULES_ID, NET_RULES)
    } else {
        (RULES_ID, RULES)
    }
}

/// The WebKit features an app window has off on macOS: `<link rel=preconnect>` (and in Early Hints), DNS
/// prefetch, `<link rel=prefetch>`, and WebRTC itself, which also reaches frames the runner never ran in.
#[cfg(any(target_os = "macos", test))]
const OFF: &[&str] = &[
    "DNSPrefetchingEnabled",
    "LinkPreconnect",
    "LinkPreconnectEarlyHintsEnabled",
    "LinkPrefetchEnabled",
    "PeerConnectionEnabled",
];

/// The WebKit side of an app window on macOS: what the CSP does not govern there. Measured (WISP 12xx, Desktop
/// spike): `<link rel=preconnect>` opened a TCP connection under the runner's full policy.
/// - A content rule list that blocks every load but `ghostly-app:` (public API). Required: without it no app
///   window opens.
/// - WebKit's own switches (`WKPreferences._features`, private API, as Ghostly ships outside the App Store):
///   `OFF` below. Defence in depth on top of the public layers: a WebKit without one of them logs it and the
///   window opens anyway.
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

    use super::{rules_for, OFF};

    thread_local! {
        /// Compiled once each, on the main thread, where WebKit wants them: [without, with] `internet`.
        static RULE_LISTS: RefCell<[Option<Retained<WKContentRuleList>>; 2]> = const { RefCell::new([None, None]) };
    }

    /// Compiles a window's rule list, once, and waits for it. Not on the main thread, where WebKit answers.
    pub fn compile_rules<R: Runtime>(app: &AppHandle<R>, internet: bool) -> Result<(), String> {
        static COMPILED: [OnceLock<Result<(), String>>; 2] = [OnceLock::new(), OnceLock::new()];
        let (id, rules) = rules_for(internet);
        COMPILED[usize::from(internet)]
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
                                RULE_LISTS.with(|slots| {
                                    slots.borrow_mut()[usize::from(internet)] = Some(list)
                                });
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
                            Some(&NSString::from_str(id)),
                            Some(&NSString::from_str(rules)),
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
    #[cfg(any(test, feature = "e2e-driver"))]
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
    pub fn configuration(
        guard: Guard,
        internet: bool,
    ) -> Result<Retained<WKWebViewConfiguration>, String> {
        let mtm = MainThreadMarker::new().ok_or("not the main thread")?;
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        if guard.rules {
            let list = RULE_LISTS
                .with(|slots| slots.borrow()[usize::from(internet)].clone())
                .ok_or("rule list not compiled")?;
            unsafe { config.userContentController().addContentRuleList(&list) };
        }
        if guard.prefs {
            let preferences = unsafe { config.preferences() };
            let features = features();
            for key in OFF {
                let Some((_, feature)) = features.iter().find(|(k, _)| k == key) else {
                    crate::diagnostics::log(&format!(
                        "app window: WebKit has no feature {key}, left as it is"
                    ));
                    continue;
                };
                let _: () = unsafe {
                    msg_send![&*preferences, _setEnabled: Bool::NO, forFeature: &**feature]
                };
            }
        }
        Ok(config)
    }
}

/// The WebKitGTK side of an app window on Linux, the counterpart of `webkit`: a user content filter made from
/// the same rule list (public API, required), and `WebKitSettings` for DNS prefetch and WebRTC (public API,
/// best effort). WebKitGTK has no switch for `<link rel=preconnect>`: the filter is what is measured for it.
#[cfg(all(target_os = "linux", not(test)))]
mod webkitgtk {
    use super::{rules_for, Guard};
    use std::cell::RefCell;
    use std::path::Path;
    use webkit2gtk::glib::translate::{FromGlibPtrFull, ToGlibPtr};
    use webkit2gtk::{ffi, gio, glib, SettingsExt, WebViewExt};

    /// A filter, kept with a reference of its own.
    struct Filter(*mut ffi::WebKitUserContentFilter);

    thread_local! {
        /// Made once each, on the GTK thread, where WebKitGTK answers: [without, with] `internet`.
        static FILTERS: RefCell<[Option<Filter>; 2]> = const { RefCell::new([None, None]) };
    }

    type Done = Box<dyn FnOnce(Result<(), String>)>;

    fn add(
        webview: &webkit2gtk::WebView,
        filter: *mut ffi::WebKitUserContentFilter,
    ) -> Result<(), String> {
        let manager = webview
            .user_content_manager()
            .ok_or("no user content manager")?;
        unsafe { ffi::webkit_user_content_manager_add_filter(manager.to_glib_none().0, filter) };
        Ok(())
    }

    /// Settings now, the filter now or once it is made; then `done`.
    pub fn harden(
        webview: &webkit2gtk::WebView,
        guard: Guard,
        internet: bool,
        store: &Path,
        done: impl FnOnce(Result<(), String>) + 'static,
    ) {
        if let Some(settings) = WebViewExt::settings(webview) {
            if guard.prefs {
                settings.set_enable_dns_prefetching(false);
                settings.set_enable_webrtc(false);
            }
            if guard.webrtc {
                settings.set_enable_webrtc(true);
            }
        }
        if !guard.rules {
            return done(Ok(()));
        }
        let slot = usize::from(internet);
        if let Some(filter) = FILTERS.with(|slots| slots.borrow()[slot].as_ref().map(|f| f.0)) {
            return done(add(webview, filter));
        }
        let (rules_id, rules) = rules_for(internet);
        let _ = std::fs::create_dir_all(store);
        let path = std::ffi::CString::new(store.to_string_lossy().as_bytes()).unwrap_or_default();
        let id = std::ffi::CString::new(rules_id).unwrap_or_default();
        let source = glib::Bytes::from_static(rules.as_bytes());
        let pending: Box<(webkit2gtk::WebView, usize, Done)> =
            Box::new((webview.clone(), slot, Box::new(done)));
        unsafe {
            let store = ffi::webkit_user_content_filter_store_new(path.as_ptr());
            ffi::webkit_user_content_filter_store_save(
                store,
                id.as_ptr(),
                ToGlibPtr::<*const glib::ffi::GBytes>::to_glib_none(&source).0 as *mut _,
                std::ptr::null_mut(),
                Some(saved),
                Box::into_raw(pending) as glib::ffi::gpointer,
            );
            // The save holds its own reference to the store until it calls back.
            glib::gobject_ffi::g_object_unref(store as *mut _);
        }
    }

    unsafe extern "C" fn saved(
        store: *mut glib::gobject_ffi::GObject,
        result: *mut gio::ffi::GAsyncResult,
        pending: glib::ffi::gpointer,
    ) {
        let (webview, slot, done) =
            *Box::from_raw(pending as *mut (webkit2gtk::WebView, usize, Done));
        let mut error = std::ptr::null_mut();
        let filter =
            ffi::webkit_user_content_filter_store_save_finish(store as *mut _, result, &mut error);
        if filter.is_null() {
            let message = if error.is_null() {
                "filter not made".to_string()
            } else {
                glib::Error::from_glib_full(error).to_string()
            };
            return done(Err(message));
        }
        FILTERS.with(|slots| slots.borrow_mut()[slot] = Some(Filter(filter)));
        done(add(&webview, filter));
    }
}

/// The WebKit features the spike looks at (macOS), for the test driver.
#[cfg(any(test, feature = "e2e-driver"))]
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

    fn window(app: &str, ready: bool, brokered: bool) -> AppWindow {
        let mut window = AppWindow::new(
            app.into(),
            format!("<p>{app}</p>"),
            Guard::FULL,
            false,
            brokered,
        );
        window.ready = ready;
        window
    }

    fn state(windows: &[(&str, &str)]) -> AppSandboxState {
        let state = AppSandboxState::default();
        for (label, app) in windows {
            state
                .windows
                .lock()
                .unwrap()
                .insert((*label).into(), window(app, true, true));
        }
        state
    }

    fn admitted(state: &AppSandboxState, label: &str, request: Value) -> Result<Admitted, String> {
        admit(state, label, &request, Instant::now())
    }

    fn started(state: &AppSandboxState, label: &str) {
        assert!(matches!(
            admitted(state, label, json!({"type": "start"})),
            Ok(Admitted::Answer(_))
        ));
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

    /// The navigation lock: nested frames (`about:srcdoc`, `about:blank`) never load, before the start or
    /// after, so a frame never brings WebRTC of its own (WISP 1200, Desktop row).
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
            "wss://example.com/",
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
        {
            let state = app.state::<AppSandboxState>();
            let mut windows = state.windows.lock().unwrap();
            windows.insert("app-1".into(), window("ana/chess", true, true));
            let mut net = window("ana/radio", true, true);
            net.internet = true;
            windows.insert("app-2".into(), net);
        }
        let get = |label: &str, uri: &str| {
            let request = Request::builder().uri(uri).body(Vec::new()).unwrap();
            handle(app.handle(), label, &request)
        };
        let served = get("app-1", "ghostly-app://localhost/");
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(served.headers()["content-security-policy"], RUNNER_CSP);
        assert_eq!(served.headers()["x-content-type-options"], "nosniff");
        assert_eq!(served.headers()["x-dns-prefetch-control"], "off");
        assert!(String::from_utf8_lossy(served.body()).contains("app_broker"));
        // The app granted `internet` gets the network runner's policy: the same page.
        let net = get("app-2", "ghostly-app://localhost/");
        assert_eq!(net.headers()["content-security-policy"], NET_RUNNER_CSP);
        assert_eq!(net.body(), served.body());
        assert_eq!(
            get("app-1", "http://ghostly-app.localhost/").status(),
            StatusCode::OK
        );
        assert_eq!(
            get("app-1", "ghostly-app://localhost/x.js").status(),
            StatusCode::NOT_FOUND
        );
        for other in ["main", "svc-1", "app-3"] {
            assert_eq!(
                get(other, "ghostly-app://localhost/").status(),
                StatusCode::FORBIDDEN,
                "{other}"
            );
        }
    }

    #[test]
    fn the_policies_are_the_wisps() {
        for policy in [RUNNER_CSP, NET_RUNNER_CSP] {
            for directive in [
                "sandbox allow-scripts;",
                "default-src 'none';",
                "script-src 'unsafe-inline' 'wasm-unsafe-eval';",
                "frame-src 'none';",
                "worker-src 'none';",
                "form-action 'none';",
                "base-uri 'none';",
                "frame-ancestors 'self'",
            ] {
                assert!(policy.contains(directive), "{directive}");
            }
            for wider in [
                "allow-same-origin",
                "allow-top-navigation",
                "allow-popups",
                "allow-forms",
                "http:",
                "ws:",
                "*",
            ] {
                assert!(!policy.contains(wider), "{wider}");
            }
        }
        assert!(RUNNER_CSP.contains("connect-src 'none';"));
        assert!(NET_RUNNER_CSP.contains("connect-src https: wss:;"));
    }

    #[test]
    fn the_broker_knows_the_caller_by_its_window_and_hands_the_entry_over_once() {
        let state = state(&[("app-1", "ana/chess"), ("app-2", "bob/snake")]);
        // Nothing but `start` before the entry is handed over.
        assert_eq!(
            admitted(
                &state,
                "app-1",
                json!({"id": 1, "type": "writing", "args": []})
            )
            .unwrap_err(),
            "Not started"
        );
        match admitted(&state, "app-1", json!({"type": "start"})).unwrap() {
            Admitted::Answer(entry) => assert_eq!(entry, json!("<p>ana/chess</p>")),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            admitted(&state, "app-1", json!({"type": "start"})).unwrap_err(),
            "Already started"
        );
        // An app that names another app, or another window, is still itself: its request waits in its own
        // window, and an answer posted for the other window's request of the same id does not reach it.
        started(&state, "app-2");
        let forged =
            json!({"id": 7, "type": "context", "args": [], "app": "bob/snake", "window": "app-2"});
        let Admitted::Relay(id, mut receiver) = admitted(&state, "app-1", forged).unwrap() else {
            panic!("relayed")
        };
        assert_eq!(id, 7);
        assert!(state.with("app-1", |w| w.pending.contains_key(&7)).unwrap());
        assert!(!state.with("app-2", |w| w.pending.contains_key(&7)).unwrap());
        assert!(receiver.try_recv().is_err());
        // The same id twice while the first waits is refused.
        assert_eq!(
            admitted(
                &state,
                "app-1",
                json!({"id": 7, "type": "context", "args": []})
            )
            .unwrap_err(),
            "bad-request"
        );

        for label in ["main", "svc-1", "app-3", "app-"] {
            assert_eq!(
                admitted(&state, label, json!({"id": 1, "type": "context"})).unwrap_err(),
                "Not an app window",
                "{label}"
            );
        }
    }

    #[test]
    fn a_request_has_an_id_a_type_and_at_most_64_kib() {
        let state = state(&[("app-1", "ana/chess")]);
        started(&state, "app-1");
        for request in [
            json!({"type": "context", "args": []}),
            json!({"id": -1, "type": "context", "args": []}),
            json!({"id": 1.5, "type": "context", "args": []}),
            json!({"id": "1", "type": "context", "args": []}),
            json!({"id": MAX_ID + 1, "type": "context", "args": []}),
            json!({"id": 1, "args": []}),
            json!({"id": 1, "type": 3, "args": []}),
            json!("context"),
            Value::Null,
        ] {
            assert_eq!(
                admitted(&state, "app-1", request.clone()).unwrap_err(),
                "bad-request",
                "{request}"
            );
        }
        assert!(matches!(
            admitted(
                &state,
                "app-1",
                json!({"id": MAX_ID, "type": "context", "args": []})
            ),
            Ok(Admitted::Relay(MAX_ID, _))
        ));
        // The whole request, as JSON: 64 KiB passes, a byte more does not.
        let request = |length: usize, id: u64| json!({"id": id, "type": "storage.set", "args": ["k", "x".repeat(length)]});
        let fixed = serde_json::to_vec(&request(0, 2)).unwrap().len();
        assert!(matches!(
            admitted(&state, "app-1", request(MAX_REQUEST_BYTES - fixed, 2)),
            Ok(Admitted::Relay(2, _))
        ));
        assert_eq!(
            admitted(&state, "app-1", request(MAX_REQUEST_BYTES - fixed + 1, 3)).unwrap_err(),
            "too-large"
        );
    }

    /// WISP 1200: 50 requests a second per app, every call counted, refused ones too; the 51st inside the
    /// second is refused, and the window's next second is new. Another window has its own count.
    #[test]
    fn the_broker_takes_50_requests_a_second() {
        let state = state(&[("app-1", "ana/chess"), ("app-2", "bob/snake")]);
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert!(matches!(
            admit(&state, "app-1", &json!({"type": "start"}), at(0)),
            Ok(Admitted::Answer(_))
        ));
        // A malformed request counts as well (the start does not: the app's second begins after it).
        assert_eq!(
            admit(&state, "app-1", &json!({"type": "context"}), at(1)).unwrap_err(),
            "bad-request"
        );
        for id in 0..49 {
            let request = json!({"id": id, "type": "context", "args": []});
            assert!(
                admit(&state, "app-1", &request, at(10 + id)).is_ok(),
                "request {id}"
            );
        }
        let request = json!({"id": 100, "type": "context", "args": []});
        assert_eq!(
            admit(&state, "app-1", &request, at(500)).unwrap_err(),
            "too-fast"
        );
        // app-2 is not slowed by app-1.
        assert!(admit(&state, "app-2", &json!({"type": "start"}), at(500)).is_ok());
        // A second after the first ones, they no longer count.
        assert!(admit(
            &state,
            "app-1",
            &json!({"id": 101, "type": "context", "args": []}),
            at(1_020)
        )
        .is_ok());
        // Sustained flooding stays refused.
        for ms in 0..60 {
            let _ = admit(&state, "app-1", &json!({"type": "x"}), at(1_100 + ms));
        }
        assert_eq!(
            admit(
                &state,
                "app-1",
                &json!({"id": 200, "type": "context", "args": []}),
                at(1_200)
            )
            .unwrap_err(),
            "too-fast"
        );
    }

    #[test]
    fn the_test_drivers_windows_have_no_broker() {
        let state = AppSandboxState::default();
        state
            .windows
            .lock()
            .unwrap()
            .insert("app-1".into(), window("spike/malicious", true, false));
        started(&state, "app-1");
        match admitted(
            &state,
            "app-1",
            json!({"id": 3, "type": "writing", "args": []}),
        )
        .unwrap()
        {
            Admitted::Answer(answer) => assert_eq!(answer, json!({"id": 3, "ok": true})),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            admitted(
                &state,
                "app-1",
                json!({"id": 1, "type": "context", "args": []})
            )
            .unwrap_err(),
            "No broker"
        );
    }

    #[test]
    fn an_answer_reaches_the_request_of_its_window_only() {
        let app = app();
        let state = app.state::<AppSandboxState>();
        {
            let mut windows = state.windows.lock().unwrap();
            windows.insert("app-1".into(), window("ana/chess", true, true));
            windows.insert("app-2".into(), window("bob/snake", true, true));
        }
        started(&state, "app-1");
        started(&state, "app-2");
        let request = json!({"id": 4, "type": "storage.keys", "args": []});
        let Admitted::Relay(_, mut first) = admitted(&state, "app-1", request.clone()).unwrap()
        else {
            panic!("relayed")
        };
        let Admitted::Relay(_, mut second) = admitted(&state, "app-2", request).unwrap() else {
            panic!("relayed")
        };
        post(
            app.handle(),
            "app-2",
            json!({"id": 4, "ok": true, "value": ["b"]}),
        )
        .unwrap();
        assert_eq!(
            second.try_recv().unwrap(),
            json!({"id": 4, "ok": true, "value": ["b"]})
        );
        assert!(first.try_recv().is_err(), "app-1's request still waits");
        // Answered once: a second answer for the same id has nobody to go to.
        post(app.handle(), "app-2", json!({"id": 4, "ok": true})).unwrap();
        for label in ["main", "svc-1", "app-"] {
            assert!(
                post(app.handle(), label, json!({"id": 4, "ok": true})).is_err(),
                "{label}"
            );
        }
        assert_eq!(
            post(app.handle(), "app-9", json!({"id": 4, "ok": true})).unwrap_err(),
            "No app window"
        );
        assert!(post(app.handle(), "app-1", json!({"nothing": 1})).is_err());
        // A window that goes drops what waits: the request is told at once.
        forget_window(app.handle(), "app-1");
        assert!(matches!(
            first.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn an_event_is_handed_to_the_runners_receiver_as_json() {
        let script =
            event_script(&json!({"event": "chat.message", "data": {"m": "e4\u{2028}</script>"}}))
                .unwrap();
        assert_eq!(
            script,
            "window.__ghostlyEvent({\"data\":{\"m\":\"e4\u{2028}</script>\"},\"event\":\"chat.message\"})"
        );
        assert!(RUNNER.contains("Object.defineProperty(window, \"__ghostlyEvent\""));
        // The receiver and `window.ghostly` are defined before the entry is written.
        let receiver = RUNNER.find("__ghostlyEvent").unwrap();
        let api = RUNNER.find("\"ghostly\"").unwrap();
        let write = RUNNER.find("document.write(entry)").unwrap();
        assert!(receiver < write && api < write);
    }

    /// The runner offers the web runner's `ghostly.*`, and nothing more: the same names and calls.
    #[test]
    fn the_runner_offers_the_web_api() {
        let web = include_str!("../../web/public/app-frame.html");
        for call in [
            "context: call(\"context\")",
            "file: (path) => send(\"file\", [path])",
            "get: call(\"storage.get\")",
            "set: call(\"storage.set\")",
            "delete: call(\"storage.delete\")",
            "keys: call(\"storage.keys\")",
            "send: (value) => send(\"chat.send\", [value]).then(() => undefined)",
            "close: () => send(\"close\", []).then(() => undefined)",
            "chat.on takes \\\"message\\\" or \\\"peer\\\" and a function",
        ] {
            assert!(RUNNER.contains(call), "desktop: {call}");
            assert!(web.contains(call), "web: {call}");
        }
        assert!(RUNNER.contains("delete window[name]"));
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
                proxy: false,
                webrtc: false
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
    /// which the CSP does not; it must let the runner itself through. With `internet`, HTTPS and WSS too, and
    /// still not plain HTTP or WS.
    #[test]
    fn the_rule_lists_block_everything_but_the_runner_and_with_internet_https_and_wss() {
        let rules: Value = serde_json::from_str(RULES).unwrap();
        assert_eq!(
            rules,
            json!([
                {"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
                {"trigger": {"url-filter": "^ghostly-app:"}, "action": {"type": "ignore-previous-rules"}},
            ])
        );
        let net: Value = serde_json::from_str(NET_RULES).unwrap();
        assert_eq!(
            net,
            json!([
                {"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
                {"trigger": {"url-filter": "^ghostly-app:"}, "action": {"type": "ignore-previous-rules"}},
                {"trigger": {"url-filter": "^https:"}, "action": {"type": "ignore-previous-rules"}},
                {"trigger": {"url-filter": "^wss:"}, "action": {"type": "ignore-previous-rules"}},
            ])
        );
        assert_eq!(rules_for(false), (RULES_ID, RULES));
        assert_eq!(rules_for(true), (NET_RULES_ID, NET_RULES));
        assert_ne!(RULES_ID, NET_RULES_ID);
    }

    /// WebKit's switches are private, so a WebKit that renamed one would leave it on (`webkit::configuration`
    /// logs a missing one and opens the window anyway: the CSP, the navigation lock and the rule list are the
    /// required layers). These are the keys WKWebView listed on macOS 15.6 (the test driver's
    /// `GET /app-webkit`); a change here is a change to what app windows turn off.
    #[test]
    fn an_app_window_turns_off_preconnect_prefetch_and_webrtc() {
        assert_eq!(
            OFF,
            [
                "DNSPrefetchingEnabled",
                "LinkPreconnect",
                "LinkPreconnectEarlyHintsEnabled",
                "LinkPrefetchEnabled",
                "PeerConnectionEnabled",
            ]
        );
    }

    /// The runner's "Not ready" asks do not count against the app: a slow filter leaves it its 50.
    #[test]
    fn the_runners_wait_leaves_the_app_its_50_requests() {
        let state = AppSandboxState::default();
        state
            .windows
            .lock()
            .unwrap()
            .insert("app-1".into(), window("ana/chess", false, true));
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        for ms in 0..40 {
            assert_eq!(
                admit(&state, "app-1", &json!({"type": "start"}), at(ms * 20)).unwrap_err(),
                "Not ready"
            );
        }
        state.with("app-1", |window| window.ready = true);
        assert!(admit(&state, "app-1", &json!({"type": "start"}), at(800)).is_ok());
        for id in 0..50 {
            let request = json!({"id": id, "type": "context", "args": []});
            assert!(admit(&state, "app-1", &request, at(801)).is_ok(), "{id}");
        }
        let request = json!({"id": 50, "type": "context", "args": []});
        assert_eq!(
            admit(&state, "app-1", &request, at(802)).unwrap_err(),
            "too-fast"
        );
    }

    /// On Linux the filter goes into the window just after it is made: the entry waits for it.
    #[test]
    fn the_entry_waits_until_the_window_is_hardened() {
        let state = AppSandboxState::default();
        state
            .windows
            .lock()
            .unwrap()
            .insert("app-1".into(), window("ana/chess", false, true));
        for _ in 0..3 {
            assert_eq!(
                admitted(&state, "app-1", json!({"type": "start"})).unwrap_err(),
                "Not ready"
            );
        }
        // Nothing else goes through while it waits: nothing was handed over.
        assert_eq!(
            admitted(
                &state,
                "app-1",
                json!({"id": 1, "type": "context", "args": []})
            )
            .unwrap_err(),
            "Not started"
        );
        state.with("app-1", |window| window.ready = true);
        match admitted(&state, "app-1", json!({"type": "start"})).unwrap() {
            Admitted::Answer(entry) => assert_eq!(entry, json!("<p>ana/chess</p>")),
            other => panic!("{other:?}"),
        }
        assert!(
            RUNNER.contains("Not ready")
                && RUNNER.contains("tries < 400")
                && RUNNER.contains("25)"),
            "the runner asks again every 25 ms while the window is hardened"
        );
    }

    #[test]
    fn opening_an_app_makes_an_app_window_on_the_runner() {
        let app = app();
        let request = OpenRequest {
            app: "ana/chess".into(),
            title: "Chess".into(),
            entry: "<p>chess</p>".into(),
            internet: true,
        };
        let label = open(app.handle(), request).unwrap();
        assert!(is_app_label(&label), "{label}");
        let window = app.get_webview_window(&label).unwrap();
        assert!(is_runner(&window.url().unwrap()));
        let state = app.state::<AppSandboxState>();
        assert_eq!(
            state.with(&label, |w| (w.app.clone(), w.internet, w.brokered)),
            Some(("ana/chess".to_string(), true, true))
        );
        assert_eq!(refused(app.handle(), &label), Some(Vec::new()));
        forget_window(app.handle(), &label);
        assert_eq!(refused(app.handle(), &label), None);
    }

    #[test]
    fn an_open_request_is_what_the_ghostly_window_sends() {
        let request: OpenRequest = serde_json::from_value(
            json!({"app": "ana/chess", "title": "Chess", "entry": "<p>x</p>", "internet": true}),
        )
        .unwrap();
        assert!(request.internet);
        let plain: OpenRequest =
            serde_json::from_value(json!({"app": "a/b", "title": "B", "entry": ""})).unwrap();
        assert!(!plain.internet, "no grant, no network");
        assert_eq!(plain.view, AppView::Chat, "no view: a chat app's window");
        let full: OpenRequest = serde_json::from_value(
            json!({"app": "a/b", "title": "B", "entry": "", "view": "full"}),
        )
        .unwrap();
        assert_eq!(full.view, AppView::Full);
        assert!(
            AppView::Full.size().0 > AppView::Chat.size().0,
            "a full app's window is the larger"
        );
        assert!(
            serde_json::from_value::<OpenRequest>(
                json!({"app": "a/b", "title": "B", "entry": "", "view": "popup"})
            )
            .is_err(),
            "an unknown view is refused"
        );
        assert!(WINDOWS_REFUSAL.contains("Windows"));
    }
}
