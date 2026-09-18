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
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
