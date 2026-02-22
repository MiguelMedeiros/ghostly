use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use crypto_secretbox::aead::{Aead, KeyInit};
use crypto_secretbox::XSalsa20Poly1305;
use rand::RngCore;

const NONCE_LENGTH: usize = 24;

pub fn generate_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    key
}

pub fn encrypt(plaintext: &str, key: &[u8]) -> Result<String, String> {
    let key_arr: &[u8; 32] = key
        .try_into()
        .map_err(|_| "Invalid key length: expected 32 bytes")?;

    let cipher = XSalsa20Poly1305::new(key_arr.into());

    let mut nonce_bytes = [0u8; NONCE_LENGTH];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let ciphertext = cipher
        .encrypt((&nonce_bytes).into(), plaintext.as_bytes().as_ref())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let mut combined = Vec::with_capacity(NONCE_LENGTH + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(STANDARD.encode(&combined))
}

pub fn decrypt(encoded: &str, key: &[u8]) -> Result<String, String> {
    let key_arr: &[u8; 32] = key
        .try_into()
        .map_err(|_| "Invalid key length: expected 32 bytes")?;

    let cipher = XSalsa20Poly1305::new(key_arr.into());

    let combined = STANDARD
        .decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    if combined.len() < NONCE_LENGTH + 1 {
        return Err("Invalid ciphertext: too short".into());
    }

    let nonce_bytes: &[u8; NONCE_LENGTH] = combined[..NONCE_LENGTH]
        .try_into()
        .map_err(|_| "Invalid nonce")?;

    let ciphertext = &combined[NONCE_LENGTH..];

    let plaintext = cipher
        .decrypt(nonce_bytes.into(), ciphertext)
        .map_err(|_| "Decryption failed — wrong key or corrupted data".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {}", e))
}

pub fn to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_base64_url(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| format!("Base64url decode failed: {}", e))
}
