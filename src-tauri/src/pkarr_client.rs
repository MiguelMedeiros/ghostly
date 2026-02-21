use pkarr::{Client, Keypair, PublicKey, SignedPacket};
use simple_dns::rdata::RData;

use crate::crypto;
use crate::types::{CompactMessage, PkarrMessage, ResolvedBatch};

const MAX_MSGS_PAYLOAD_B64: usize = 800;

fn trim_to_fit(messages: &[CompactMessage], enc_key: &[u8]) -> Result<(String, usize), String> {
    if messages.is_empty() {
        let encrypted = crypto::encrypt("[]", enc_key)?;
        return Ok((encrypted, 0));
    }

    let mut batch: Vec<&CompactMessage> = messages.iter().collect();

    while !batch.is_empty() {
        let json = serde_json::to_string(&batch).map_err(|e| format!("JSON serialize: {}", e))?;
        let encrypted = crypto::encrypt(&json, enc_key)?;
        if encrypted.len() <= MAX_MSGS_PAYLOAD_B64 {
            return Ok((encrypted, batch.len()));
        }
        if batch.len() == 1 {
            eprintln!(
                "[pkarr] single message too large ({} b64 chars > {} limit), truncating",
                encrypted.len(),
                MAX_MSGS_PAYLOAD_B64
            );
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

    let (payload, kept) = trim_to_fit(&sorted, enc_key)?;

    let mut builder = SignedPacket::builder();

    builder = builder.txt(
        "_msgs".try_into().map_err(|e| format!("Name error: {}", e))?,
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
            "_ack".try_into().map_err(|e| format!("Name error: {}", e))?,
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

    let pub_key_z32 = keypair.to_z32();
    println!(
        "[pkarr] publish {} msgs, ack={} → {}...",
        kept,
        ack_timestamp,
        &pub_key_z32[..12.min(pub_key_z32.len())]
    );

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
                    match crypto::decrypt(&value, enc_key) {
                        Ok(decrypted) => legacy_msg = decrypted,
                        Err(e) => eprintln!("[pkarr] decrypt _msg failed: {}", e),
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
                _ => {}
            }
        }
    }

    if !msgs_payload.is_empty() {
        match crypto::decrypt(&msgs_payload, enc_key) {
            Ok(json) => match serde_json::from_str::<Vec<CompactMessage>>(&json) {
                Ok(batch) => {
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
                Err(e) => eprintln!("[pkarr] parse _msgs JSON failed: {}", e),
            },
            Err(e) => eprintln!("[pkarr] decrypt _msgs failed: {}", e),
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
    }))
}
