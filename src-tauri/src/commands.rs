use pkarr::{Client, Keypair};
use std::env;
use tauri::State;

use crate::bitcoind_rpc::{self, RpcError};
use crate::crypto;
use crate::lnd::{self, LndRequest, LndResponse};
use crate::local_fetch::{self, LocalResponse};
use crate::pkarr_client;
use crate::records::{self, RecordInput, ResolvedPacket};
use crate::types::{CompactMessage, KeypairResult, ResolvedBatch};
use crate::viewer::{self, ServiceResponse};

pub struct AppState {
    pub pkarr_client: Client,
}

#[tauri::command]
pub fn get_profile() -> String {
    env::var("GHOSTLY_PROFILE").unwrap_or_default()
}

#[tauri::command]
pub fn create_keypair() -> Result<KeypairResult, String> {
    let keypair = Keypair::random();
    let secret = keypair.secret_key();
    let seed_b64 = crypto::to_base64_url(secret.as_ref());
    let pub_key_z32 = keypair.to_z32();

    Ok(KeypairResult {
        seed_b64,
        pub_key_z32,
    })
}

#[tauri::command]
pub fn get_public_key(seed_b64: String) -> Result<String, String> {
    let seed_bytes = crypto::from_base64_url(&seed_b64)?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| "Seed must be exactly 32 bytes")?;
    let keypair = Keypair::from_secret_key(&seed);
    Ok(keypair.to_z32())
}

#[tauri::command]
pub fn generate_enc_key() -> String {
    let key = crypto::generate_key();
    crypto::to_base64_url(&key)
}

#[tauri::command]
pub fn encrypt_text(plaintext: String, key_b64: String) -> Result<String, String> {
    let key_bytes = crypto::from_base64_url(&key_b64)?;
    crypto::encrypt(&plaintext, &key_bytes)
}

#[tauri::command]
pub fn decrypt_text(encoded: String, key_b64: String) -> Result<String, String> {
    let key_bytes = crypto::from_base64_url(&key_b64)?;
    crypto::decrypt(&encoded, &key_bytes)
}

#[tauri::command]
pub async fn publish_messages(
    state: State<'_, AppState>,
    seed_b64: String,
    messages: Vec<CompactMessage>,
    enc_key_b64: String,
    ack_timestamp: i64,
    nick: Option<String>,
    call_signal: Option<String>,
) -> Result<usize, String> {
    let seed_bytes = crypto::from_base64_url(&seed_b64)?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| "Seed must be exactly 32 bytes")?;
    let keypair = Keypair::from_secret_key(&seed);

    let enc_key = crypto::from_base64_url(&enc_key_b64)?;

    pkarr_client::publish_messages(
        &state.pkarr_client,
        &keypair,
        &messages,
        &enc_key,
        ack_timestamp,
        nick.as_deref(),
        call_signal.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn resolve_messages(
    state: State<'_, AppState>,
    public_key_z32: String,
    enc_key_b64: String,
) -> Result<Option<ResolvedBatch>, String> {
    let enc_key = crypto::from_base64_url(&enc_key_b64)?;

    pkarr_client::resolve_messages(&state.pkarr_client, &public_key_z32, &enc_key).await
}

// -- the shared TypeScript peer -------------------------------------------------

#[tauri::command]
pub async fn publish_records(
    state: State<'_, AppState>,
    seed_b64: String,
    records: Vec<RecordInput>,
) -> Result<(), String> {
    let seed_bytes = crypto::from_base64_url(&seed_b64)?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| "Seed must be exactly 32 bytes")?;
    let keypair = Keypair::from_secret_key(&seed);
    records::publish(&state.pkarr_client, &keypair, &records).await
}

#[tauri::command]
pub async fn resolve_records(
    state: State<'_, AppState>,
    public_key_z32: String,
) -> Result<Option<ResolvedPacket>, String> {
    records::resolve(&state.pkarr_client, &public_key_z32).await
}

#[tauri::command]
pub async fn local_fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
) -> Result<LocalResponse, String> {
    local_fetch::fetch(url, method, headers, body_b64).await
}

/// One call to the wallet RPC of the user's Bitcoin Core node: only the methods
/// the on-chain source needs, see `bitcoind_rpc`.
#[tauri::command]
pub async fn bitcoind_rpc(
    url: String,
    wallet: String,
    user: String,
    password: String,
    method: String,
    params: Vec<serde_json::Value>,
) -> Result<serde_json::Value, RpcError> {
    bitcoind_rpc::call(url, wallet, user, password, method, params).await
}

/// One call to the person's LND node for the LND Lightning source; see lnd.rs.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lnd_request(
    url: String,
    macaroon: String,
    certificate: Option<String>,
    method: String,
    path: String,
    body: Option<String>,
    stream: Option<String>,
    timeout_ms: u64,
) -> Result<LndResponse, String> {
    lnd::request(LndRequest {
        url,
        macaroon,
        certificate,
        method,
        path,
        body,
        stream,
        timeout_ms,
    })
    .await
}

#[tauri::command]
pub fn open_service_window(
    app: tauri::AppHandle,
    peer: String,
    service: String,
    title: String,
) -> Result<(), String> {
    viewer::open(&app, peer, service, title)
}

#[tauri::command]
pub fn service_respond(app: tauri::AppHandle, id: u64, response: ServiceResponse) {
    viewer::respond(&app, id, response);
}

/// Whether the updater can replace this install in place. It can on macOS and
/// Windows, and on Linux only for the AppImage: a `.deb` or `.rpm` belongs to
/// the package manager that put it there, so those are sent to the download
/// instead of a button that would fail.
#[tauri::command]
pub fn updater_can_install() -> bool {
    if cfg!(target_os = "linux") {
        env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

/// Open only Ghostly's repository/release pages, in the system browser.
#[tauri::command]
pub fn open_project_link(url: String) -> Result<(), String> {
    let root = "https://github.com/MiguelMedeiros/ghostly";
    if url != root
        && url != format!("{root}/releases")
        && !url
            .strip_prefix(&format!("{root}/releases/tag/"))
            .is_some_and(|tag| {
                !tag.is_empty()
                    && tag
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
            })
    {
        return Err("Not a Ghostly project link".into());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod project_link_tests {
    #[test]
    fn rejects_links_outside_the_project_before_launching_anything() {
        for url in [
            "https://example.com",
            "file:///etc/passwd",
            "https://github.com/MiguelMedeiros/ghostly.evil/releases",
            "https://github.com/MiguelMedeiros/ghostly/releases/tag/../../other",
            "https://github.com/MiguelMedeiros/ghostly/releases/tag/v1?redirect=evil",
        ] {
            assert!(super::open_project_link(url.into()).is_err());
        }
    }
}
