/// Every command the app registers. Declaring them makes Tauri check each call
/// against the capabilities: without a manifest, app commands skip that check
/// for any page it considers local, and that includes the `ghostly-svc://`
/// windows that show a contact's web app.
const COMMANDS: &[&str] = &[
    "get_profile",
    "create_keypair",
    "get_public_key",
    "generate_enc_key",
    "encrypt_text",
    "decrypt_text",
    "publish_messages",
    "resolve_messages",
    "publish_records",
    "resolve_records",
    "local_fetch",
    "open_service_window",
    "service_respond",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
