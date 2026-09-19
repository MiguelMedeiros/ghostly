#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crypto;
mod local_fetch;
mod pkarr_client;
mod records;
mod types;
mod viewer;

use commands::AppState;
use pkarr::Client;
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

fn main() {
    let mut builder = Client::builder();

    builder.cache_size(50);

    let pkarr_client = builder.build().expect("Failed to create pkarr client");

    tauri::Builder::default()
        .manage(AppState {
            pkarr_client,
            publish_log: Default::default(),
        })
        .manage(ViewerState::default())
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
        .invoke_handler(only_main(tauri::generate_handler![
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
            commands::local_fetch,
            commands::open_service_window,
            commands::service_respond,
        ]))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The IPC path a page takes, run against the real capabilities: a window
/// showing a contact's app must not reach a single command.
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            // Registered like the real one: Tauri treats app schemes as local pages.
            .register_uri_scheme_protocol(viewer::SCHEME, |_, _| {
                tauri::http::Response::new(Vec::new())
            })
            .invoke_handler(only_main(tauri::generate_handler![
                commands::get_profile,
                commands::generate_enc_key,
                commands::local_fetch,
            ]))
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        url: &str,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<(), serde_json::Value> {
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
        .map(|_| ())
    }

    #[test]
    fn a_contacts_app_cannot_call_commands() {
        let app = app();
        let url = format!("{}://atlas.peer/", viewer::SCHEME);
        let viewer = WebviewWindowBuilder::new(
            &app,
            "svc-1",
            WebviewUrl::CustomProtocol(url.parse().unwrap()),
        )
        .build()
        .unwrap();

        assert!(invoke(&viewer, &url, "get_profile", serde_json::json!({})).is_err());
        assert!(invoke(&viewer, &url, "generate_enc_key", serde_json::json!({})).is_err());
        let fetch = serde_json::json!({
            "url": "http://127.0.0.1:9/secret", "method": "GET", "headers": [], "bodyB64": null
        });
        assert!(invoke(&viewer, &url, "local_fetch", fetch).is_err());
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
            "generate_enc_key",
            serde_json::json!({})
        )
        .is_ok());
    }
}
