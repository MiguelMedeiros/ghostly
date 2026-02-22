use pkarr::{Client, Keypair, PublicKey, SignedPacket};
use simple_dns::rdata::RData;

use crate::crypto;
use crate::types::{CompactMessage, PkarrMessage, ResolvedBatch};

const MAX_MSGS_PAYLOAD_B64: usize = 800;

fn trim_to_fit(
    messages: &[CompactMessage],
    enc_key: &[u8],
    max_payload: usize,
) -> Result<(String, usize), String> {
    if messages.is_empty() {
        let encrypted = crypto::encrypt("[]", enc_key)?;
        return Ok((encrypted, 0));
    }

    let mut batch: Vec<&CompactMessage> = messages.iter().collect();

    while !batch.is_empty() {
        let json = serde_json::to_string(&batch).map_err(|e| format!("JSON serialize: {}", e))?;
        let encrypted = crypto::encrypt(&json, enc_key)?;
        if encrypted.len() <= max_payload {
            return Ok((encrypted, batch.len()));
        }
        if batch.len() == 1 {
            let msg = batch[0];
            let max_text = msg.m.chars().take(400).collect::<String>();
            let truncated = CompactMessage {
                t: msg.t,
                m: max_text,
            };
            let json =
                serde_json::to_string(&vec![&truncated]).map_err(|e| format!("JSON: {}", e))?;
            let encrypted = crypto::encrypt(&json, enc_key)?;
            return Ok((encrypted, 1));
        }
        batch.remove(0);
    }

    let encrypted = crypto::encrypt("[]", enc_key)?;
    Ok((encrypted, 0))
}

pub async fn publish_messages(
    client: &Client,
    keypair: &Keypair,
    messages: &[CompactMessage],
    enc_key: &[u8],
    ack_timestamp: i64,
    nick: Option<&str>,
) -> Result<usize, String> {
    let mut sorted = messages.to_vec();
    sorted.sort_by_key(|m| m.t);

    let (payload, kept) = trim_to_fit(&sorted, enc_key, MAX_MSGS_PAYLOAD_B64)?;

    let mut builder = SignedPacket::builder();

    builder = builder.txt(
        "_msgs"
            .try_into()
            .map_err(|e| format!("Name error: {}", e))?,
        payload
            .as_str()
            .try_into()
            .map_err(|e| format!("TXT error: {}", e))?,
        300,
    );

    let latest_ts = sorted
        .last()
        .map(|m| m.t.to_string())
        .unwrap_or_else(|| "0".to_string());
    builder = builder.txt(
        "_ts".try_into().map_err(|e| format!("Name error: {}", e))?,
        latest_ts
            .as_str()
            .try_into()
            .map_err(|e| format!("TXT error: {}", e))?,
        300,
    );

    if ack_timestamp > 0 {
        let ack_str = ack_timestamp.to_string();
        builder = builder.txt(
            "_ack"
                .try_into()
                .map_err(|e| format!("Name error: {}", e))?,
            ack_str
                .as_str()
                .try_into()
                .map_err(|e| format!("TXT error: {}", e))?,
            300,
        );
    }

    if let Some(nick_str) = nick {
        let encrypted_nick = crypto::encrypt(nick_str, enc_key)?;
        builder = builder.txt(
            "_nick"
                .try_into()
                .map_err(|e| format!("Name error: {}", e))?,
            encrypted_nick
                .as_str()
                .try_into()
                .map_err(|e| format!("TXT error: {}", e))?,
            300,
        );
    }

    let signed_packet = builder
        .sign(keypair)
        .map_err(|e| format!("Sign error: {}", e))?;

    client
        .publish(&signed_packet, None)
        .await
        .map_err(|e| format!("Publish error: {}", e))?;

    Ok(kept)
}

pub async fn resolve_messages(
    client: &Client,
    public_key_z32: &str,
    enc_key: &[u8],
) -> Result<Option<ResolvedBatch>, String> {
    let public_key: PublicKey = public_key_z32
        .try_into()
        .map_err(|e| format!("Invalid public key: {}", e))?;

    let resolved = client.resolve_most_recent(&public_key).await;

    let signed_packet = match resolved {
        Some(p) => p,
        None => return Ok(None),
    };

    let packet_timestamp = signed_packet.timestamp().as_u64() as i64 / 1000;

    let mut nick: Option<String> = None;
    let mut encrypted_payload_length: usize = 0;
    let mut latest_timestamp: i64 = 0;
    let mut peer_ack: i64 = 0;
    let mut raw_record_names: Vec<String> = Vec::new();
    let mut messages: Vec<PkarrMessage> = Vec::new();
    let mut call_signal: Option<String> = None;

    let mut msgs_payload = String::new();
    let mut legacy_msg = String::new();
    let legacy_ts: i64 = 0;

    for record in signed_packet.all_resource_records() {
        let name_str = record.name.to_string();
        let label = name_str
            .trim_end_matches('.')
            .split('.')
            .next()
            .unwrap_or(&name_str);

        if let RData::TXT(ref txt) = record.rdata {
            let value = String::try_from(txt.clone()).unwrap_or_default();

            raw_record_names.push(label.to_string());

            match label {
                "_msgs" => {
                    encrypted_payload_length = value.len();
                    msgs_payload = value;
                }
                "_msg" => {
                    encrypted_payload_length = value.len();
                    if let Ok(decrypted) = crypto::decrypt(&value, enc_key) {
                        legacy_msg = decrypted;
                    }
                }
                "_ts" => {
                    latest_timestamp = value.parse::<i64>().unwrap_or(0);
                }
                "_ack" => {
                    peer_ack = value.parse::<i64>().unwrap_or(0);
                }
                "_nick" => {
                    if let Ok(decrypted) = crypto::decrypt(&value, enc_key) {
                        nick = Some(decrypted);
                    }
                }
                "_call" => {
                    if let Ok(decrypted) = crypto::decrypt(&value, enc_key) {
                        call_signal = Some(decrypted);
                    }
                }
                _ => {}
            }
        }
    }

    if !msgs_payload.is_empty() {
        if let Ok(json) = crypto::decrypt(&msgs_payload, enc_key) {
            if let Ok(batch) = serde_json::from_str::<Vec<CompactMessage>>(&json) {
                for entry in &batch {
                    messages.push(PkarrMessage {
                        text: entry.m.clone(),
                        timestamp: entry.t,
                        nick: nick.clone(),
                    });
                }
                if latest_timestamp == 0 && !messages.is_empty() {
                    latest_timestamp = messages.iter().map(|m| m.timestamp).max().unwrap_or(0);
                }
            }
        }
    } else if !legacy_msg.is_empty() && legacy_ts > 0 {
        messages.push(PkarrMessage {
            text: legacy_msg,
            timestamp: legacy_ts,
            nick,
        });
        latest_timestamp = legacy_ts;
    } else if !legacy_msg.is_empty() && latest_timestamp > 0 {
        messages.push(PkarrMessage {
            text: legacy_msg,
            timestamp: latest_timestamp,
            nick,
        });
    }

    let message_count = messages.len();

    Ok(Some(ResolvedBatch {
        messages,
        latest_timestamp,
        peer_ack,
        raw_record_names,
        encrypted_payload_length,
        packet_timestamp,
        message_count,
        call_signal,
    }))
}

pub fn create_keypair() -> (Keypair, String, String) {
    let keypair = Keypair::random();
    let secret = keypair.secret_key();
    let seed_b64 = crypto::to_base64_url(&secret);
    let pub_key_z32 = keypair.to_z32();
    (keypair, seed_b64, pub_key_z32)
}

pub fn keypair_from_seed(seed_b64: &str) -> Result<Keypair, String> {
    let seed_bytes = crypto::from_base64_url(seed_b64)?;
    if seed_bytes.len() != 32 {
        return Err(format!(
            "Invalid seed length: expected 32 bytes, got {}",
            seed_bytes.len()
        ));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&seed_bytes);
    Ok(Keypair::from_secret_key(&arr))
}

pub fn pubkey_from_seed(seed_b64: &str) -> Result<String, String> {
    let keypair = keypair_from_seed(seed_b64)?;
    Ok(keypair.to_z32())
}
