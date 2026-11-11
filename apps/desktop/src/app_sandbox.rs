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
pub const RUNNER_CSP: &str = "sandbox allow-scripts allow-pointer-lock; default-src 'none'; \
script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; \
media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; \
form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/// The network runner's policy (WISP 1200, "The network runner's CSP"), for an app the person granted
/// `internet`: HTTPS and WSS for fetches, sockets, images, media and fonts, and nothing else wider.
pub const NET_RUNNER_CSP: &str = "sandbox allow-scripts allow-pointer-lock; default-src 'none'; \
script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; \
media-src data: blob: https:; font-src data: https:; connect-src https: wss:; frame-src 'none'; \
worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/// The largest request an app may send the broker (WISP 1200: 66 KiB, a 64 KiB stored value with its key), as JSON.
const MAX_REQUEST_BYTES: usize = 66 * 1024;
/// The largest IPC message an app window may post: its largest request with room for Tauri's envelope. Tauri
/// drops a larger one unread (`message_limit`), as parsing it would hold the main thread, every window's; the
/// runner refuses such a request first, so an app that calls `window.ghostly` still gets "too-large".
const MAX_MESSAGE_BYTES: usize = 2 * MAX_REQUEST_BYTES;
/// The most requests an app may send the broker in a second (WISP 1200: 50), every call counted.
const MAX_REQUESTS_PER_SECOND: usize = 50;
/// What a window keeps of what it was refused: the last few, each cut short, so an app that keeps asking to
/// leave does not grow the Ghostly process.
const MAX_REFUSED: usize = 64;
const MAX_REFUSED_BYTES: usize = 256;
/// The largest id a request may carry: a safe integer in JavaScript.
const MAX_ID: u64 = (1 << 53) - 1;
/// How long a request waits for the Ghostly window's broker (a file read included), a file pick excepted
/// (`answer_to`).
#[cfg(not(test))]
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const ANSWER_TIMEOUT: Duration = Duration::from_secs(1);
/// `files.pick` waits for the person in the system's dialog: as long as they take, within reason.
const PICK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

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
  // WebKit lets `execCommand("copy")` write the system clipboard while a tap in the window is handled, whatever
  // `javascript-can-access-clipboard` says (off here). An app has no clipboard permission (WISP 1200), so its
  // clipboard commands answer false; editing commands work on. The web runner's wrapper (app-frame.html), the same
  // text: it asks nothing the app can change, which may have changed every prototype by the time it calls.
  const execCommand = Document.prototype.execCommand;
  let commands = execCommand;
  if (typeof execCommand === "function") {
    const apply = Reflect.apply;
    const lower = String.prototype.toLowerCase;
    commands = function (command, showUI, value) {
      if (arguments.length === 0) return apply(execCommand, this, []);
      const name = typeof command === "string" ? command : "" + command;
      const named = apply(lower, name, []);
      if (named === "copy" || named === "cut" || named === "paste") return false;
      return apply(execCommand, this, arguments.length > 2 ? [name, showUI, value] : arguments.length > 1 ? [name, showUI] : [name]);
    };
    Object.defineProperty(Document.prototype, "execCommand", { configurable: true, writable: true, value: commands });
  }
  // Nor the async Clipboard API: WebKit and Firefox let `navigator.clipboard` write the system clipboard whatever the
  // window's settings or the frame's `allow=""` say (only Chromium refuses it). The app finds no `navigator.clipboard`,
  // no `ClipboardItem` and no method on `Clipboard.prototype`. Both runners, the same text.
  const CLIPBOARD = ["read", "readText", "write", "writeText"];
  try { delete Navigator.prototype.clipboard; } catch (e) { /* stays: refused below */ }
  try { delete window.ClipboardItem; } catch (e) { /* stays: refused below */ }
  if (typeof Clipboard === "function") {
    for (const name of CLIPBOARD) { try { delete Clipboard.prototype[name]; } catch (e) { /* stays: refused below */ } }
  }
  const clipboardLeft = () => "clipboard" in navigator || "ClipboardItem" in window
    || (typeof Clipboard === "function" && CLIPBOARD.some((name) => name in Clipboard.prototype));
  const stop = (why) => {
    document.documentElement.textContent = "This app cannot run here.";
    document.documentElement.setAttribute("data-ghostly-refused", why);
  };
  const internals = window.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  if (self.origin !== "null" || !internals || typeof label !== "string" || !/^app-[A-Za-z0-9]+$/.test(label)) return stop("origin");
  if (Object.getOwnPropertyNames(window).some((name) => /^(webkit)?RTC/.test(name))) return stop("webrtc");
  if (document.execCommand !== commands || clipboardLeft()) return stop("clipboard");

  const invoke = internals.invoke.bind(internals);
  const clockNow = Date.now;
  const reflectApply = Reflect.apply;
  const listen = EventTarget.prototype.addEventListener;
  const stopImmediately = Event.prototype.stopImmediatePropagation;
  // Every answer and event comes as its JSON text, parsed here (`json_response`, `event_script`): evaluated as a
  // JavaScript literal, a `__proto__` member would set the object's prototype instead of staying a key, as the web
  // broker keeps it (jsonValueOf).
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const encoder = new TextEncoder();
  const utf8 = encoder.encode.bind(encoder);
  const jsonOf = (text) => {
    if (typeof text !== "string") return undefined;
    try { return parse(text); } catch (error) { return undefined; }
  };
  const broker = (request) => invoke("app_broker", { request }).then(jsonOf);
  const listeners = { message: new Set(), peer: new Set() };
  // The broker's events, `{event, data}`, which Rust evaluates into this window alone (`app_post`).
  Object.defineProperty(window, "__ghostlyEvent", { value: (text) => {
    const message = jsonOf(text);
    if (!message || typeof message !== "object") return;
    const kind = message.event === "chat.message" ? "message" : message.event === "chat.peer" ? "peer" : null;
    if (kind) for (const listener of Array.from(listeners[kind])) { try { listener(message.data); } catch (error) { setTimeout(() => { throw error; }); } }
  } });
  // What a request may carry, as the broker reads it: plain JSON, no deeper than 64. An `undefined` member or item
  // goes, as JSON.stringify writes it (left out, or null in an array), the way the web broker reads it (jsonValueOf).
  const isJson = (value, depth) => {
    if (depth > 64) return false;
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    const inside = (item) => item === undefined || isJson(item, depth + 1);
    if (Array.isArray(value)) return value.every(inside);
    if (typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return (proto === Object.prototype || proto === null) && Object.values(value).every(inside);
  };
  // What a failed call rejects with: one of the broker's codes (MINI_APP_ERROR_CODES, packages/core/src/miniApp.ts),
  // or "failed" for anything else, this runner's own failures included. Read without the prototypes the app may change.
  const CODES = ["bad-key", "bad-path", "bad-request", "cancelled", "changed", "failed", "full", "gone", "no-file", "not-allowed", "not-open", "not-served", "offline", "peer-closed", "stopped", "too-fast", "too-large", "unknown-type"];
  const known = Object.create(null);
  for (let i = 0; i < CODES.length; i++) known[CODES[i]] = true;
  const refusal = (code) => new Error(typeof code === "string" && known[code] === true ? code : "failed");
  // A file's bytes come as base64 (`bytes_response`), up to 64 MiB: the engine's own decoder where it has one (WebKit
  // decodes 64 MiB in about 40 ms with it, 250 ms a character at a time), taken before any app code can change it.
  const fromBase64 = typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64 : null;
  const decode = atob;
  const bytesOf = (text) => {
    if (fromBase64) return reflectApply(fromBase64, Uint8Array, [text]).buffer;
    const raw = decode(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  };
  let nextId = 1;
  const send = (type, args) => {
    if (!isJson(args, 0)) return Promise.reject(refusal("bad-request"));
    const id = nextId++;
    const request = { id, type, args };
    // Over the broker's 66 KiB (MAX_REQUEST_BYTES) here: far over it, Tauri would drop the call unanswered.
    if (utf8(stringify(request)).length > 67584) return Promise.reject(refusal("too-large"));
    return broker(request).then((answer) => {
      if (!answer || typeof answer !== "object" || answer.id !== id) throw refusal("failed");
      if (answer.ok !== true) throw refusal(answer.error);
      return typeof answer.bytes === "string" ? bytesOf(answer.bytes) : answer.value;
    }, (error) => { throw refusal(error); });
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
    files: Object.freeze({
      pick: (options) => send("files.pick", options === undefined ? [] : [options]),
      list: call("files.list"),
      read: (id, range) => send("files.read", [id, range]),
      forget: (id) => send("files.forget", [id]).then(() => undefined),
      serve: (id) => send("files.serve", [id]),
      unserve: (serveId) => send("files.unserve", [serveId]).then(() => undefined),
    }),
    remote: Object.freeze({
      read: (serveId, range) => send("remote.read", [serveId, range]),
      stat: (serveId) => send("remote.stat", [serveId]),
    }),
    close: () => send("close", []).then(() => undefined),
  }) });

  // On Linux the window's filter goes in just after it is made: until then the broker says "Not ready".
  const begin = (tries) => broker({ type: "start" }).then((entry) => send("writing", []).then(() => {
    document.open();
    // The person's taps and keys in this window never reach the Ghostly window, whose lock screen would lock them out
    // of a game longer than its time: the runner says `activity` for a trusted one, at most every 5 seconds, which the
    // broker counts while this window has the focus. Added before the app's code, which cannot name it to remove it;
    // the app can say `activity` too, which counts only just after the system's own input here (`admit`).
    let said = -Infinity;
    const heard = (event) => {
      if (event.isTrusted !== true) return;
      const at = clockNow();
      if (at - said < 5000 && at >= said) return;
      said = at;
      try { send("activity", []).catch(() => {}); } catch (error) {}
    };
    // The runner's own listeners on the window, put on now and again whenever the document is opened again.
    const keepRunnerListeners = () => {
      reflectApply(listen, window, ["pointerdown", heard, true]);
      reflectApply(listen, window, ["keydown", heard, true]);
    };
    // The person's copy or cut in the app puts on the clipboard what they selected, never what the app says in its
    // place: an app has no clipboard permission (WISP 1200), so none of its listeners hears one (a listener could set
    // the event's clipboardData and cancel it). This capture listener on the window runs before any of the app's and
    // stops the event there, so nothing cancels it and the browser copies the selection. One the app makes writes nothing.
    const selectionOnly = (event) => { if (event.isTrusted === true) reflectApply(stopImmediately, event, []); };
    // A document opened again (`document.open` with no close, or a write once the page is parsed) erases the window's
    // listeners, and the app runs on: every one of the runner's goes back on as it opens, before any the app adds after,
    // through what the runner took before the app's code ran.
    const keepListeners = () => {
      keepRunnerListeners();
      reflectApply(listen, window, ["copy", selectionOnly, true]);
      reflectApply(listen, window, ["cut", selectionOnly, true]);
    };
    keepListeners();
    for (const name of ["open", "write", "writeln"]) {
      const opens = Document.prototype[name];
      Object.defineProperty(Document.prototype, name, { configurable: true, writable: true, value: function () {
        const result = reflectApply(opens, this, arguments);
        keepListeners();
        return result;
      } });
    }
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
    /// When the system last gave the window's webview a tap or key (`heard_input`), which no script can make.
    input: Option<Instant>,
    /// What the window was refused (navigations and new windows), for the spike's measurements: the last
    /// `MAX_REFUSED`, each at most `MAX_REFUSED_BYTES` of its URL.
    refused: VecDeque<String>,
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
            input: None,
            refused: VecDeque::new(),
            view: AppView::Chat,
        }
    }

    /// Notes a refusal: the oldest goes past `MAX_REFUSED`, and the URL is cut to `MAX_REFUSED_BYTES`.
    fn refuse(&mut self, what: &str, to: &url::Url) {
        let to = to.as_str();
        let mut end = to.len().min(MAX_REFUSED_BYTES);
        while !to.is_char_boundary(end) {
            end -= 1;
        }
        if self.refused.len() == MAX_REFUSED {
            self.refused.pop_front();
        }
        self.refused.push_back(format!("{what} {}", &to[..end]));
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

/// How long after the system's own tap or key in an app window its runner's `activity` still counts: the runner
/// says it for that same input, so it comes within milliseconds; this leaves room for a busy main thread.
const INPUT_FRESH: Duration = Duration::from_secs(2);

/// The system gave the app window `label`'s webview a tap or key (GTK's or AppKit's own event, on the main thread),
/// which a script in the page cannot make: its runner's `activity` counts for a moment (`admit`).
#[cfg_attr(
    any(test, not(any(target_os = "linux", target_os = "macos"))),
    allow(dead_code)
)]
fn heard_input<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(state) = app.try_state::<AppSandboxState>() {
        state.with(label, |window| window.input = Some(Instant::now()));
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

/// The largest IPC message the webview `label` may post, for `tauri::ipc::set_post_message_limit`: an app
/// window's is bounded, the Ghostly window's is not.
pub fn message_limit(label: &str) -> Option<usize> {
    is_app_label(label).then_some(MAX_MESSAGE_BYTES)
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

/// An app window's title: the Ghostly window's words for it, and whose window it is, outside the page.
fn window_title(title: &str) -> String {
    format!("{title} (Ghostly)")
}

/// The window, with every layer that does not depend on the platform.
/// An app window's answer to a permission request: never the microphone, the camera, the screen or the location.
fn capture_answer(kind: tauri::webview::PermissionKind) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind, PermissionResponse};
    match kind {
        PermissionKind::Microphone
        | PermissionKind::Camera
        | PermissionKind::DisplayCapture
        | PermissionKind::Geolocation => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

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
        .title(window_title(title))
        .on_navigation(move |to| {
            nav_app
                .state::<AppSandboxState>()
                .with(&nav_label, |window| {
                    let allowed = !window.guard.lock || may_navigate(to, window.started);
                    if !allowed {
                        window.refuse("navigation", to);
                    }
                    allowed
                })
                .unwrap_or(false)
        })
        // Never a window, never the system browser.
        .on_new_window(move |to, _| {
            new_app
                .state::<AppSandboxState>()
                .with(&new_label, |window| window.refuse("new window", &to));
            tauri::webview::NewWindowResponse::Deny
        })
        // Never a file saved by the window itself.
        .on_download(|_, event| crate::viewer::may_download(&event))
        // No app permission covers capture or location: refused outright. Without an answer of ours the webview
        // decides alone, and on macOS it grants the microphone and the camera with no question. Anything else keeps
        // the platform's own answer (on Linux an unanswered request is how pointer lock works today).
        .on_permission_request(|_, kind| capture_answer(kind))
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
            let (heard_app, heard_label) = (handle.clone(), label.clone());
            webkitgtk::watch_input(&webview, move || heard_input(&heard_app, &heard_label));
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
            let window = builder.build().map_err(|e| format!("Window: {e}"))?;
            // wry turns element full screen on as it builds the webview: off again, before the runner runs.
            window
                .with_webview(|platform| webkit::no_element_fullscreen(platform.inner()))
                .map_err(|e| format!("Window: {e}"))?;
            // Mouse look: WKWebView gives the pointer lock only when asked (webkit::allow_pointer_lock).
            let _ = window.with_webview(|platform| webkit::allow_pointer_lock(platform.inner()));
            let (heard_app, heard_label) = (handle.clone(), label.clone());
            window
                .with_webview(move |platform| {
                    webkit::watch_input(platform.inner(), move || {
                        heard_input(&heard_app, &heard_label)
                    })
                })
                .map_err(|e| format!("Window: {e}"))?;
            Ok(())
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
        .with(label, |window| window.refused.iter().cloned().collect())
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

/// The Ghostly window's page was replaced (a profile switch, a reload, the WebView back after its process died): the
/// brokers of the app windows it opened went with it. Those windows close, and their state goes with every request
/// still waiting, so none keeps showing the page before's app or asking a broker that is not there. The test
/// driver's windows have no broker and stay.
pub fn page_started<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppSandboxState>() else {
        return;
    };
    for label in forget_brokered(&state) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
}

/// Drops the state of every window a page's broker answers, and names them.
fn forget_brokered(state: &AppSandboxState) -> Vec<String> {
    let Ok(mut windows) = state.windows.lock() else {
        return Vec::new();
    };
    let labels: Vec<String> = windows
        .iter()
        .filter(|(_, window)| window.brokered)
        .map(|(label, _)| label.clone())
        .collect();
    for label in &labels {
        windows.remove(label);
    }
    labels
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
        .header("cache-control", "no-store")
        .header(
            "permissions-policy",
            "camera=(), microphone=(), display-capture=(), geolocation=()",
        );
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
                    // The runner says `activity` for the person's trusted taps and keys, but the app shares its realm
                    // and can call `app_broker` with it too. It reaches the lock screen only just after the system's
                    // own input in this window (`heard_input`); otherwise it is answered here, and goes no further.
                    if kind == Some("activity")
                        && window
                            .input
                            .is_none_or(|at| now.saturating_duration_since(at) >= INPUT_FRESH)
                    {
                        return Ok(Admitted::Answer(json!({ "id": id, "ok": true })));
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

/// Where the broker says a `file` answer's bytes lie in the file storage (`AppFileAt` in the engine).
#[derive(Deserialize)]
struct FileAt {
    space: String,
    id: String,
    offset: u64,
    length: u64,
    sha256: String,
}

/// A `file` answer the broker gave by reference (`{"id", "ok": true, "file": FileAt}`): the bytes, read from the
/// file storage off the main thread and checked against the SHA-256 the bundle's manifest gives them. Only an
/// app's bundle (`app-<digest>`), at most a bundle's size.
async fn file_bytes<R: Runtime>(
    app: &AppHandle<R>,
    answer: &Value,
) -> Option<Result<Vec<u8>, String>> {
    let at: FileAt = serde_json::from_value(answer.get("file")?.clone()).ok()?;
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    if !at.id.starts_with("app-") || at.length > MAX_FILE_BYTES {
        return Some(Err("failed".into()));
    }
    let base = match crate::file_store::base_of(app) {
        Ok(base) => base,
        Err(e) => return Some(Err(e)),
    };
    let read = tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::file_store::FileStore::new(base)
            .read(&at.space, &at.id, at.offset, at.length)?;
        if bytes.len() as u64 != at.length || !sha256_is(&bytes, &at.sha256) {
            return Err("failed".to_string());
        }
        Ok(bytes)
    })
    .await;
    Some(read.map_err(|e| e.to_string()).and_then(|r| r))
}

/// Whether `bytes` hash to `expected`, the manifest's base64url SHA-256.
fn sha256_is(bytes: &[u8], expected: &str) -> bool {
    use base64::Engine;
    use sha2::Digest;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(bytes)) == expected
}

/// The largest file an app's bundle may hold (WISP 1200: a bundle is at most 64 MiB).
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The one command an app window may call (`only_main` lets it through from `app-*` windows only). The
/// request is `{"id", "type", "args"}`; the result is the broker's answer, `{"id", "ok", "value" | "error"}`, or
/// for bytes `{"id", "ok", "bytes"}`, in base64, read here (`file_bytes`) or sent raw by the broker (`app_post_bytes`).
#[tauri::command]
pub async fn app_broker<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    request: Value,
) -> Result<tauri::ipc::Response, String> {
    let label = webview.label().to_string();
    let state = app.state::<AppSandboxState>();
    let (id, receiver) = match admit(&state, &label, &request, Instant::now())? {
        Admitted::Answer(answer) => return json_response(&answer),
        Admitted::Relay(id, receiver) => (id, receiver),
    };
    let sent = app.emit_to(
        "main",
        REQUEST_EVENT,
        json!({ "label": label, "request": request }),
    );
    let answer = match sent {
        Ok(()) => answer_to(&request, receiver).await,
        Err(_) => None,
    };
    state.with(&label, |window| window.pending.remove(&id));
    let Some(answer) = answer else {
        return Err("No answer".into());
    };
    match file_bytes(&app, &answer).await {
        Some(Ok(bytes)) => bytes_response(id, &bytes),
        Some(Err(_)) => json_response(&json!({ "id": id, "ok": false, "error": "failed" })),
        None => json_response(&answer),
    }
}

/// The broker's answer to `request`, or None when it never came. A file pick waits for the person as long as they
/// take, as on the web (WISP 1200: `cancelled` only when they pick nothing), up to `PICK_TIMEOUT` or until the
/// window goes and drops the sender; anything else waits `ANSWER_TIMEOUT`.
async fn answer_to(request: &Value, receiver: oneshot::Receiver<Value>) -> Option<Value> {
    let wait = if request.get("type").and_then(Value::as_str) == Some("files.pick") {
        PICK_TIMEOUT
    } else {
        ANSWER_TIMEOUT
    };
    tokio::time::timeout(wait, receiver).await.ok()?.ok()
}

/// A file's bytes for the app window, as base64 in the answer (`"bytes"`, which the runner decodes). Not raw: the
/// window's CSP and rule list block `ipc://`, so Tauri would eval a raw body into it as a JSON list of numbers,
/// about 3.6 characters a byte, slow to build, parse and hold, and on the GTK main loop the windows share.
fn bytes_response(id: u64, bytes: &[u8]) -> Result<tauri::ipc::Response, String> {
    json_response(&bytes_answer(id, bytes))
}

/// An answer that carries bytes, as the runner reads it: `{"id", "ok": true, "bytes"}`, the bytes in base64.
fn bytes_answer(id: u64, bytes: &[u8]) -> Value {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({ "id": id, "ok": true, "bytes": bytes })
}

/// An answer for the app window: its JSON text, sent as a JSON string, which the runner parses (`jsonOf`). Not the
/// JSON itself: Tauri evaluates an answer under 10 KiB into the window as a JavaScript literal, where a `__proto__`
/// member sets the object's prototype instead of being a key.
fn json_response(answer: &Value) -> Result<tauri::ipc::Response, String> {
    serde_json::to_string(answer)
        .and_then(|text| serde_json::to_string(&text))
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
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

/// The script that hands an event to the runner: the message's JSON text as a string literal (a JSON string is
/// one), which the runner parses. The message itself as a literal would not be read as JSON: a `__proto__` member,
/// which a contact's copy of the app may send, would set the object's prototype instead of being a key.
fn event_script(message: &Value) -> Result<String, String> {
    let json = serde_json::to_string(message)
        .and_then(|text| serde_json::to_string(&text))
        .map_err(|e| e.to_string())?;
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

/// An answer whose value is bytes (`files.read`, `remote.read`, a `file` the broker carried) from the Ghostly window's
/// broker (the Ghostly window only): the raw body is the bytes, `x-label` and `x-id` say which window's request it
/// answers. Turned into base64 here, as a `file` read by reference is (`bytes_response`): on the Ghostly window's
/// thread, a 1 MiB read cost ~2 ms of base64 and a 1.4 MB JSON string for `app_post`.
#[tauri::command]
pub async fn app_post_bytes<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("Missing {name}"))
    };
    let id = header("x-id")?.parse().map_err(|_| "Invalid id")?;
    post_bytes(&app, header("x-label")?, id, bytes)
}

/// The answer to `id` in window `label`: `bytes`, as the runner reads them (`bytes_answer`).
pub fn post_bytes<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    id: u64,
    bytes: &[u8],
) -> Result<(), String> {
    post(app, label, bytes_answer(id, bytes))
}

/// Names an app window anew (the Ghostly window only): "Chess · sharing a file with Ana" while the app serves the
/// contact a file (WISP 1200 § A read lane to the contact), as the web's panel header says it.
#[tauri::command]
pub fn app_title<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    title: String,
) -> Result<(), String> {
    if !is_app_label(&label) {
        return Err("Not an app window".into());
    }
    let window = app.get_webview_window(&label).ok_or("No app window")?;
    window
        .set_title(&window_title(&title))
        .map_err(|e| e.to_string())
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

/// Brings an app window to the front (the Ghostly window only): the person opened the app again in a chat where
/// it already runs, which shows its window rather than opening a second one.
#[tauri::command]
pub fn app_focus<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    if !is_app_label(&label) {
        return Err("Not an app window".into());
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether an app window has the focus (the Ghostly window only): a `files.pick` raises the Ghostly window with its
/// sheet, so an app the person is not in asks nothing. A window gone has no focus.
#[tauri::command]
pub fn app_focused<R: Runtime>(app: AppHandle<R>, label: String) -> Result<bool, String> {
    if !is_app_label(&label) {
        return Err("Not an app window".into());
    }
    Ok(app.get_webview_window(&label).is_some_and(|window| {
        window.is_focused().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    }))
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

/// The rule list of a window that shows a contact's app while Hide my IP from contacts is on (`viewer::open`):
/// every HTTP(S) and WS(S) load blocked, so the window reaches no server but through its own origin
/// (`ghostly-svc:`, served by the contact over the chat). Its CSP (`SERVICE_CSP_RELAY_ONLY`) says the same, but
/// WebKitGTK does not apply a CSP to `<link rel=preconnect>`, which opens a connection to the server it names.
/// One rule per scheme: WebKit refuses a `url-filter` with a disjunction (`|`), which WebKitGTK 2.52 reports as
/// "Disjunctions are not supported yet" and the list does not compile.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const RELAY_ONLY_RULES_ID: &str = "ghostly-svc-relay-only-1";
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const RELAY_ONLY_RULES: &str = r#"[{"trigger":{"url-filter":"^http:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ws:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss:"},"action":{"type":"block"}}]"#;

/// Which rule list a window gets. Each is compiled once and kept in its own slot (`slot`).
#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rules {
    /// An app window (`RULES`).
    App,
    /// An app window whose app the person granted `internet` (`NET_RULES`).
    Net,
    /// A contact's app opened while Hide my IP was on (`RELAY_ONLY_RULES`).
    RelayOnly,
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
impl Rules {
    /// How many there are: the size of each platform's cache of compiled lists.
    const COUNT: usize = 3;

    fn app(internet: bool) -> Rules {
        if internet {
            Rules::Net
        } else {
            Rules::App
        }
    }

    fn slot(self) -> usize {
        self as usize
    }

    /// Its id and its JSON.
    fn source(self) -> (&'static str, &'static str) {
        match self {
            Rules::App => (RULES_ID, RULES),
            Rules::Net => (NET_RULES_ID, NET_RULES),
            Rules::RelayOnly => (RELAY_ONLY_RULES_ID, RELAY_ONLY_RULES),
        }
    }
}

/// Adds a rule list to a window that is already built, on the main thread, then `done` there: how a contact's
/// app window opened under Hide my IP gets `Rules::RelayOnly` (`viewer::open`), whose requests wait for it
/// (`viewer::handle`). Linux keeps the compiled filter in the same store as the app windows'.
#[cfg(all(any(target_os = "macos", target_os = "linux"), not(test)))]
pub(crate) fn add_rules<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    rules: Rules,
    done: impl FnOnce(Result<(), String>) + Send + 'static,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let store = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cache: {e}"))?
        .join("app-filters");
    window
        .with_webview(move |platform| {
            #[cfg(target_os = "linux")]
            webkitgtk::add_rules(&platform.inner(), rules, &store, done);
            #[cfg(target_os = "macos")]
            webkit::add_rules(platform.inner(), rules, done);
        })
        .map_err(|e| format!("Window: {e}"))
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
pub(crate) mod webkit {
    use super::Guard;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::{NSArray, NSError, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebViewConfiguration};
    use std::cell::RefCell;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Runtime};

    use super::{Rules, OFF};

    thread_local! {
        /// Compiled once each, on the main thread, where WebKit wants them: one slot per `Rules`.
        static RULE_LISTS: RefCell<[Option<Retained<WKContentRuleList>>; Rules::COUNT]> = const { RefCell::new([None, None, None]) };
    }

    type Compiled = Result<Retained<WKContentRuleList>, String>;

    /// Compiles a rule list on the main thread and keeps it in its slot; then `done`, there, with it.
    fn compile(rules: Rules, done: impl FnOnce(Compiled) + 'static) {
        let Some(mtm) = MainThreadMarker::new() else {
            return done(Err("not the main thread".into()));
        };
        let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
            return done(Err("no rule list store".into()));
        };
        let (id, source) = rules.source();
        let done = std::cell::Cell::new(Some(done));
        let block =
            block2::RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
                let answer = match unsafe { Retained::retain(list) } {
                    Some(list) => {
                        RULE_LISTS
                            .with(|slots| slots.borrow_mut()[rules.slot()] = Some(list.clone()));
                        Ok(list)
                    }
                    None => Err(unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "rule list not compiled".into())),
                };
                if let Some(done) = done.take() {
                    done(answer);
                }
            });
        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&NSString::from_str(id)),
                Some(&NSString::from_str(source)),
                Some(&block),
            );
        }
    }

    /// Compiles a window's rule list, once, and waits for it. Not on the main thread, where WebKit answers.
    pub fn compile_rules<R: Runtime>(app: &AppHandle<R>, internet: bool) -> Result<(), String> {
        static COMPILED: [OnceLock<Result<(), String>>; Rules::COUNT] =
            [OnceLock::new(), OnceLock::new(), OnceLock::new()];
        let rules = Rules::app(internet);
        COMPILED[rules.slot()]
            .get_or_init(|| {
                let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
                app.run_on_main_thread(move || {
                    compile(rules, move |answer| {
                        let _ = tx.send(answer.map(|_| ()));
                    })
                })
                .map_err(|e| e.to_string())?;
                rx.recv_timeout(std::time::Duration::from_secs(10))
                    .map_err(|_| "rule list not compiled in time".to_string())?
            })
            .clone()
    }

    /// Adds a rule list to a web view already built (main thread): the one compiled before, or now. Its
    /// configuration is a copy, but the user content controller in it is the web view's own, so a list added
    /// there applies to every load after it, as the filter WebKitGTK adds to a built web view (`webkitgtk`).
    pub fn add_rules(
        webview: *mut std::ffi::c_void,
        rules: Rules,
        done: impl FnOnce(Result<(), String>) + 'static,
    ) {
        let Some(webview) = (unsafe { Retained::retain(webview as *mut AnyObject) }) else {
            return done(Err("no web view".into()));
        };
        let add = move |list: &WKContentRuleList| -> Result<(), String> {
            let config: Option<Retained<WKWebViewConfiguration>> =
                unsafe { msg_send![&*webview, configuration] };
            let config = config.ok_or("no configuration")?;
            unsafe { config.userContentController().addContentRuleList(list) };
            Ok(())
        };
        if let Some(list) = RULE_LISTS.with(|slots| slots.borrow()[rules.slot()].clone()) {
            return done(add(&list));
        }
        compile(rules, move |answer| {
            done(answer.and_then(|list| add(&list)))
        });
    }

    /// The pointer lock an app asks for (mouse look), which WKWebView gives only when its UI delegate answers
    /// `_webViewDidRequestPointerLock:completionHandler:` (private API, as `_features` below). wry's delegate does
    /// not, so the method is added to its class, once, and answers yes for a page on the `ghostly-app` scheme only:
    /// the class is the main window's delegate's too, and that window is told no. WebKit reads which methods a
    /// delegate has when the delegate is set, so the app window's delegate is set again after the method is added.
    /// The page still needs `allow-pointer-lock` in its sandbox (the runner's policy), and Esc frees the pointer.
    pub fn allow_pointer_lock(webview: *mut std::ffi::c_void) {
        let Some(webview) = (unsafe { (webview as *mut AnyObject).as_ref() }) else {
            return;
        };
        let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![webview, UIDelegate] };
        let Some(delegate) = delegate else {
            crate::diagnostics::log("app window: no UI delegate, no pointer lock");
            return;
        };
        let class = delegate.class();
        let selector = objc2::sel!(_webViewDidRequestPointerLock:completionHandler:);
        if !class.responds_to(selector) {
            let added = unsafe {
                objc2::ffi::class_addMethod(
                    class as *const AnyClass as *mut AnyClass,
                    selector,
                    std::mem::transmute::<
                        unsafe extern "C-unwind" fn(
                            &AnyObject,
                            objc2::runtime::Sel,
                            &AnyObject,
                            &block2::Block<dyn Fn(Bool)>,
                        ),
                        objc2::runtime::Imp,
                    >(did_request_pointer_lock),
                    c"v@:@@?".as_ptr(),
                )
            };
            if !added.as_bool() {
                crate::diagnostics::log("app window: pointer lock answer not added");
                return;
            }
        }
        let _: () = unsafe { msg_send![webview, setUIDelegate: &*delegate] };
    }

    /// An app window `watch_input` hears, by its `NSWindow`'s address, and what it calls on that window's input.
    type Heard = (usize, Box<dyn Fn()>);

    thread_local! {
        /// The app windows `watch_input` hears, by their `NSWindow` (main thread only): a later window at the same
        /// address takes its place, and one whose state is gone hears nothing (`heard_input`).
        static WATCHED: RefCell<Vec<Heard>> = const { RefCell::new(Vec::new()) };
    }

    /// `heard` on every mouse-down or key-down AppKit is about to hand the web view's window, before the page gets
    /// it: the system's input, which no script in the page can make (`heard_input`). One local monitor for the whole
    /// app, added once; every event goes on as it came.
    pub fn watch_input(webview: *mut std::ffi::c_void, heard: impl Fn() + 'static) {
        let Some(webview) = (unsafe { (webview as *mut AnyObject).as_ref() }) else {
            return;
        };
        let window: *mut AnyObject = unsafe { msg_send![webview, window] };
        if window.is_null() {
            crate::diagnostics::log("app window: no NSWindow, its input not heard");
            return;
        }
        let first = WATCHED.with(|watched| {
            let mut watched = watched.borrow_mut();
            let first = watched.is_empty();
            watched.retain(|(at, _)| *at != window as usize);
            watched.push((window as usize, Box::new(heard)));
            first
        });
        if !first {
            return;
        }
        let Some(class) = AnyClass::get(c"NSEvent") else {
            return;
        };
        // NSEventMask: left, right and other mouse down, key down.
        let mask: u64 = (1 << 1) | (1 << 3) | (1 << 10) | (1 << 25);
        let handler = block2::RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
            if let Some(event) = unsafe { event.as_ref() } {
                let window: *mut AnyObject = unsafe { msg_send![event, window] };
                WATCHED.with(|watched| {
                    for (at, heard) in watched.borrow().iter() {
                        if *at == window as usize {
                            heard();
                        }
                    }
                });
            }
            event
        });
        let monitor: Option<Retained<AnyObject>> = unsafe {
            msg_send![class, addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
        };
        // AppKit keeps the monitor for as long as the app runs; it is never removed.
        std::mem::forget(monitor);
    }

    /// Element full screen off in an app window: its title bar, with "(Ghostly)", stays. wry turns it on for every
    /// webview it builds (macOS 12.3+), so this runs after the build, on the live preferences the configuration
    /// shares (as `fullscreen::install` does to turn it on in the Ghostly window).
    pub fn no_element_fullscreen(webview: *mut std::ffi::c_void) {
        let Some(webview) = (unsafe { (webview as *mut AnyObject).as_ref() }) else {
            return;
        };
        let configuration: Option<Retained<AnyObject>> =
            unsafe { msg_send![webview, configuration] };
        let preferences: Option<Retained<AnyObject>> =
            configuration.and_then(|c| unsafe { msg_send![&*c, preferences] });
        match preferences {
            Some(preferences) => forbid_fullscreen(&preferences),
            None => {
                crate::diagnostics::log("app window: no preferences, full screen left as it is")
            }
        }
    }

    /// The public switch (macOS 12.3+) off, or on older WebKit the private key wry sets.
    pub fn forbid_fullscreen(preferences: &AnyObject) {
        let public: Bool = unsafe {
            msg_send![preferences, respondsToSelector: objc2::sel!(setElementFullscreenEnabled:)]
        };
        if public.as_bool() {
            let _: () = unsafe { msg_send![preferences, setElementFullscreenEnabled: Bool::NO] };
        } else {
            let no = objc2_foundation::NSNumber::new_bool(false);
            let key = NSString::from_str("fullScreenEnabled");
            let _: () = unsafe { msg_send![preferences, setValue: &*no, forKey: &*key] };
        }
    }

    /// Whether a web view shows the runner (`ghostly-app://`), which alone may hold the pointer.
    pub fn is_runner_view(webview: &AnyObject) -> bool {
        let url: Option<Retained<AnyObject>> = unsafe { msg_send![webview, URL] };
        let Some(url) = url else { return false };
        let text: Option<Retained<NSString>> = unsafe { msg_send![&*url, absoluteString] };
        text.is_some_and(|t| url::Url::parse(&t.to_string()).is_ok_and(|u| super::is_runner(&u)))
    }

    unsafe extern "C-unwind" fn did_request_pointer_lock(
        _this: &AnyObject,
        _cmd: objc2::runtime::Sel,
        webview: &AnyObject,
        completion: &block2::Block<dyn Fn(Bool)>,
    ) {
        completion.call((Bool::new(is_runner_view(webview)),));
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
                .with(|slots| slots.borrow()[Rules::app(internet).slot()].clone())
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

/// An app window's `WebKitSettings` on Linux. Never element full screen, whatever the guard: it would take the
/// title bar, and with it "(Ghostly)", and WebKitGTK 2.50 aborts the whole app on it (`fullscreen.rs`).
#[cfg(target_os = "linux")]
fn app_settings(settings: &webkit2gtk::Settings, guard: Guard) {
    use webkit2gtk::SettingsExt;
    settings.set_enable_fullscreen(false);
    if guard.prefs {
        settings.set_enable_dns_prefetching(false);
        settings.set_enable_webrtc(false);
    }
    if guard.webrtc {
        settings.set_enable_webrtc(true);
    }
}

/// The WebKitGTK side of an app window on Linux, the counterpart of `webkit`: a user content filter made from
/// the same rule list (public API, required), and `WebKitSettings` for DNS prefetch and WebRTC (public API,
/// best effort). WebKitGTK has no switch for `<link rel=preconnect>`: the filter is what is measured for it.
#[cfg(all(target_os = "linux", not(test)))]
mod webkitgtk {
    use super::{Guard, Rules};
    use std::cell::RefCell;
    use std::path::Path;
    use webkit2gtk::glib::translate::{FromGlibPtrFull, ToGlibPtr};
    use webkit2gtk::{ffi, gio, glib, WebViewExt};

    /// A filter, kept with a reference of its own.
    struct Filter(*mut ffi::WebKitUserContentFilter);

    thread_local! {
        /// Made once each, on the GTK thread, where WebKitGTK answers: one slot per `Rules`.
        static FILTERS: RefCell<[Option<Filter>; Rules::COUNT]> = const { RefCell::new([None, None, None]) };
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

    /// `heard` on every tap, click or key GTK hands the webview itself, before the page gets it: the system's input,
    /// which no script in the page can make (`heard_input`). The page still gets each one.
    pub fn watch_input(webview: &webkit2gtk::WebView, heard: impl Fn() + 'static) {
        use gtk::prelude::WidgetExt;
        let heard = std::rc::Rc::new(heard);
        let pressed = heard.clone();
        webview.connect_button_press_event(move |_, _| {
            pressed();
            glib::Propagation::Proceed
        });
        let typed = heard.clone();
        webview.connect_key_press_event(move |_, _| {
            typed();
            glib::Propagation::Proceed
        });
        webview.connect_touch_event(move |_, event| {
            if event.event_type() == gtk::gdk::EventType::TouchBegin {
                heard();
            }
            glib::Propagation::Proceed
        });
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
            super::app_settings(&settings, guard);
        }
        if !guard.rules {
            return done(Ok(()));
        }
        add_rules(webview, Rules::app(internet), store, done);
    }

    /// A rule list's filter added to the web view, now or once it is made; then `done`. Made once per `Rules`.
    pub fn add_rules(
        webview: &webkit2gtk::WebView,
        rules: Rules,
        store: &Path,
        done: impl FnOnce(Result<(), String>) + 'static,
    ) {
        let slot = rules.slot();
        if let Some(filter) = FILTERS.with(|slots| slots.borrow()[slot].as_ref().map(|f| f.0)) {
            return done(add(webview, filter));
        }
        let (rules_id, rules) = rules.source();
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

    #[test]
    fn a_file_answer_by_reference_is_the_stored_bytes_checked_against_their_hash() {
        let dir = std::env::temp_dir().join(format!("ghostly-app-file-{}", std::process::id()));
        let files = crate::file_store::FileStore::new(dir.clone());
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        files.append("ghostly-a", "app-digest", 0, &bytes).unwrap();
        files.flush("ghostly-a", "app-digest").unwrap();
        let app = mock_builder()
            .manage(AppSandboxState::default())
            .manage(crate::file_store::FileStore::new(dir.clone()))
            .build(tauri::generate_context!(test = true))
            .expect("app");
        let handle = app.handle();
        let hash = |part: &[u8]| {
            use base64::Engine;
            use sha2::Digest;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(part))
        };
        let answer = |id: &str, offset: u64, length: u64, sha256: &str| json!({ "id": 7, "ok": true, "file": { "space": "ghostly-a", "id": id, "offset": offset, "length": length, "sha256": sha256 } });
        let read = |answer: Value| tauri::async_runtime::block_on(file_bytes(handle, &answer));
        // A file inside the bundle: its bytes, as they are on disk.
        let part = &bytes[1000..201_000];
        assert_eq!(
            read(answer("app-digest", 1000, 200_000, &hash(part))),
            Some(Ok(part.to_vec()))
        );
        // Bytes that do not hash to what the manifest says, a file outside the apps' bundles, or past a bundle's size: refused.
        assert_eq!(
            read(answer("app-digest", 1001, 200_000, &hash(part))),
            Some(Err("failed".into()))
        );
        assert_eq!(
            read(answer("chat-in-x", 1000, 200_000, &hash(part))),
            Some(Err("failed".into()))
        );
        assert_eq!(
            read(answer("app-digest", 0, 65 * 1024 * 1024, &hash(part))),
            Some(Err("failed".into()))
        );
        // Any other answer is passed on as the broker wrote it.
        assert_eq!(read(json!({ "id": 7, "ok": true, "value": 1 })), None);
        assert_eq!(
            read(json!({ "id": 7, "ok": false, "error": "no-file" })),
            None
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An app window has no raw IPC body (its CSP and rule list block `ipc://`): a raw answer would reach it as an
    /// eval'd list of numbers. The bytes go as base64 in a JSON answer, which the runner decodes (`bytesOf`).
    #[test]
    fn a_file_answer_reaches_the_app_window_as_base64_json() {
        use base64::Engine;
        let bytes: Vec<u8> = (0..70_000u32).map(|i| (i % 253) as u8).collect();
        let response = bytes_response(7, &bytes).unwrap();
        let json = match tauri::ipc::IpcResponse::body(response).unwrap() {
            tauri::ipc::InvokeResponseBody::Json(json) => json,
            tauri::ipc::InvokeResponseBody::Raw(_) => panic!("a raw answer, not JSON"),
        };
        let text: String = serde_json::from_str(&json).unwrap();
        let answer: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(answer["id"], 7);
        assert_eq!(answer["ok"], true);
        let sent = answer["bytes"].as_str().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(sent)
                .unwrap(),
            bytes
        );
        assert!(RUNNER.contains(
            r#"return typeof answer.bytes === "string" ? bytesOf(answer.bytes) : answer.value;"#
        ));
        assert!(!RUNNER.contains("new Uint8Array(answer)"));
    }

    /// Tauri evaluates an answer under 10 KiB into the app window as a JavaScript literal: the answer goes as its JSON
    /// text, a JSON string, which the runner parses (`jsonOf`), so a `__proto__` member stays a key.
    #[test]
    fn an_answer_reaches_the_app_window_as_json_text() {
        let answer =
            json!({"id": 3, "ok": true, "value": {"board": "e4", "__proto__": {"admin": true}}});
        let json = match tauri::ipc::IpcResponse::body(json_response(&answer).unwrap()).unwrap() {
            tauri::ipc::InvokeResponseBody::Json(json) => json,
            tauri::ipc::InvokeResponseBody::Raw(_) => panic!("a raw answer, not JSON"),
        };
        assert_eq!(
            json,
            r#""{\"id\":3,\"ok\":true,\"value\":{\"__proto__\":{\"admin\":true},\"board\":\"e4\"}}""#
        );
        let text: String = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), answer);
        assert!(RUNNER.contains(r#"invoke("app_broker", { request }).then(jsonOf)"#));
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

    /// No microphone, camera, screen or location for an app: no app permission covers them. Without a handler wry
    /// grants a capture on macOS with no question, so every app window carries one that refuses, and the runner is
    /// served with a policy that turns the features off.
    #[test]
    fn an_app_window_never_captures() {
        let source = include_str!("app_sandbox.rs");
        let start = source.find("fn window_builder<").unwrap();
        let body = &source[start..start + source[start..].find("\n}\n").unwrap()];
        assert!(body.contains(".on_permission_request("), "window_builder");
        use tauri::webview::{PermissionKind, PermissionResponse};
        for kind in [
            PermissionKind::Microphone,
            PermissionKind::Camera,
            PermissionKind::DisplayCapture,
            PermissionKind::Geolocation,
        ] {
            assert!(matches!(capture_answer(kind), PermissionResponse::Deny));
        }
        assert!(matches!(
            capture_answer(PermissionKind::PointerLock),
            PermissionResponse::Default
        ));
        let app = app();
        app.state::<AppSandboxState>()
            .windows
            .lock()
            .unwrap()
            .insert("app-1".into(), window("ana/chess", true, true));
        let request = Request::builder()
            .uri("ghostly-app://localhost/")
            .body(Vec::new())
            .unwrap();
        let served = handle(app.handle(), "app-1", &request);
        assert_eq!(
            served.headers()["permissions-policy"],
            "camera=(), microphone=(), display-capture=(), geolocation=()"
        );
    }

    #[test]
    fn the_policies_are_the_wisps() {
        for policy in [RUNNER_CSP, NET_RUNNER_CSP] {
            for directive in [
                "sandbox allow-scripts allow-pointer-lock;",
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
        // The whole request, as JSON: 66 KiB passes, a byte more does not.
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
        // A stored value's 64 KiB (WISP 1200) under the longest key, 256 control characters at six bytes each in JSON.
        let longest = json!({"id": 4, "type": "storage.set", "args": ["\u{1}".repeat(256), "x".repeat(64 * 1024 - 2)]});
        assert!(matches!(
            admitted(&state, "app-1", longest),
            Ok(Admitted::Relay(4, _))
        ));
    }

    /// An app window's IPC message is bounded before Tauri parses it, with room for the broker's largest request
    /// in Tauri's envelope; the Ghostly window's is not. `run()` sets the bound before any window opens.
    #[test]
    fn an_app_windows_message_is_bounded_before_tauri_parses_it() {
        let request = json!({"id": MAX_ID, "type": "storage.set", "args": ["k", "x".repeat(MAX_REQUEST_BYTES)]});
        let message = json!({
            "cmd": "app_broker", "callback": u32::MAX, "error": u32::MAX, "payload": {"request": request},
            "options": {"headers": {}, "customProtocolIpcBlocked": true}, "__TAURI_INVOKE_KEY__": "k".repeat(64),
        });
        let limit = message_limit("app-0123456789abcdef").unwrap();
        assert!(serde_json::to_vec(&message).unwrap().len() <= limit);
        assert!(limit <= 256 * 1024, "parsed in a few milliseconds");
        for label in ["main", "svc-1", "app-", "App-1", "xapp-1"] {
            assert_eq!(message_limit(label), None, "{label}");
        }
        assert!(include_str!("lib.rs")
            .contains("tauri::ipc::set_post_message_limit(app_sandbox::message_limit);"));
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

    /// The app can call `app_broker` itself and say `activity` with no one there: the Ghostly window hears it only
    /// just after the window's webview had a tap or key from the system, which no script can make.
    #[test]
    fn activity_reaches_the_broker_only_after_the_systems_own_input() {
        let state = state(&[("app-1", "ana/chess")]);
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert!(admit(&state, "app-1", &json!({"type": "start"}), at(0)).is_ok());
        let activity = |id: u64| json!({"id": id, "type": "activity", "args": []});
        // Said by the app alone: answered here, and the broker never hears it.
        let unheard = |id: u64, ms: u64, label: &str| {
            let admitted = admit(&state, label, &activity(id), at(ms)).unwrap();
            match admitted {
                Admitted::Answer(answer) => assert_eq!(answer, json!({"id": id, "ok": true})),
                other => panic!("{other:?}"),
            }
        };
        unheard(1, 10, "app-1");
        assert!(state.with("app-1", |w| w.pending.is_empty()).unwrap());
        // Just after the system's own tap or key in the window, the runner's `activity` goes to the broker.
        state.with("app-1", |w| w.input = Some(at(1_000)));
        assert!(matches!(
            admit(&state, "app-1", &activity(2), at(1_005)),
            Ok(Admitted::Relay(2, _))
        ));
        // Long after it, the app's own does not, nor does input in another window count for this one.
        unheard(3, 1_000 + INPUT_FRESH.as_millis() as u64, "app-1");
        state.with("app-1", |w| w.input = None);
        let other = state
            .windows
            .lock()
            .unwrap()
            .insert("app-2".into(), window("bob/snake", true, true));
        assert!(other.is_none());
        assert!(admit(&state, "app-2", &json!({"type": "start"}), at(3_000)).is_ok());
        state.with("app-2", |w| w.input = Some(at(3_000)));
        unheard(4, 3_010, "app-1");
        // Any other request goes on as before.
        assert!(matches!(
            admit(
                &state,
                "app-1",
                &json!({"id": 5, "type": "context", "args": []}),
                at(3_020)
            ),
            Ok(Admitted::Relay(5, _))
        ));
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

    /// `files.read` and `remote.read`: the broker sends the bytes raw (`app_post_bytes`), and the request waiting gets
    /// them as the runner reads a file's, base64 made here rather than on the Ghostly window's thread.
    #[test]
    fn bytes_reach_the_request_of_their_window_as_the_runner_reads_them() {
        let app = app();
        let state = app.state::<AppSandboxState>();
        {
            let mut windows = state.windows.lock().unwrap();
            windows.insert("app-1".into(), window("ana/cinema", true, true));
            windows.insert("app-2".into(), window("bob/snake", true, true));
        }
        started(&state, "app-1");
        started(&state, "app-2");
        let request =
            json!({"id": 6, "type": "files.read", "args": ["f", {"offset": 0, "length": 5}]});
        let Admitted::Relay(_, mut first) = admitted(&state, "app-1", request.clone()).unwrap()
        else {
            panic!("relayed")
        };
        let Admitted::Relay(_, mut second) = admitted(&state, "app-2", request).unwrap() else {
            panic!("relayed")
        };
        post_bytes(app.handle(), "app-1", 6, &[0, 1, 2, 250, 255]).unwrap();
        assert_eq!(
            first.try_recv().unwrap(),
            json!({"id": 6, "ok": true, "bytes": "AAEC+v8="})
        );
        assert!(second.try_recv().is_err(), "app-2's request still waits");
        for label in ["main", "svc-1", "app-"] {
            assert!(post_bytes(app.handle(), label, 6, &[1]).is_err(), "{label}");
        }
        assert_eq!(
            post_bytes(app.handle(), "app-9", 6, &[1]).unwrap_err(),
            "No app window"
        );
    }

    /// A pick waits for the person as long as they take, within `PICK_TIMEOUT` (as on the web); it ends when the
    /// window goes. Anything else gives up after `ANSWER_TIMEOUT` (1 s under test).
    #[test]
    fn a_pick_waits_for_the_person_past_the_answer_timeout() {
        let late = |kind: &str, after: Duration| {
            let (sender, receiver) = oneshot::channel();
            std::thread::spawn(move || {
                std::thread::sleep(after);
                let _ = sender.send(json!({"id": 3, "ok": true, "value": []}));
            });
            let request = json!({"id": 3, "type": kind, "args": []});
            tauri::async_runtime::block_on(answer_to(&request, receiver))
        };
        let slow = ANSWER_TIMEOUT + Duration::from_millis(500);
        assert_eq!(
            late("files.pick", slow),
            Some(json!({"id": 3, "ok": true, "value": []}))
        );
        assert_eq!(late("storage.keys", slow), None);
        // The window closed (its state and the waiting sender dropped): the pick ends at once.
        let (sender, receiver) = oneshot::channel::<Value>();
        drop(sender);
        let request = json!({"id": 3, "type": "files.pick", "args": []});
        assert_eq!(
            tauri::async_runtime::block_on(answer_to(&request, receiver)),
            None
        );
    }

    #[test]
    fn an_event_is_handed_to_the_runners_receiver_as_json_text() {
        let script =
            event_script(&json!({"event": "chat.message", "data": {"m": "e4\u{2028}</script>"}}))
                .unwrap();
        assert_eq!(
            script,
            "window.__ghostlyEvent(\"{\\\"data\\\":{\\\"m\\\":\\\"e4\u{2028}</script>\\\"},\\\"event\\\":\\\"chat.message\\\"}\")"
        );
        // A `__proto__` member a contact sent stays a key: the runner parses the text (apps/ui desktopRunner.test.ts
        // evaluates this script), where a JavaScript object literal would take it as the object's prototype.
        let message =
            json!({"event": "chat.message", "data": {"move": "e4", "__proto__": {"admin": true}}});
        let script = event_script(&message).unwrap();
        assert_eq!(
            script,
            r#"window.__ghostlyEvent("{\"data\":{\"__proto__\":{\"admin\":true},\"move\":\"e4\"},\"event\":\"chat.message\"}")"#
        );
        let argument = script
            .strip_prefix("window.__ghostlyEvent(")
            .and_then(|rest| rest.strip_suffix(')'))
            .unwrap();
        let text: String = serde_json::from_str(argument).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), message);
        assert!(RUNNER.contains("const message = jsonOf(text);"));
        assert!(RUNNER.contains("Object.defineProperty(window, \"__ghostlyEvent\""));
        // The receiver and `window.ghostly` are defined before the entry is written.
        let receiver = RUNNER.find("__ghostlyEvent").unwrap();
        let api = RUNNER.find("\"ghostly\"").unwrap();
        let write = RUNNER.find("document.write(entry)").unwrap();
        assert!(receiver < write && api < write);
    }

    /// The quoted strings in `text`, in order.
    fn quoted(text: &str) -> Vec<&str> {
        text.split('"').skip(1).step_by(2).collect()
    }

    /// The list that starts at `marker` (`const CODES = [` in a runner, `MINI_APP_ERROR_CODES = [` in the SDK).
    fn code_list<'a>(source: &'a str, marker: &str) -> Vec<&'a str> {
        let start = source.find(marker).unwrap_or_else(|| panic!("no {marker}")) + marker.len();
        let end = start + source[start..].find(']').unwrap();
        quoted(&source[start..end])
    }

    /// A failed `ghostly.*` call rejects with one of the SDK's codes (`MINI_APP_ERROR_CODES` in
    /// packages/core/src/miniApp.ts, `@ghostlytools/sdk/app`): both runners keep that very list, and every code
    /// `admit` refuses with is in it. Its other words ("Not started", "No answer") reach the app as `failed`.
    #[test]
    fn every_refusal_is_one_of_the_sdks_codes() {
        let sdk = code_list(
            include_str!("../../../packages/core/src/miniApp.ts"),
            "export const MINI_APP_ERROR_CODES = [",
        );
        assert!(
            sdk.contains(&"failed") && sdk.contains(&"bad-request"),
            "{sdk:?}"
        );
        let web = include_str!("../../web/public/app-frame.html");
        assert_eq!(code_list(RUNNER, "const CODES = ["), sdk, "desktop runner");
        assert_eq!(code_list(web, "const CODES = ["), sdk, "web runner");
        for runner in [RUNNER, web] {
            assert!(!runner.contains("Not a JSON value"));
            assert!(runner.contains(r#"refusal("bad-request")"#));
        }

        let source = include_str!("app_sandbox.rs");
        let admit = &source[source.find("pub fn admit(").unwrap()
            ..source.find("pub async fn app_broker").unwrap()];
        let mut codes = Vec::new();
        for marker in [r#"Err(""#, r#"ok_or(""#] {
            for piece in admit.split(marker).skip(1) {
                let literal = &piece[..piece.find('"').unwrap()];
                if !literal.is_empty()
                    && literal.chars().all(|c| c.is_ascii_lowercase() || c == '-')
                {
                    codes.push(literal);
                }
            }
        }
        for code in ["too-fast", "too-large", "bad-request"] {
            assert!(codes.contains(&code), "{codes:?}");
        }
        for code in codes {
            assert!(
                sdk.contains(&code),
                "admit refuses with {code}, which MINI_APP_ERROR_CODES does not name"
            );
        }
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
            "pick: (options) => send(\"files.pick\", options === undefined ? [] : [options])",
            "list: call(\"files.list\")",
            "read: (id, range) => send(\"files.read\", [id, range])",
            "forget: (id) => send(\"files.forget\", [id]).then(() => undefined)",
            "serve: (id) => send(\"files.serve\", [id])",
            "unserve: (serveId) => send(\"files.unserve\", [serveId]).then(() => undefined)",
            "read: (serveId, range) => send(\"remote.read\", [serveId, range])",
            "stat: (serveId) => send(\"remote.stat\", [serveId])",
            "chat.on takes \\\"message\\\" or \\\"peer\\\" and a function",
        ] {
            assert!(RUNNER.contains(call), "desktop: {call}");
            assert!(web.contains(call), "web: {call}");
        }
        assert!(RUNNER.contains("delete window[name]"));
    }

    /// Both runners answer false to an app's clipboard commands (`execCommand` copy, cut, paste) with the very same
    /// wrapper and delete the async Clipboard API with the very same code, before the app's code is written, and
    /// refuse to run when either is not in place.
    #[test]
    fn the_runners_refuse_the_clipboard_commands_alike() {
        let web = include_str!("../../web/public/app-frame.html");
        let begin = "const execCommand = Document.prototype.execCommand;";
        let finish = "value: commands });\n  }\n";
        let wrapper = |runner: &'static str| {
            let start = runner.find(begin).unwrap();
            let end = start + runner[start..].find(finish).unwrap();
            (start, &runner[start..end])
        };
        let (at, desktop) = wrapper(RUNNER);
        assert_eq!(desktop, wrapper(web).1);
        let refused =
            r#"if (named === "copy" || named === "cut" || named === "paste") return false;"#;
        assert!(desktop.contains(refused));
        let check = r#"if (document.execCommand !== commands || clipboardLeft()) return stop("clipboard");"#;
        let check = RUNNER.find(check).unwrap();
        assert!(at < check);
        assert!(web.contains(
            r#"if (document.execCommand !== commands || clipboardLeft()) return stop("clipboard");"#
        ));
        // The async Clipboard API is deleted with the very same text, before the check.
        let api = |runner: &'static str| {
            let start = runner.find("const CLIPBOARD = [").unwrap();
            let end = start + runner[start..].find("const stop = ").unwrap();
            (start, &runner[start..end])
        };
        let (deleted, desktop) = api(RUNNER);
        assert_eq!(desktop, api(web).1);
        for line in [
            r#"const CLIPBOARD = ["read", "readText", "write", "writeText"];"#,
            "delete Navigator.prototype.clipboard;",
            "delete window.ClipboardItem;",
            "delete Clipboard.prototype[name];",
            r#""clipboard" in navigator || "ClipboardItem" in window"#,
        ] {
            assert!(desktop.contains(line), "{line}");
        }
        assert!(deleted < check);
        for later in [
            "const invoke = ",
            "document.open()",
            "document.write(entry)",
        ] {
            assert!(check < RUNNER.find(later).unwrap(), "{later}");
        }
    }

    /// The person's copy or cut in an app puts what they selected on the clipboard: both runners stop it before any of
    /// the app's listeners with the very same text, added after `document.open` (which drops a window's listeners) and
    /// before the entry is written, through what each took before the app's code runs, and put back whenever the
    /// document is opened again.
    #[test]
    fn the_runners_keep_the_persons_copy_alike() {
        let web = include_str!("../../web/public/app-frame.html");
        let begin = "    // The person's copy or cut in the app";
        let finish = "        keepListeners();\n        return result;\n      } });\n    }\n";
        let guard = |runner: &'static str| {
            let start = runner.find(begin).unwrap();
            let end = start + runner[start..].find(finish).unwrap() + finish.len();
            (start, &runner[start..end])
        };
        let (at, desktop) = guard(RUNNER);
        let (web_at, web_guard) = guard(web);
        assert_eq!(desktop, web_guard);
        for line in [
            r#"if (event.isTrusted === true) reflectApply(stopImmediately, event, []);"#,
            r#"reflectApply(listen, window, ["copy", selectionOnly, true]);"#,
            r#"reflectApply(listen, window, ["cut", selectionOnly, true]);"#,
            r#"for (const name of ["open", "write", "writeln"]) {"#,
        ] {
            assert!(desktop.contains(line), "{line}");
        }
        assert!(RUNNER.find("document.open()").unwrap() < at);
        assert!(at < RUNNER.find("document.write(entry)").unwrap());
        assert!(web.find("    document.open();").unwrap() < web_at);
        assert!(
            web_at
                < web
                    .find("reflectApply(documentWrite, document, [html]);")
                    .unwrap()
        );
        for (runner, written) in [(RUNNER, at), (web, web_at)] {
            for taken in [
                "const reflectApply = Reflect.apply;",
                "const listen = EventTarget.prototype.addEventListener;",
                "const stopImmediately = Event.prototype.stopImmediatePropagation;",
            ] {
                assert!(runner.find(taken).unwrap() < written, "{taken}");
            }
        }
    }

    /// An app that opens its document again (`document.open` with no close, or a write once the page is parsed) erases
    /// the window's listeners and runs on: each runner puts every listener it adds after its own `document.open` back on
    /// as the document opens, not only the copy guard. On the web: the one that keeps other frames' messages out and the
    /// one that makes a "#" link a reload; on both: the one that says `activity` for the person's taps and keys.
    #[test]
    fn the_runners_put_every_listener_back_when_the_document_opens_again() {
        let web = include_str!("../../web/public/app-frame.html");
        let wrapper = "        const result = reflectApply(opens, this, arguments);\n        keepListeners();\n";
        let keep = "    const keepListeners = () => {\n      keepRunnerListeners();\n";
        for (name, runner, opened, written, listeners) in [
            (
                "desktop",
                RUNNER,
                "document.open();",
                "document.write(entry);",
                &[
                    r#"["pointerdown", heard, true]"#,
                    r#"["keydown", heard, true]"#,
                ][..],
            ),
            (
                "web",
                web,
                "    document.open();",
                "reflectApply(documentWrite, document, [html]);",
                &[
                    r#"["message", deaf, true]"#,
                    r#"["messageerror", deaf, true]"#,
                    r#"["hashchange", fragment, true]"#,
                    r#"["pointerdown", heard, true]"#,
                    r#"["keydown", heard, true]"#,
                ][..],
            ),
        ] {
            let start = runner.find(opened).unwrap();
            let end = runner.find(written).unwrap();
            let section = &runner[start..end];
            assert!(section.contains(wrapper), "{name}");
            assert!(section.contains(keep), "{name}");
            let begin = "    const keepRunnerListeners = () => {\n";
            let own = section.find(begin).unwrap_or_else(|| panic!("{name}"));
            let own = &section[own + begin.len()..];
            let own = &own[..own.find("    };\n").unwrap()];
            let added: Vec<&str> = own.lines().map(str::trim).collect();
            let expected: Vec<String> = listeners
                .iter()
                .map(|args| format!("reflectApply(listen, window, {args});"))
                .collect();
            assert_eq!(added, expected, "{name}");
            // Every listener the runner adds on the window from its `document.open` on is one of those it puts back.
            assert_eq!(
                section.matches("reflectApply(listen, window, [").count(),
                listeners.len() + 2,
                "{name}"
            );
            assert!(!section.contains("addEventListener("), "{name}");
        }
    }

    /// Both runners say `activity` for the person's trusted taps and keys, so the lock screen counts input in an app,
    /// and listen before the app's code runs (after `document.open`, which drops a window's listeners).
    #[test]
    fn the_runners_say_activity_for_trusted_taps_and_keys() {
        let web = include_str!("../../web/public/app-frame.html");
        for (name, runner) in [("desktop", RUNNER), ("web", web)] {
            assert!(
                runner.contains("if (event.isTrusted !== true) return;"),
                "{name}"
            );
            assert!(runner.contains("send(\"activity\", [])"), "{name}");
            for event in ["\"pointerdown\", heard, true", "\"keydown\", heard, true"] {
                let at = runner
                    .find(event)
                    .unwrap_or_else(|| panic!("{name}: {event}"));
                assert!(
                    runner.find("document.open()").unwrap() < at,
                    "{name}: {event}"
                );
            }
        }
        assert!(
            RUNNER.find("\"keydown\", heard, true").unwrap()
                < RUNNER.find("document.write(entry)").unwrap()
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
        assert_eq!(Rules::app(false).source(), (RULES_ID, RULES));
        assert_eq!(Rules::app(true).source(), (NET_RULES_ID, NET_RULES));
        assert_ne!(RULES_ID, NET_RULES_ID);
    }

    /// A contact's app opened under Hide my IP: every HTTP(S) and WS(S) load blocked, preconnect included, which
    /// WebKitGTK's CSP lets through (measured); its own origin (`ghostly-svc:`), and the inline, data: and blob:
    /// content its policy allows, never matched. Its own list, compiled and kept apart from the app windows'.
    #[test]
    fn the_relay_only_rule_list_blocks_every_http_and_ws_load_but_never_the_apps_own_origin() {
        let rules: Value = serde_json::from_str(RELAY_ONLY_RULES).unwrap();
        assert_eq!(
            rules,
            json!([
                {"trigger": {"url-filter": "^http:"}, "action": {"type": "block"}},
                {"trigger": {"url-filter": "^https:"}, "action": {"type": "block"}},
                {"trigger": {"url-filter": "^ws:"}, "action": {"type": "block"}},
                {"trigger": {"url-filter": "^wss:"}, "action": {"type": "block"}},
            ])
        );
        // What each filter matches, as WebKit reads it: `^scheme:`, anchored at the start, case-insensitive.
        let schemes: Vec<String> = rules
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| {
                let filter = rule["trigger"]["url-filter"].as_str().unwrap();
                let scheme = filter.strip_prefix('^').unwrap().strip_suffix(':').unwrap();
                assert!(scheme.chars().all(|c| c.is_ascii_lowercase()), "{filter}");
                format!("{scheme}:")
            })
            .collect();
        let blocked = |url: &str| {
            let url = url.to_ascii_lowercase();
            schemes
                .iter()
                .any(|scheme| url.starts_with(scheme.as_str()))
        };
        for out in [
            "http://127.0.0.1:7862/",
            "https://contact.example/p.png",
            "HTTPS://contact.example/",
            "ws://contact.example/live",
            "wss://contact.example/live",
        ] {
            assert!(blocked(out), "{out}");
        }
        let own_origin = format!("{}://atlas.peer.ybndrfg8ejkmcpqx/", crate::viewer::SCHEME);
        for own in [
            own_origin.as_str(),
            "data:image/png;base64,AAAA",
            "blob:ghostly-svc://atlas.peer.ybndrfg8ejkmcpqx/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
            "about:blank",
        ] {
            assert!(!blocked(own), "{own}");
        }
        assert_eq!(
            Rules::RelayOnly.source(),
            (RELAY_ONLY_RULES_ID, RELAY_ONLY_RULES)
        );
        let all = [Rules::App, Rules::Net, Rules::RelayOnly];
        let ids: std::collections::HashSet<_> = all.iter().map(|r| r.source().0).collect();
        let slots: std::collections::HashSet<_> = all.iter().map(|r| r.slot()).collect();
        assert_eq!((ids.len(), slots.len()), (Rules::COUNT, Rules::COUNT));
        assert!(all.iter().all(|r| r.slot() < Rules::COUNT));
    }

    /// WebKit compiles no rule list whose `url-filter` has a disjunction (WebKitGTK 2.52.6: "Disjunctions are not
    /// supported yet"), and a list that does not compile opens no window: every filter of every list names one
    /// pattern, with no `|` and no group.
    #[test]
    fn no_rule_list_has_a_url_filter_with_a_disjunction() {
        for rules in [Rules::App, Rules::Net, Rules::RelayOnly] {
            let (id, source) = rules.source();
            let list: Value = serde_json::from_str(source).unwrap();
            let list = list.as_array().unwrap();
            assert!(!list.is_empty(), "{id}");
            for rule in list {
                let filter = rule["trigger"]["url-filter"].as_str().unwrap();
                assert!(
                    !filter.contains('|') && !filter.contains('(') && !filter.contains(')'),
                    "{id}: {filter}"
                );
            }
        }
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

    /// An app window never goes full screen on its own (WebKitGTK has `enable-fullscreen` on by default): its
    /// title bar, with "(Ghostly)", stays, and WebKitGTK 2.50 does not abort the app (`fullscreen.rs`). Whatever
    /// the guard: the test driver's windows too.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_app_window_on_linux_has_no_element_full_screen() {
        use webkit2gtk::glib::translate::from_glib_full;
        use webkit2gtk::SettingsExt;
        // A WebKitSettings reads GTK's own settings, and GTK stops the process without a display (CI's runners).
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            eprintln!("an_app_window_on_linux_has_no_element_full_screen: no display, not run");
            return;
        }
        for guard in ["full", "full+webrtc", "control"] {
            // A plain GObject: no display, so not `Settings::new`, which wants GTK started.
            let settings: webkit2gtk::Settings =
                unsafe { from_glib_full(webkit2gtk::ffi::webkit_settings_new()) };
            assert!(settings.enables_fullscreen(), "WebKitGTK's default");
            app_settings(&settings, Guard::parse(guard).unwrap());
            assert!(!settings.enables_fullscreen(), "{guard}");
        }
    }

    /// The same on macOS, where wry turns it on at build: what `webkit::no_element_fullscreen` does to a
    /// window's preferences.
    /// WebKit stops the process (SIGTRAP) when WKPreferences is made off the main thread, and the test harness runs
    /// every test on a thread of its own: run it by hand only from a harness on the main thread. The app calls
    /// `no_element_fullscreen` from `with_webview`, on the main thread.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "WKPreferences needs the main thread; libtest runs tests on others"]
    fn an_app_window_on_macos_has_no_element_full_screen() {
        use objc2::msg_send;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        let class = AnyClass::get(c"WKPreferences").unwrap();
        let preferences: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let _: () = unsafe { msg_send![&*preferences, setElementFullscreenEnabled: Bool::YES] };
        webkit::forbid_fullscreen(&preferences);
        let on: Bool = unsafe { msg_send![&*preferences, isElementFullscreenEnabled] };
        assert!(!on.as_bool());
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
            view: AppView::Full,
        };
        let label = open(app.handle(), request).unwrap();
        assert!(is_app_label(&label), "{label}");
        let window = app.get_webview_window(&label).unwrap();
        assert!(is_runner(&window.url().unwrap()));
        let state = app.state::<AppSandboxState>();
        assert_eq!(
            state.with(&label, |w| (w.app.clone(), w.internet, w.brokered, w.view)),
            Some(("ana/chess".to_string(), true, true, AppView::Full))
        );
        assert_eq!(refused(app.handle(), &label), Some(Vec::new()));
        forget_window(app.handle(), &label);
        assert_eq!(refused(app.handle(), &label), None);
    }

    /// An app that keeps asking to leave, with long URLs, while its window stays open: the window keeps only
    /// the last `MAX_REFUSED` refusals, each cut to `MAX_REFUSED_BYTES` of its URL.
    #[test]
    fn what_a_window_was_refused_stays_bounded() {
        let mut window = window("ana/chess", true, true);
        window.started = true;
        let long = format!("https://x.example/{}", "a".repeat(2 << 20));
        let long: url::Url = long.parse().unwrap();
        for i in 0..10_000 {
            let what = if i % 2 == 0 {
                "navigation"
            } else {
                "new window"
            };
            window.refuse(what, &long);
        }
        assert_eq!(window.refused.len(), MAX_REFUSED);
        for entry in &window.refused {
            assert!(
                entry.len() <= "new window ".len() + MAX_REFUSED_BYTES,
                "{}",
                entry.len()
            );
            assert!(
                entry.starts_with("navigation https://x.example/")
                    || entry.starts_with("new window https://x.example/")
            );
        }
        assert!(window.refused.back().unwrap().starts_with("new window "));
        // A short one is kept whole.
        let short: url::Url = "https://x.example/a".parse().unwrap();
        window.refuse("navigation", &short);
        assert_eq!(
            window.refused.back().unwrap(),
            "navigation https://x.example/a"
        );
        assert_eq!(window.refused.len(), MAX_REFUSED);
    }

    /// Opened again in a chat where it runs: its window comes to the front. Only an app window, and one gone is
    /// no error (it closed while the Ghostly window asked).
    #[test]
    fn an_app_window_is_brought_to_the_front_and_no_other_window() {
        let app = app();
        let request = OpenRequest {
            app: "ana/chess".into(),
            title: "Chess".into(),
            entry: "<p>chess</p>".into(),
            internet: false,
            view: AppView::Chat,
        };
        let label = open(app.handle(), request).unwrap();
        assert_eq!(app_focus(app.handle().clone(), label.clone()), Ok(()));
        app_close(app.handle().clone(), label.clone()).unwrap();
        assert_eq!(app_focus(app.handle().clone(), label.clone()), Ok(()));
        assert_eq!(app_focused(app.handle().clone(), label), Ok(false));
        for other in ["main", "svc-1", "app-"] {
            assert!(
                app_focused(app.handle().clone(), other.into()).is_err(),
                "{other}"
            );
            assert_eq!(
                app_focus(app.handle().clone(), other.into()),
                Err("Not an app window".into()),
                "{other}"
            );
        }
    }

    /// A profile switch or a reload replaces the page whose brokers answered the app windows: they must not stay
    /// open with the page before's app, nor keep a request waiting for a broker that went.
    #[test]
    fn a_new_page_closes_the_app_windows_the_page_before_opened() {
        let app = app();
        let request = OpenRequest {
            app: "ana/chess".into(),
            title: "Chess with Ana".into(),
            entry: "<p>chess</p>".into(),
            internet: false,
            view: AppView::Chat,
        };
        let opened = open(app.handle(), request).unwrap();
        let driver = open_guarded(
            app.handle(),
            "spike/malicious".into(),
            "<p>x</p>".into(),
            Guard::FULL,
            false,
        )
        .unwrap();
        let state = app.state::<AppSandboxState>();
        started(&state, &opened);
        let Admitted::Relay(_, mut waiting) = admitted(
            &state,
            &opened,
            json!({"id": 4, "type": "storage.keys", "args": []}),
        )
        .unwrap() else {
            panic!("relayed")
        };
        page_started(app.handle());
        assert!(state.with(&opened, |_| ()).is_none());
        assert!(matches!(
            waiting.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert_eq!(
            admitted(
                &state,
                &opened,
                json!({"id": 5, "type": "chat.send", "args": []})
            )
            .unwrap_err(),
            "Not an app window"
        );
        assert!(post(app.handle(), &opened, json!({"event": "x", "data": 1})).is_err());
        // The test driver's window has no broker in the page: it stays.
        assert!(state.with(&driver, |_| ()).is_some());
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

/// The real window on WebKitGTK, with every layer off (the runner's CSP alone stops a download there): what
/// an app's page can leave on disk.
#[cfg(all(test, target_os = "linux"))]
mod download_tests {
    use super::*;

    #[test]
    #[ignore = "needs a display and a process of its own (test_support::saved_by_a_window)"]
    fn a_download_the_page_starts_saves_no_file() {
        // covers: apps.desktop-sandbox
        let saved = crate::test_support::saved_by_a_window(
            SCHEME,
            |app| app.manage(AppSandboxState::default()),
            |app| {
                let guard = Guard::parse("control").unwrap();
                open_guarded(app, "chess".into(), String::new(), guard, false).unwrap();
            },
        );
        assert_eq!(saved, Vec::<String>::new());
    }
}
