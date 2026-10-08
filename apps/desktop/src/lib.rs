//! The Ghostly app: the same body for Desktop (`main.rs` calls [`run`]) and for mobile, where Tauri's
//! generated project loads this crate as a library and enters at [`run`].

#[cfg(desktop)]
mod app_sandbox;
#[cfg(desktop)]
mod app_window;
mod bitcoind_rpc;
mod clipboard;
mod commands;
mod crypto;
mod device_state;
mod diagnostics;
// The macOS end-to-end tests' way into the page (debug builds with `--features e2e-driver` only).
#[cfg(any(test, feature = "e2e-driver"))]
#[cfg_attr(not(feature = "e2e-driver"), allow(dead_code))]
mod e2e_driver;
mod file_store;
mod file_stream;
#[cfg(desktop)]
mod fullscreen;
#[cfg(desktop)]
mod hyperdht;
#[cfg(desktop)]
mod keep_awake;
mod link_preview;
mod lnd;
mod local_access;
mod local_fetch;
mod microphone;
// Android and iOS: the Desktop-only modules' commands, refusing (`commands!` is one list for every platform).
#[cfg(mobile)]
mod mobile;
mod native_call;
mod notifications;
mod oidc;
mod paired_transport;
mod pkarr_client;
mod pkarr_network;
mod pubky_session;
mod push_send;
mod records;
#[cfg(desktop)]
mod share;
#[cfg(target_os = "linux")]
mod single_instance;
#[cfg(test)]
mod test_support;
mod turn_network;
#[cfg(test)]
mod turn_record;
mod types;
#[cfg(desktop)]
mod viewer;

use commands::AppState;
#[cfg(mobile)]
use mobile::{app_sandbox, hyperdht, keep_awake, share, viewer};
use pkarr_network::Pkarr;
use tauri::Manager;
#[cfg(desktop)]
use viewer::ViewerState;

/// Only the Ghostly window may call commands. The capabilities already say so;
/// this holds even if they are ever loosened, because the other windows run a
/// contact's code. One exception: `app_broker`, from an app window (`app-*`)
/// only, and from no other window, the Ghostly window included.
fn may_call(label: &str, command: &str) -> bool {
    if command == "app_broker" {
        app_sandbox::is_app_label(label)
    } else {
        label == "main"
    }
}

fn only_main<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !may_call(
            invoke.message.webview_ref().label(),
            invoke.message.command(),
        ) {
            invoke.resolver.reject("Not allowed from this window");
            return true;
        }
        handler(invoke)
    }
}

/// Every command the app registers: the same list for the app and for the
/// tests that check who may call them. `build.rs` declares the same names. Alphabetical, one per line
/// (a test checks), here, in `build.rs` and in `capabilities/default.json`.
macro_rules! commands {
    () => {
        tauri::generate_handler![
            app_sandbox::app_broker,
            app_sandbox::app_close,
            app_sandbox::app_open,
            app_sandbox::app_post,
            clipboard::read_clipboard_files,
            clipboard::read_clipboard_text,
            clipboard::read_pasted_bytes,
            commands::bitcoind_rpc,
            commands::create_keypair,
            commands::decrypt_text,
            commands::diagnostic_log,
            commands::encrypt_text,
            commands::generate_enc_key,
            commands::get_profile,
            commands::get_public_key,
            commands::link_preview_fetch,
            commands::lnd_request,
            commands::local_fetch,
            commands::local_service_allow,
            commands::local_service_forget,
            commands::open_payment_link,
            commands::open_project_link,
            commands::open_pubky_passport,
            commands::open_service_window,
            commands::open_web_link,
            commands::pkarr_network_changed,
            commands::pkarr_status,
            commands::pubky_session_close,
            commands::pubky_session_fetch,
            commands::publish_messages,
            commands::publish_records,
            commands::publish_signed_packet,
            commands::push_send,
            commands::resolve_messages,
            commands::resolve_records,
            commands::service_respond,
            commands::set_pkarr_relays,
            commands::turn_put,
            commands::turn_read,
            commands::turn_warm,
            commands::under_test,
            commands::updater_can_install,
            commands::webkit_version,
            device_state::device_state_read,
            device_state::device_state_write,
            file_store::file_bytes_append,
            file_store::file_bytes_close,
            file_store::file_bytes_digest,
            file_store::file_bytes_flush,
            file_store::file_bytes_read,
            file_store::file_bytes_remove,
            file_store::file_bytes_remove_where,
            file_store::file_bytes_room,
            file_store::file_bytes_save,
            file_store::file_bytes_size,
            file_store::file_bytes_truncate,
            file_store::file_bytes_usage,
            file_stream::file_bytes_stream_close,
            file_stream::file_bytes_stream_open,
            hyperdht::paired_hyperdht_address,
            hyperdht::paired_hyperdht_close,
            hyperdht::paired_hyperdht_connect,
            hyperdht::paired_hyperdht_send,
            hyperdht::paired_hyperdht_start,
            hyperdht::paired_hyperdht_stop,
            keep_awake::keep_awake,
            native_call::native_call_accept,
            native_call::native_call_answer,
            native_call::native_call_camera,
            native_call::native_call_close,
            native_call::native_call_devices,
            native_call::native_call_devices_watch,
            native_call::native_call_microphone,
            native_call::native_call_mute,
            native_call::native_call_offer,
            native_call::native_call_open,
            native_call::native_call_speaker,
            native_call::native_call_stats,
            native_call::native_call_support,
            native_call::native_camera_close,
            native_call::native_camera_open,
            native_call::native_microphone_meter,
            native_call::native_microphone_meter_close,
            native_call::native_speaker_test,
            notifications::native_notification_permission,
            notifications::native_private_notification,
            notifications::open_notification_settings,
            oidc::oidc_loopback_cancel,
            oidc::oidc_loopback_start,
            oidc::oidc_loopback_wait,
            paired_transport::paired_iroh_address,
            paired_transport::paired_iroh_connect,
            paired_transport::paired_iroh_start,
            paired_transport::paired_iroh_stop,
            paired_transport::paired_native_close,
            paired_transport::paired_native_send,
            share::share_text,
        ]
    };
}

/// The system clipboard; an empty one in a build for the end-to-end tests, which never read the clipboard
/// of the machine they run on.
fn clipboard_source() -> clipboard::ClipboardSource {
    #[cfg(feature = "e2e-driver")]
    return clipboard::ClipboardSource::fixed(|| Ok(String::new()));
    #[cfg(not(feature = "e2e-driver"))]
    clipboard::ClipboardSource::system()
}

/// Files and pictures on the system clipboard, for a paste; none in a build for the end-to-end tests.
fn paste_source() -> clipboard::PasteSource {
    #[cfg(feature = "e2e-driver")]
    return clipboard::PasteSource::fixed(|| Ok(clipboard::Pasted::Nothing));
    #[cfg(not(feature = "e2e-driver"))]
    clipboard::PasteSource::system()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First of all, before anything here can make an HTTPS request (logcat shows it: RustStdoutStderr).
    #[cfg(target_os = "android")]
    if let Err(error) = android_tls() {
        eprintln!("tls: Android's certificate verifier is not ready: {error}");
    }
    let context = tauri::generate_context!();
    let builder = tauri::Builder::default();
    // Launched again on the same profile, it brings the running window forward and exits here, before its peer.
    #[cfg(target_os = "linux")]
    let builder = single_instance::register(builder, &context.config().identifier);

    // On a Mac, the app menu with New Chat (Cmd+N) and Settings… (Cmd+,); Linux and Windows keep no menu bar.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_window::menu);

    let pkarr = Pkarr::desktop().expect("Failed to create pkarr client");

    // Updating is always the user's doing: the plugin only looks and downloads
    // when the UI asks, and the release it takes has to carry our signature. Desktop only: an APK updates otherwise.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    // A contact's app (`viewer`) and an installed app (`app_sandbox`) open in windows of their own: Desktop only.
    #[cfg(desktop)]
    let builder = builder
        .manage(ViewerState::default())
        .manage(app_sandbox::AppSandboxState::default())
        .manage(hyperdht::HyperState::default())
        .register_asynchronous_uri_scheme_protocol(viewer::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let label = ctx.webview_label().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(viewer::handle(app, label, request).await);
            });
        })
        // An installed app's window (WISP 12xx): the runner, under its own policy.
        .register_uri_scheme_protocol(app_sandbox::SCHEME, |ctx, request| {
            app_sandbox::handle(ctx.app_handle(), ctx.webview_label(), &request)
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                viewer::forget_window(window.app_handle(), window.label());
                app_sandbox::forget_window(window.app_handle(), window.label());
            }
            // Closing the Ghostly window on a Mac hides it: the app runs on until Cmd+Q.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                app_window::on_close_requested(window, api)
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            app_window::on_menu_event(app, event.id().as_ref());
        });

    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { pkarr })
        .manage(paired_transport::TransportState::default())
        .manage(oidc::OidcState::default())
        .manage(clipboard_source())
        .manage(paste_source())
        .manage(clipboard::PasteShelf::default())
        .setup(|app| {
            // The app's log, where the peer and the Pkarr client say how a link is doing.
            if let Ok(dir) = app.path().app_log_dir() {
                diagnostics::init(&dir);
            }
            notifications::install(app.handle());
            // Files sent and received in chats, one folder per profile.
            // The local apps each profile shares, allowed by the person in a native dialog: all `local_fetch` may reach.
            app.manage(local_access::LocalAccess::load(
                app.path().app_data_dir()?.join("local-services.json"),
            ));
            let files = file_store::FileStore::new(app.path().app_data_dir()?.join("files"));
            files.keep_private();
            files.remove_staged_saves();
            app.manage(files);
            // A video's Full screen button works in the Ghostly window (WKWebView has it off, WebView2 fills only
            // the webview).
            if let Some(main) = app.get_webview_window("main") {
                #[cfg(desktop)]
                fullscreen::install(&main);
                // A voice message's microphone: WebKitGTK denies it unless the app answers.
                microphone::install(&main);
            }
            #[cfg(feature = "e2e-driver")]
            {
                // The apps under test stay out of the Dock and never take the focus from whoever is at the Mac.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                e2e_driver::start(app.handle());
            }
            Ok(())
        })
        // Stored files played in place (a video over the size a page can hold), by a token the page got.
        .manage(file_stream::StreamGrants::default())
        .register_asynchronous_uri_scheme_protocol(
            file_stream::SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let label = ctx.webview_label().to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    let response = match (
                        app.try_state::<file_store::FileStore>(),
                        app.try_state::<file_stream::StreamGrants>(),
                    ) {
                        (Some(store), Some(grants)) => {
                            file_stream::respond(&store, &grants, &label, &request)
                        }
                        _ => tauri::http::Response::builder()
                            .status(tauri::http::StatusCode::NOT_FOUND)
                            .body(Vec::new())
                            .unwrap(),
                    };
                    file_stream::trace(&request, &response);
                    responder.respond(response);
                });
            },
        )
        .invoke_handler(only_main(commands!()))
        .build(context)
        .expect("error while running tauri application")
        .run(on_run_event);
}

/// Android: rustls-platform-verifier checks every HTTPS certificate with Android's own verifier, through the JVM, and
/// panics on a request made before it knows the JVM and the app's context. Tao sets both in the activity's `onCreate`
/// before it calls `run`.
#[cfg(target_os = "android")]
fn android_tls() -> Result<(), String> {
    let android = ndk_context::android_context();
    // SAFETY: the pointers are the process's JavaVM and the application context, which tao keeps as a global
    // reference for the life of the process.
    let vm = unsafe { jni::JavaVM::from_raw(android.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { jni::objects::JObject::from_raw(android.context().cast()) };
    rustls_platform_verifier::android::init_with_env(&mut env, context).map_err(|e| e.to_string())
}

/// How long the page gets to say goodbye to its contacts before an exit it can be told about goes on.
const DEPART_MS: u64 = 400;
/// How long exiting waits, at most, for the native connections to close.
const CLOSE_MS: u64 = 500;

/// Leaving well: contacts hear this app go at once, and watch for it to come back (a restart is back
/// in seconds), rather than noticing when their liveness gives up a minute later.
/// - An exit the loop is asked for (the last window closed on Linux or Windows, `app.exit`): held for `DEPART_MS` while the
///   page says goodbye on every live session (`paired-bye`), then let through.
/// - Every exit, that one or a quit that nothing can hold (Cmd+Q and `quit` on macOS end the process
///   from `applicationWillTerminate`): the native connections close, so each contact sees its close.
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DEPARTING: AtomicBool = AtomicBool::new(false);
    match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if DEPARTING.swap(true, Ordering::SeqCst) {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            api.prevent_exit();
            let _ = window.eval("window.dispatchEvent(new Event('ghostly-departing'))");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(DEPART_MS)).await;
                app.exit(code.unwrap_or(0));
            });
        }
        // The Dock icon clicked: the Ghostly window back, hidden by a close.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => app_window::show_main(app),
        tauri::RunEvent::Exit => {
            let transports = app
                .state::<paired_transport::TransportState>()
                .inner()
                .clone();
            tauri::async_runtime::block_on(
                transports.shutdown(std::time::Duration::from_millis(CLOSE_MS)),
            );
        }
        _ => {}
    }
}

/// The IPC path a page takes, run against the real capabilities: a window
/// showing a contact's app must not reach a single command.
#[cfg(test)]
mod tests {
    // covers: services.desktop-viewer
    use super::*;
    use std::collections::BTreeSet;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    /// The names `build.rs` declares, read from its source.
    fn declared() -> Vec<String> {
        let source = include_str!("../build.rs");
        let list = &source[source.find("const COMMANDS").unwrap()..];
        let list = &list[list.find("= &[").unwrap() + 4..list.find("];").unwrap()];
        list.split(',')
            .map(|name| name.trim().trim_matches('"').to_string())
            .filter(|name| !name.is_empty())
            .collect()
    }

    /// The names `commands!` registers (what `invoke_handler` takes), read from this file's source.
    fn registered() -> Vec<String> {
        let source = include_str!("lib.rs");
        let list = &source[source.find("tauri::generate_handler![").unwrap()..];
        let list = &list[list.find('[').unwrap() + 1..list.find(']').unwrap()];
        list.split(',')
            .map(|path| path.trim().rsplit("::").next().unwrap().to_string())
            .filter(|name| !name.is_empty())
            .collect()
    }

    fn capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap()
    }

    /// The app windows' capability (WISP 12xx).
    fn app_capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/app.json")).unwrap()
    }

    /// The commands a capability grants (`allow-<name>`), as command names.
    fn granted_by(capability: &serde_json::Value) -> BTreeSet<String> {
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str()?.strip_prefix("allow-"))
            .map(|p| p.replace('-', "_"))
            .collect()
    }

    /// The app as `run()` builds it, every command and state included, on the mock runtime.
    fn app() -> tauri::App<MockRuntime> {
        let relay = format!("http://127.0.0.1:{}", test_support::closed_port());
        mock_builder()
            // Registered like the real one: Tauri treats app schemes as local pages.
            .register_uri_scheme_protocol(viewer::SCHEME, |_, _| {
                tauri::http::Response::new(Vec::new())
            })
            .register_uri_scheme_protocol(app_sandbox::SCHEME, |_, _| {
                tauri::http::Response::new(Vec::new())
            })
            .manage(AppState {
                pkarr: Pkarr::new(None, &[relay.parse().unwrap()]).unwrap(),
            })
            .manage(ViewerState::default())
            .manage(app_sandbox::AppSandboxState::default())
            .manage(paired_transport::TransportState::default())
            .manage(hyperdht::HyperState::default())
            .manage(oidc::OidcState::default())
            .manage(local_access::LocalAccess::default())
            .invoke_handler(only_main(commands!()))
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        url: &str,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    }

    fn viewer(app: &tauri::App<MockRuntime>, label: &str) -> (WebviewWindow<MockRuntime>, String) {
        let url = format!("{}://atlas.peer/", viewer::SCHEME);
        let window =
            WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(url.parse().unwrap()))
                .build()
                .unwrap();
        (window, url)
    }

    /// Arguments every command accepts, so a refusal is the window's and not the payload's.
    fn arguments() -> serde_json::Value {
        let mut arguments = serde_json::json!({
            "request": false, "id": "1", "body": "x", "seedB64": "x", "events": "__CHANNEL__:1",
            "endpointId": 0, "connectionId": 0, "descriptor": {}, "text": "x",
            "encKeyB64": "x", "keyB64": "x", "plaintext": "x", "encoded": "x",
            "messages": [], "ackTimestamp": 0, "records": [], "publicKeyZ32": "x",
            "url": "http://127.0.0.1:9/", "method": "GET", "headers": [], "wallet": "",
            "user": "", "password": "", "params": [], "macaroon": "00", "path": "/v1/x",
            "timeoutMs": 1, "peer": "p", "service": "s", "title": "t",
            "response": {"status": 200, "headers": [], "bodyB64": ""},
            "port": 0, "expectedState": "x", "space": "x", "prefix": "", "size": 0,
            "offset": 0, "length": 0, "name": "x", "session": "x", "payloadB64": "x",
        });
        // Past what one `json!` expands.
        arguments["relays"] = serde_json::json!([]);
        arguments["readRelays"] = serde_json::json!(false);
        arguments["frames"] = serde_json::json!("__CHANNEL__:1");
        arguments["offer"] = serde_json::json!("x");
        arguments["answer"] = serde_json::json!("x");
        arguments["muted"] = serde_json::json!(false);
        arguments["camera"] = serde_json::json!(null);
        arguments["mime"] = serde_json::json!("video/mp4");
        arguments["token"] = serde_json::json!("x");
        arguments["origin"] = serde_json::json!("http://127.0.0.1:9");
        arguments["profile"] = serde_json::json!("x");
        arguments["record"] = serde_json::json!(null);
        arguments
    }

    #[test]
    fn build_rs_capabilities_and_permission_files_name_the_same_commands() {
        let declared: BTreeSet<String> = declared().into_iter().collect();
        let main = granted_by(&capability());
        let app = granted_by(&app_capability());
        let granted: BTreeSet<String> = main.union(&app).cloned().collect();
        assert_eq!(granted, declared, "every command granted, nothing else");
        assert!(
            !main.contains("app_broker"),
            "the Ghostly window has no broker"
        );
        for command in &declared {
            let file = format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            );
            assert!(std::path::Path::new(&file).exists(), "{file}");
        }
    }

    /// Each list is in alphabetical order, one entry per line, so two pull requests that add commands add
    /// lines in different places and do not conflict.
    #[test]
    fn the_command_lists_are_in_alphabetical_order() {
        let source = include_str!("lib.rs");
        let list = &source[source.find("tauri::generate_handler![").unwrap()..];
        let list = &list[list.find('[').unwrap() + 1..list.find(']').unwrap()];
        let paths: Vec<String> = list
            .split(',')
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .collect();
        let granted: Vec<String> = capability()["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .filter(|p| p.starts_with("allow-"))
            .map(str::to_string)
            .collect();
        let lists: [(&str, Vec<String>); 3] = [
            ("lib.rs commands!", paths),
            ("build.rs COMMANDS", declared()),
            ("capabilities/default.json allow-*", granted),
        ];
        for (name, list) in lists {
            let mut sorted = list.clone();
            sorted.sort();
            assert_eq!(list, sorted, "{name} is not in alphabetical order");
        }
    }

    #[test]
    fn the_capability_is_for_the_ghostly_window_and_its_local_pages_only() {
        let capability = capability();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("webviews").is_none());
        assert!(capability.get("remote").is_none(), "no remote URL may call");
        assert!(capability.get("platforms").is_none());
    }

    /// An installed app's window gets its broker and nothing else: no `core:default`, no plugin, no event.
    #[test]
    fn the_app_capability_is_the_broker_alone_for_app_windows() {
        // covers: apps.desktop-sandbox
        let capability = app_capability();
        assert_eq!(capability["windows"], serde_json::json!(["app-*"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-app-broker"])
        );
        assert!(capability.get("webviews").is_none());
        assert!(capability.get("remote").is_none(), "no remote URL may call");
    }

    #[test]
    fn only_app_windows_may_call_the_broker_and_they_may_call_nothing_else() {
        // covers: apps.desktop-sandbox
        assert!(may_call("app-0123456789abcdef", "app_broker"));
        for label in ["main", "svc-1", "app-", "app", "apps-1", "xapp-1", "App-1"] {
            assert!(!may_call(label, "app_broker"), "{label}");
        }
        for command in registered().iter().filter(|c| *c != "app_broker") {
            assert!(!may_call("app-1", command), "{command}");
            assert!(may_call("main", command), "{command}");
        }
        // The Ghostly window's side of the broker: it opens app windows, answers them and closes them; an app
        // window does none of that.
        for command in ["app_open", "app_post", "app_close"] {
            assert!(registered().iter().any(|c| c == command), "{command}");
            assert!(may_call("main", command), "{command}");
            for label in ["app-1", "app-0123456789abcdef", "svc-1"] {
                assert!(!may_call(label, command), "{label} {command}");
            }
        }
    }

    /// Through the real IPC path: the broker answers an app window, which every other command refuses.
    #[test]
    fn an_app_window_reaches_the_broker_and_no_other_command() {
        // covers: apps.desktop-sandbox
        let app = app();
        let request = serde_json::from_value(serde_json::json!({
            "app": "ana/chess", "title": "Chess", "entry": "<p>chess</p>",
        }))
        .unwrap();
        let label = app_sandbox::open(app.handle(), request).unwrap();
        let window = app.get_webview_window(&label).unwrap();
        let runner = format!("{}://localhost/", app_sandbox::SCHEME);
        let entry = invoke(
            &window,
            &runner,
            "app_broker",
            serde_json::json!({"request": {"type": "start"}}),
        )
        .unwrap();
        assert_eq!(entry, "<p>chess</p>");
        // Any other request goes to the Ghostly window's broker, under this window's label: here nobody
        // answers it.
        let error = invoke(
            &window,
            &runner,
            "app_broker",
            serde_json::json!({"request": {"id": 1, "type": "context", "args": [], "app": "bob/snake"}}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("No answer"), "{error}");
        for command in registered().iter().filter(|c| *c != "app_broker") {
            let error = invoke(&window, &runner, command, arguments())
                .expect_err(command)
                .to_string();
            assert!(error.contains("not allowed"), "{command}: {error}");
        }
        // Plugins answer their own capabilities, which an app window has none of.
        for command in [
            "plugin:event|listen",
            "plugin:event|emit",
            "plugin:window|close",
            "plugin:webview|create_webview_window",
            "plugin:app|version",
        ] {
            let error = invoke(&window, &runner, command, serde_json::json!({}))
                .expect_err(command)
                .to_string();
            assert!(
                error.contains("not allowed") || error.contains("not found"),
                "{command}: {error}"
            );
        }
        // The same page outside its window: a remote page, or one in a window that is not an app's.
        let error = invoke(
            &window,
            "https://evil.example/",
            "app_broker",
            serde_json::json!({"request": {"type": "context"}}),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("not allowed"), "{error}");
    }

    #[test]
    fn no_other_window_reaches_the_broker() {
        // covers: apps.desktop-sandbox
        let app = app();
        let request = serde_json::json!({"request": {"type": "context"}});
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let error = invoke(&main, "tauri://localhost", "app_broker", request.clone())
            .unwrap_err()
            .to_string();
        assert!(error.contains("not allowed"), "main: {error}");
        let (viewer, url) = viewer(&app, "svc-1");
        let error = invoke(&viewer, &url, "app_broker", request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not allowed"), "svc-1: {error}");
    }

    /// A command registered but not declared is refused by the ACL ("not allowed by ACL") from the Ghostly
    /// window too: the app would build and the feature would silently never work.
    #[test]
    fn every_registered_command_is_declared_and_every_declared_one_registered() {
        let names = registered();
        let handled: BTreeSet<String> = names.iter().cloned().collect();
        let declared: BTreeSet<String> = declared().into_iter().collect();
        assert_eq!(handled.len(), names.len(), "a command registered twice");
        assert_eq!(
            handled.difference(&declared).collect::<Vec<_>>(),
            Vec::<&String>::new(),
            "registered in lib.rs but missing from build.rs COMMANDS (and the capability)"
        );
        assert_eq!(
            declared.difference(&handled).collect::<Vec<_>>(),
            Vec::<&String>::new(),
            "declared in build.rs but not registered in lib.rs"
        );
    }

    #[test]
    fn every_registered_command_is_allowed_from_the_ghostly_window() {
        let app = app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        // `app_broker` is the app windows' alone (`no_other_window_reaches_the_broker`).
        for command in registered().into_iter().filter(|c| c != "app_broker") {
            // An empty payload: most commands refuse it for a missing argument,
            // which only happens once the command was found and allowed.
            let answer = invoke(&main, "tauri://localhost", &command, serde_json::json!({}));
            if let Err(error) = answer {
                let error = error.to_string();
                assert!(
                    !error.contains("not found") && !error.contains("not allowed"),
                    "{command}: {error}"
                );
            }
        }
    }

    #[test]
    fn a_contacts_app_cannot_call_any_command() {
        let app = app();
        let (viewer, url) = viewer(&app, "svc-1");
        for command in registered() {
            let error = invoke(&viewer, &url, &command, arguments())
                .expect_err(&command)
                .to_string();
            assert!(error.contains("not allowed"), "{command}: {error}");
        }
    }

    #[test]
    fn a_window_that_is_not_main_is_refused_even_when_a_capability_grants_it() {
        let app = app();
        // Loosened on purpose: every window may generate a key. `only_main` still says no.
        app.add_capability(
            tauri::ipc::CapabilityBuilder::new("loosened")
                .windows(["*"])
                .permission("allow-generate-enc-key"),
        )
        .unwrap();
        for label in ["svc-1", "main-2", "Main", "app-1"] {
            let (window, url) = viewer(&app, label);
            let error = invoke(&window, &url, "generate_enc_key", serde_json::json!({}))
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("Not allowed from this window"),
                "{label}: {error}"
            );
        }
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert!(invoke(
            &main,
            "tauri://localhost",
            "generate_enc_key",
            serde_json::json!({})
        )
        .is_ok());
    }

    #[test]
    fn the_ghostly_window_on_a_remote_page_cannot_call_commands() {
        let app = app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for url in ["https://evil.example/", "http://127.0.0.1:1420/"] {
            let error = invoke(&main, url, "generate_enc_key", serde_json::json!({}))
                .unwrap_err()
                .to_string();
            assert!(error.contains("not allowed"), "{url}: {error}");
        }
    }

    #[test]
    fn the_ghostly_window_can() {
        let app = app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert!(invoke(
            &main,
            "tauri://localhost",
            "paired_native_close",
            serde_json::json!({"connectionId":0})
        )
        .is_ok());
        let key = invoke(
            &main,
            "tauri://localhost",
            "generate_enc_key",
            serde_json::json!({}),
        )
        .unwrap();
        assert_eq!(key.as_str().unwrap().len(), 43);
    }
}
