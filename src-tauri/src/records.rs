//! Raw Pkarr access for the shared TypeScript peer (`@ghostly/core`).
//!
//! The peer builds and encrypts its own TXT records; this side only signs,
//! publishes and resolves them, over the Mainline DHT and the default relays.

use std::collections::HashMap;
use std::sync::Mutex;

use pkarr::{Client, Keypair, PublicKey, SignedPacket, Timestamp};
use serde::{Deserialize, Serialize};
use simple_dns::rdata::RData;

#[derive(Debug, Deserialize)]
pub struct RecordInput {
    pub label: String,
    pub value: String,
    pub ttl: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct RecordOutput {
    pub label: String,
    pub value: String,
    pub ttl: u32,
}

#[derive(Debug, Serialize)]
pub struct ResolvedPacket {
    /// Microseconds since the epoch, as text: it does not fit a JavaScript number.
    pub timestamp_micros: String,
    pub records: Vec<RecordOutput>,
}

/// Timestamp of the last packet published per key, the compare-and-swap value for the next.
#[derive(Default)]
pub struct PublishLog(Mutex<HashMap<String, Timestamp>>);

pub async fn publish(
    client: &Client,
    log: &PublishLog,
    keypair: &Keypair,
    records: &[RecordInput],
) -> Result<(), String> {
    let mut builder = SignedPacket::builder();
    for record in records {
        builder = builder.txt(
            record
                .label
                .as_str()
                .try_into()
                .map_err(|e| format!("Name error: {}", e))?,
            record
                .value
                .as_str()
                .try_into()
                .map_err(|e| format!("TXT error: {}", e))?,
            record.ttl.unwrap_or(300),
        );
    }
    let signed_packet = builder
        .sign(keypair)
        .map_err(|e| format!("Sign error: {}", e))?;

    let key = keypair.to_z32();
    let previous = log
        .0
        .lock()
        .map_err(|_| "publish log poisoned")?
        .get(&key)
        .cloned();

    // A link publishes in bursts (a message, its ack, a signal). Without naming the packet
    // being replaced, a publish that overlaps the previous one is refused as a conflict risk.
    let result = match client.publish(&signed_packet, previous).await {
        Err(pkarr::errors::PublishError::Concurrency(_)) => {
            client.publish(&signed_packet, None).await
        }
        other => other,
    };
    result.map_err(|e| format!("Publish error: {}", e))?;

    log.0
        .lock()
        .map_err(|_| "publish log poisoned")?
        .insert(key, signed_packet.timestamp());
    Ok(())
}

pub async fn resolve(
    client: &Client,
    public_key_z32: &str,
) -> Result<Option<ResolvedPacket>, String> {
    let public_key: PublicKey = public_key_z32
        .try_into()
        .map_err(|e| format!("Invalid public key: {}", e))?;

    let Some(signed_packet) = client.resolve_most_recent(&public_key).await else {
        return Ok(None);
    };

    let mut records = Vec::new();
    for record in signed_packet.all_resource_records() {
        if let RData::TXT(ref txt) = record.rdata {
            let name = record.name.to_string();
            let label = name
                .trim_end_matches('.')
                .split('.')
                .next()
                .unwrap_or(&name)
                .to_string();
            records.push(RecordOutput {
                label,
                value: String::try_from(txt.clone()).unwrap_or_default(),
                ttl: record.ttl,
            });
        }
    }

    Ok(Some(ResolvedPacket {
        timestamp_micros: signed_packet.timestamp().as_u64().to_string(),
        records,
    }))
}
