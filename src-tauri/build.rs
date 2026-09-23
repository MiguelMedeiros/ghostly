/// Every command the app registers. Declaring them makes Tauri check each call
/// against the capabilities: without a manifest, app commands skip that check
/// for any page it considers local, and that includes the `ghostly-svc://`
/// windows that show a contact's web app.
const COMMANDS: &[&str] = &[
    "native_notification_permission",
    "native_private_notification",
    "paired_iroh_start",
    "paired_iroh_address",
    "paired_iroh_connect",
    "paired_native_send",
    "paired_native_close",
    "paired_iroh_stop",
    "paired_hyperdht_start",
    "paired_hyperdht_address",
    "paired_hyperdht_connect",
    "paired_hyperdht_send",
    "paired_hyperdht_close",
    "paired_hyperdht_stop",
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
    "bitcoind_rpc",
    "lnd_request",
    "open_service_window",
    "service_respond",
    "updater_can_install",
    "open_project_link",
    "oidc_loopback_start",
    "oidc_loopback_wait",
    "oidc_loopback_cancel",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
