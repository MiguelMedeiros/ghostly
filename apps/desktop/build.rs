/// Every command the app registers. Declaring them makes Tauri check each call
/// against the capabilities: without a manifest, app commands skip that check
/// for any page it considers local, and that includes the `ghostly-svc://`
/// windows that show a contact's web app.
const COMMANDS: &[&str] = &[
    "app_broker",
    "app_close",
    "app_focus",
    "app_focused",
    "app_open",
    "app_post",
    "app_title",
    "bitcoind_rpc",
    "call_service",
    "close_service_windows",
    "create_keypair",
    "decrypt_text",
    "device_state_read",
    "device_state_write",
    "diagnostic_log",
    "encrypt_text",
    "file_bytes_append",
    "file_bytes_close",
    "file_bytes_digest",
    "file_bytes_flush",
    "file_bytes_read",
    "file_bytes_remove",
    "file_bytes_remove_where",
    "file_bytes_room",
    "file_bytes_save",
    "file_bytes_size",
    "file_bytes_stream_close",
    "file_bytes_stream_open",
    "file_bytes_truncate",
    "file_bytes_usage",
    "forget_service_origins",
    "generate_enc_key",
    "get_profile",
    "get_public_key",
    "hide_from_switcher",
    "hold_fetch",
    "incoming_share_done",
    "incoming_share_take",
    "keep_awake",
    "link_preview_fetch",
    "linked_files_entry",
    "linked_files_forget",
    "linked_files_list",
    "linked_files_pick",
    "linked_files_pick_cancel",
    "linked_files_read",
    "lnd_request",
    "local_fetch",
    "local_service_allow",
    "local_service_forget",
    "native_call_accept",
    "native_call_answer",
    "native_call_camera",
    "native_call_close",
    "native_call_devices",
    "native_call_devices_watch",
    "native_call_microphone",
    "native_call_mute",
    "native_call_offer",
    "native_call_open",
    "native_call_speaker",
    "native_call_stats",
    "native_call_support",
    "native_camera_close",
    "native_camera_open",
    "native_clear_notification",
    "native_clear_notifications",
    "native_microphone_meter",
    "native_microphone_meter_close",
    "native_notification_permission",
    "native_notification_tap",
    "native_private_notification",
    "native_speaker_test",
    "native_unread_count",
    "oidc_loopback_cancel",
    "oidc_loopback_start",
    "oidc_loopback_wait",
    "open_notification_settings",
    "open_payment_link",
    "open_project_link",
    "open_pubky_passport",
    "open_service_window",
    "open_web_link",
    "paired_hyperdht_address",
    "paired_hyperdht_close",
    "paired_hyperdht_connect",
    "paired_hyperdht_parting",
    "paired_hyperdht_send",
    "paired_hyperdht_start",
    "paired_hyperdht_stop",
    "paired_iroh_address",
    "paired_iroh_connect",
    "paired_iroh_start",
    "paired_iroh_stop",
    "paired_native_close",
    "paired_native_parting",
    "paired_native_send",
    "pkarr_network_changed",
    "pkarr_status",
    "pubky_session_close",
    "pubky_session_fetch",
    "publish_messages",
    "publish_records",
    "publish_signed_packet",
    "push_send",
    "read_clipboard_files",
    "read_clipboard_text",
    "read_dropped_files",
    "read_pasted_bytes",
    "resolve_messages",
    "resolve_records",
    "service_respond",
    "set_pkarr_relays",
    "share_text",
    "system_bars",
    "test_network",
    "translate_texts",
    "translation_download",
    "translation_remove",
    "translation_status",
    "turn_put",
    "turn_read",
    "turn_warm",
    "under_test",
    "updater_can_install",
    "webkit_version",
];

/// The Windows manifest tauri-build gives the app (Common Controls 6, which WebView2's windows need).
const WINDOWS_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    // tauri-build puts the manifest in the app's binary only, so a test that opens real windows on Windows does not
    // start (STATUS_ENTRYPOINT_NOT_FOUND). With this set (desktop-media's Windows job), every binary the linker makes
    // gets it instead. The app's own builds never set it.
    println!("cargo:rerun-if-env-changed=GHOSTLY_WINDOWS_TEST_MANIFEST");
    let attributes = if std::env::var_os("GHOSTLY_WINDOWS_TEST_MANIFEST").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        let manifest = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap())
            .join("windows-app-manifest.xml");
        std::fs::write(&manifest, WINDOWS_MANIFEST).expect("manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
