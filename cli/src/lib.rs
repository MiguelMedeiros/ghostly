pub mod crypto;
pub mod pkarr;
pub mod types;

pub use crypto::{from_base64_url, generate_key, to_base64_url};
pub use pkarr::{
    create_keypair, keypair_from_seed, publish_messages, pubkey_from_seed, resolve_messages,
};
pub use types::*;

use ::pkarr::Client;

pub struct GhostClient {
    client: Client,
}

impl GhostClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder().build().expect("Failed to create pkarr client"),
        }
    }

    pub async fn send(
        &self,
        seed: &str,
        peer_pubkey: &str,
        shared_key: &str,
        message: &str,
        nick: Option<&str>,
    ) -> Result<SendOutput, String> {
        let keypair = keypair_from_seed(seed)?;
        let key_bytes = from_base64_url(shared_key)?;
        
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_millis() as i64;

        let messages = vec![CompactMessage {
            t: timestamp,
            m: message.to_string(),
        }];

        let peer_batch = resolve_messages(&self.client, peer_pubkey, &key_bytes).await?;
        let ack = peer_batch.map(|b| b.latest_timestamp).unwrap_or(0);

        let kept = publish_messages(&self.client, &keypair, &messages, &key_bytes, ack, nick).await?;

        Ok(SendOutput {
            ok: true,
            timestamp,
            messages_kept: kept,
        })
    }

    pub async fn recv(&self, peer_pubkey: &str, shared_key: &str) -> Result<RecvOutput, String> {
        let key_bytes = from_base64_url(shared_key)?;
        
        let batch = resolve_messages(&self.client, peer_pubkey, &key_bytes).await?;

        match batch {
            Some(b) => Ok(RecvOutput {
                messages: b.messages,
                peer_ack: b.peer_ack,
                latest_ts: b.latest_timestamp,
                message_count: b.message_count,
            }),
            None => Ok(RecvOutput {
                messages: vec![],
                peer_ack: 0,
                latest_ts: 0,
                message_count: 0,
            }),
        }
    }
}

impl Default for GhostClient {
    fn default() -> Self {
        Self::new()
    }
}

pub fn generate_invite(seed: &str, shared_key: &str) -> Result<InviteOutput, String> {
    let pubkey = pubkey_from_seed(seed)?;
    let invite_url = format!("ghost://{}#{}", pubkey, shared_key);
    Ok(InviteOutput { invite_url, pubkey })
}

pub fn parse_invite(invite_url: &str) -> Result<ParsedInvite, String> {
    let url = invite_url
        .strip_prefix("ghost://")
        .ok_or("Invalid invite URL: must start with ghost://")?;

    let parts: Vec<&str> = url.split('#').collect();
    if parts.len() != 2 {
        return Err("Invalid invite URL: missing # separator".to_string());
    }

    let peer_pubkey = parts[0].to_string();
    let shared_key = parts[1].to_string();

    let (_, my_seed, my_pubkey) = create_keypair();

    Ok(ParsedInvite {
        peer_pubkey,
        shared_key,
        my_seed,
        my_pubkey,
    })
}

pub fn new_identity() -> IdentityOutput {
    let (_, seed, pubkey) = create_keypair();
    let shared_key = to_base64_url(&generate_key());
    IdentityOutput {
        seed,
        pubkey,
        shared_key,
    }
}
