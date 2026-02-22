#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crypto;
mod pkarr_client;
mod types;

use commands::AppState;
use pkarr::Client;

fn main() {
    let mut builder = Client::builder();

    builder.cache_size(50);

    let pkarr_client = builder.build().expect("Failed to create pkarr client");

    tauri::Builder::default()
        .manage(AppState { pkarr_client })
        .invoke_handler(tauri::generate_handler![
            commands::get_profile,
            commands::create_keypair,
            commands::get_public_key,
            commands::generate_enc_key,
            commands::encrypt_text,
            commands::decrypt_text,
            commands::publish_messages,
            commands::resolve_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
