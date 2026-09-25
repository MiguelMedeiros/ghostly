//! Raw Pkarr access for the shared TypeScript peer (`@ghostly/core`).
//!
//! The peer builds and encrypts its own TXT records; this side only signs,
//! publishes and resolves them, over the Mainline DHT and the default relays.

use pkarr::{Keypair, PublicKey, SignedPacket};
use serde::{Deserialize, Serialize};
use simple_dns::rdata::RData;

use crate::pkarr_network::Pkarr;

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

pub async fn publish(
    pkarr: &Pkarr,
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

    pkarr.publish(&signed_packet).await
}

/// `background`: a look that can wait; `urgent`: a signal is due (see `Pkarr::resolve_with`).
pub async fn resolve(
    pkarr: &Pkarr,
    public_key_z32: &str,
    background: bool,
    urgent: bool,
) -> Result<Option<ResolvedPacket>, String> {
    let public_key: PublicKey = public_key_z32
        .try_into()
        .map_err(|e| format!("Invalid public key: {}", e))?;

    let Some(signed_packet) = pkarr.resolve_with(&public_key, background, urgent).await else {
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
