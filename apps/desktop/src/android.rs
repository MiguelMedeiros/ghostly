//! The Android host: what Desktop does with the system's processes and windows (an opener, the clipboard, a share
//! sheet, notifications, a save dialog), done through Android itself by the app's own Kotlin plugin
//! (`gen/android/app/src/main/java/tools/ghostly/app/GhostlyHostPlugin.kt`). Rust calls it; it calls back here
//! (`Java_tools_ghostly_app_GhostlyHostPlugin_received`) with what Android hands the app: a sign-in's deep link, a
//! share from another app, a tap on a notification, a network change.

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Wry};

static HOST: OnceLock<PluginHandle<Wry>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// The page hears of a share from another app by this event, then takes it (`incoming_share_take`).
const SHARE_EVENT: &str = "incoming-share";
/// As on macOS (notifications.rs): the page opens the chat of the notification tapped.
const OPEN_EVENT: &str = "notification-open";
const VISIBILITY_EVENT: &str = "app-visibility";

/// Registered before the app's own `setup`: the Kotlin half loads with it and may report an intent at once (the one
/// that started the app), so the app handle is kept first.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("ghostly-android")
        .setup(|app, api| {
            let _ = APP.set(app.clone());
            let handle = api.register_android_plugin("tools.ghostly.app", "GhostlyHostPlugin")?;
            let _ = HOST.set(handle);
            Ok(())
        })
        .build()
}

fn host() -> Result<&'static PluginHandle<Wry>, String> {
    HOST.get()
        .ok_or_else(|| "The Android host is not ready".into())
}

/// The Kotlin side runs on Android's main thread: a call from it would wait on itself.
fn on_main_thread() -> bool {
    // SAFETY: plain getters, no arguments. The main thread's id is the process's.
    unsafe { libc::gettid() == libc::getpid() }
}

/// One command of the Kotlin plugin, waited for. Its error is the plugin's message (written for people).
fn call<T: DeserializeOwned>(command: &str, payload: Value) -> Result<T, String> {
    if on_main_thread() {
        return Err("Not from Android's main thread".into());
    }
    host()?
        .run_mobile_plugin(command, payload)
        .map_err(|e| e.to_string())
}

async fn call_async<T: DeserializeOwned>(command: &str, payload: Value) -> Result<T, String> {
    host()?
        .run_mobile_plugin_async(command, payload)
        .await
        .map_err(|e| e.to_string())
}

/// Opens a URL with the app Android has for it (`ACTION_VIEW`): a browser, a maps app, a wallet. The callers checked
/// it (`commands::launch`). An error when no app takes it, such as a payment link with no wallet installed.
pub fn view(url: &str) -> Result<(), String> {
    let payload = json!({ "url": url });
    if on_main_thread() {
        // Never the case for a command today; should it be, the link still opens, and only a refusal goes unseen.
        std::thread::spawn(move || {
            if let Err(error) = call::<Value>("view", payload) {
                crate::diagnostics::log(&format!("opener: {error}"));
            }
        });
        return Ok(());
    }
    call::<Value>("view", payload).map(drop)
}

/// The system's share sheet with `text` (a link, an invite).
pub fn share_text(text: &str) -> Result<bool, String> {
    call::<Value>("share", json!({ "text": text })).map(|_| true)
}

#[derive(Deserialize)]
struct Clip {
    text: Option<String>,
}

/// The text on the clipboard, empty when there is none (or only a picture). Android 10 and up gives it only to the app
/// in front, which the app is when someone taps its paste button.
pub fn clipboard_text() -> Result<String, String> {
    Ok(call::<Clip>("clipboardRead", json!({}))?
        .text
        .unwrap_or_default())
}

#[derive(Deserialize)]
struct Permission {
    state: String,
}

/// "granted", "denied" or "default" (not asked yet). `request` asks (Android 13 and up: the POST_NOTIFICATIONS
/// prompt), which the page does only from the person's own switch in Settings.
pub async fn notification_permission(request: bool) -> Result<String, String> {
    Ok(
        call_async::<Permission>("notificationPermission", json!({ "request": request }))
            .await?
            .state,
    )
}

/// A notification with the page's text, silent (the page plays its own sound). A tap opens the app and the page
/// hears `notification-open` with `id`, which names the chat only inside the page.
pub async fn notify(id: &str, body: &str) -> Result<(), String> {
    call_async::<Value>("notify", json!({ "id": id, "body": body }))
        .await
        .map(drop)
}

/// The app's page in the system's notification settings.
pub fn open_notification_settings() -> Result<(), String> {
    call::<Value>("openNotificationSettings", json!({})).map(drop)
}

#[derive(Deserialize)]
struct Saved {
    saved: bool,
}

/// Saves a copy of `path` where the person picks, through Android's own document picker (Downloads, a cloud drive):
/// false when they cancelled.
pub async fn save_file(path: PathBuf, name: &str) -> Result<bool, String> {
    let path = path.to_str().ok_or("Unreadable file path")?.to_string();
    Ok(
        call_async::<Saved>("saveFile", json!({ "path": path, "name": name }))
            .await?
            .saved,
    )
}

/// The system bars around the page take its background colour, and light or dark icons to go on it.
pub fn system_bars(color: u32, dark: bool) -> Result<(), String> {
    call::<Value>("systemBars", json!({ "color": color, "dark": dark })).map(drop)
}

/// A share from another app, as the Kotlin side copied it: its text and the files it made of the shared streams, in
/// the app's cache.
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Shared {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub files: Vec<SharedFile>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct SharedFile {
    pub path: String,
    pub mime: Option<String>,
}

/// The latest share waiting for the page: one at a time, a newer one replaces it (as the web app's share target).
#[derive(Default)]
pub struct Incoming(Mutex<Option<Shared>>);

impl Incoming {
    pub fn take(&self) -> Option<Shared> {
        self.0.lock().unwrap().take()
    }
}

fn received(kind: &str, value: String) {
    let Some(app) = APP.get() else {
        return;
    };
    match kind {
        "oidc" => {
            let state = app.state::<crate::oidc::OidcState>();
            match crate::oidc::deep_link_answer(&value) {
                Some(answer) => {
                    if !state.answer(&answer) {
                        crate::diagnostics::log("oidc: a sign-in answer nobody waits for, dropped");
                    }
                }
                None => crate::diagnostics::log("oidc: not a sign-in link, dropped"),
            }
        }
        "notification" => {
            let _ = app.emit_to("main", OPEN_EVENT, value);
        }
        // The activity stopped ("hidden") or came back ("visible"): Android's WebView never changes the page's own
        // visibility, so the page keeps this one (apps/ui/src/desktop/android.ts `followAppVisibility`).
        "visibility" => {
            let _ = app.emit_to("main", VISIBILITY_EVENT, value);
        }
        "share" => match serde_json::from_str::<Shared>(&value) {
            Ok(shared) => {
                *app.state::<Incoming>().0.lock().unwrap() = Some(shared);
                let _ = app.emit_to("main", SHARE_EVENT, ());
            }
            Err(error) => crate::diagnostics::log(&format!("share: unreadable ({error})")),
        },
        "network" => {
            // Android denies Iroh's netwatch the routing table, so it may not see a new network itself: every
            // endpoint is told, and Pkarr asks its relays again.
            let transports = app
                .state::<crate::paired_transport::TransportState>()
                .inner()
                .clone();
            app.state::<crate::commands::AppState>()
                .pkarr
                .network_changed();
            tauri::async_runtime::spawn(async move {
                let count = transports.network_changed().await;
                crate::diagnostics::log(&format!(
                    "network: changed ({value}), {count} Iroh endpoints told"
                ));
            });
        }
        _ => {}
    }
}

/// Kotlin's `external fun received(kind: String, value: String)`. On Android's main thread: what it starts runs
/// elsewhere, and nothing here calls back into Kotlin.
#[no_mangle]
pub extern "system" fn Java_tools_ghostly_app_GhostlyHostPlugin_received(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    kind: jni::objects::JString,
    value: jni::objects::JString,
) {
    let (Ok(kind), Ok(value)) = (env.get_string(&kind), env.get_string(&value)) else {
        return;
    };
    let kind: String = kind.into();
    let value: String = value.into();
    // A panic must never cross into the JVM.
    let _ = std::panic::catch_unwind(|| received(&kind, value));
}
