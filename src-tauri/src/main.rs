#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bitcoind_rpc;
mod clipboard;
mod commands;
mod crypto;
mod diagnostics;
// The macOS end-to-end tests' way into the page (debug builds with `--features e2e-driver` only).
#[cfg(any(test, feature = "e2e-driver"))]
#[cfg_attr(not(feature = "e2e-driver"), allow(dead_code))]
mod e2e_driver;
mod file_store;
mod hyperdht;
mod lnd;
mod local_fetch;
mod notifications;
mod oidc;
mod paired_transport;
mod pkarr_client;
mod pkarr_network;
mod records;
mod share;
#[cfg(test)]
mod test_support;
mod types;
mod viewer;

use commands::AppState;
use pkarr_network::Pkarr;
use tauri::Manager;
use viewer::ViewerState;

/// Only the Ghostly window may call commands. The capabilities already say so;
/// this holds even if they are ever loosened, because the other windows run a
/// contact's code.
fn only_main<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke.message.webview_ref().label() != "main" {
            invoke.resolver.reject("Not allowed from this window");
            return true;
        }
        handler(invoke)
    }
}

/// Every command the app registers: the same list for the app and for the
/// tests that check who may call them. `build.rs` declares the same names.
macro_rules! commands {
    () => {
        tauri::generate_handler![
            notifications::native_notification_permission,
            notifications::native_private_notification,
            paired_transport::paired_iroh_start,
            paired_transport::paired_iroh_address,
            paired_transport::paired_iroh_connect,
            paired_transport::paired_native_send,
            paired_transport::paired_native_close,
            paired_transport::paired_iroh_stop,
            hyperdht::paired_hyperdht_start,
            hyperdht::paired_hyperdht_address,
            hyperdht::paired_hyperdht_connect,
            hyperdht::paired_hyperdht_send,
            hyperdht::paired_hyperdht_close,
            hyperdht::paired_hyperdht_stop,
            commands::get_profile,
            commands::create_keypair,
            commands::get_public_key,
            commands::generate_enc_key,
            commands::encrypt_text,
            commands::decrypt_text,
            commands::publish_messages,
            commands::resolve_messages,
            commands::publish_records,
            commands::resolve_records,
            commands::diagnostic_log,
            commands::local_fetch,
            commands::bitcoind_rpc,
            commands::lnd_request,
            commands::open_service_window,
            commands::service_respond,
            commands::updater_can_install,
            commands::open_project_link,
            commands::open_payment_link,
            share::share_text,
            clipboard::read_clipboard_text,
            oidc::oidc_loopback_start,
            oidc::oidc_loopback_wait,
            oidc::oidc_loopback_cancel,
            file_store::file_bytes_append,
            file_store::file_bytes_flush,
            file_store::file_bytes_close,
            file_store::file_bytes_size,
            file_store::file_bytes_truncate,
            file_store::file_bytes_read,
            file_store::file_bytes_digest,
            file_store::file_bytes_remove,
            file_store::file_bytes_remove_where,
            file_store::file_bytes_room,
            file_store::file_bytes_save,
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

fn main() {
    let pkarr = Pkarr::desktop().expect("Failed to create pkarr client");

    tauri::Builder::default()
        // Updating is always the user's doing: the plugin only looks and downloads
        // when the UI asks, and the release it takes has to carry our signature.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { pkarr })
        .manage(ViewerState::default())
        .manage(paired_transport::TransportState::default())
        .manage(hyperdht::HyperState::default())
        .manage(oidc::OidcState::default())
        .manage(clipboard_source())
        .setup(|app| {
            // The app's log, where the peer and the Pkarr client say how a link is doing.
            if let Ok(dir) = app.path().app_log_dir() {
                diagnostics::init(&dir);
            }
            // Files sent and received in chats, one folder per profile.
            app.manage(file_store::FileStore::new(
                app.path().app_data_dir()?.join("files"),
            ));
            #[cfg(feature = "e2e-driver")]
            {
                // The apps under test stay out of the Dock and never take the focus from whoever is at the Mac.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                e2e_driver::start(app.handle());
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(viewer::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let label = ctx.webview_label().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(viewer::handle(app, label, request).await);
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                viewer::forget_window(window.app_handle(), window.label());
            }
        })
        .invoke_handler(only_main(commands!()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

    fn capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap()
    }

    /// The app as `main()` builds it, every command and state included, on the mock runtime.
    fn app() -> tauri::App<MockRuntime> {
        let relay = format!("http://127.0.0.1:{}", test_support::closed_port());
        mock_builder()
            // Registered like the real one: Tauri treats app schemes as local pages.
            .register_uri_scheme_protocol(viewer::SCHEME, |_, _| {
                tauri::http::Response::new(Vec::new())
            })
            .manage(AppState {
                pkarr: Pkarr::new(None, &[relay.parse().unwrap()]).unwrap(),
            })
            .manage(ViewerState::default())
            .manage(paired_transport::TransportState::default())
            .manage(hyperdht::HyperState::default())
            .manage(oidc::OidcState::default())
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
        serde_json::json!({
            "request": false, "id": "1", "body": "x", "seedB64": "x", "events": "__CHANNEL__:1",
            "endpointId": 0, "connectionId": 0, "descriptor": {}, "text": "x",
            "encKeyB64": "x", "keyB64": "x", "plaintext": "x", "encoded": "x",
            "messages": [], "ackTimestamp": 0, "records": [], "publicKeyZ32": "x",
            "url": "http://127.0.0.1:9/", "method": "GET", "headers": [], "wallet": "",
            "user": "", "password": "", "params": [], "macaroon": "00", "path": "/v1/x",
            "timeoutMs": 1, "peer": "p", "service": "s", "title": "t",
            "response": {"status": 200, "headers": [], "bodyB64": ""},
            "port": 0, "expectedState": "x", "space": "x", "prefix": "", "size": 0,
            "offset": 0, "length": 0, "name": "x",
        })
    }

    #[test]
    fn build_rs_capabilities_and_permission_files_name_the_same_commands() {
        let declared: BTreeSet<String> = declared().into_iter().collect();
        assert_eq!(declared.len(), 49, "{declared:?}");
        let granted: BTreeSet<String> = capability()["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str()?.strip_prefix("allow-"))
            .map(|p| p.replace('-', "_"))
            .collect();
        assert_eq!(granted, declared, "every command granted, nothing else");
        for command in &declared {
            let file = format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            );
            assert!(std::path::Path::new(&file).exists(), "{file}");
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

    #[test]
    fn every_declared_command_is_registered() {
        let app = app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for command in declared() {
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
        for command in declared() {
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
        for label in ["svc-1", "main-2", "Main"] {
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
