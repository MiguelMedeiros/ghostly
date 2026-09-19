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
