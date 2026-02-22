use pkarr::{Client, Keypair};
use std::env;
use tauri::State;

use crate::crypto;
use crate::pkarr_client;
use crate::types::{CompactMessage, KeypairResult, ResolvedBatch};

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
