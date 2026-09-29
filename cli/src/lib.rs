pub mod crypto;
pub mod pkarr;
pub mod types;

pub use crypto::{from_base64_url, generate_key, to_base64_url};
pub use pkarr::{
    create_keypair, keypair_from_seed, pubkey_from_seed, publish_messages, resolve_messages,
};
pub use types::*;

use ::pkarr::Client;

pub struct GhostClient {
    /// Where packets are looked up: the Mainline DHT directly, unless relay reads were asked for.
    reader: Client,
    /// Where packets are published: the DHT and pkarr's default relays, since a contact in a browser reads
    /// only relays (and a relay keeps serving the copy it has for minutes).
    writer: Client,
}

impl GhostClient {
    pub fn new() -> Self {
        Self::with_relay_reads(false)
    }

    /// `read_relays`: look packets up through the relays too, not on the DHT alone (`--read-relays`).
    pub fn with_relay_reads(read_relays: bool) -> Self {
        let writer = Client::builder()
            .build()
            .expect("Failed to create pkarr client");
        let reader = if read_relays {
            writer.clone()
        } else {
            Client::builder()
                .no_relays()
                .build()
                .expect("Failed to create pkarr client")
        };
        Self { reader, writer }
    }

    /// Over a Pkarr client of the caller's making, for reads and writes: other relays, no DHT.
    pub fn with_client(client: Client) -> Self {
        Self {
            reader: client.clone(),
            writer: client,
        }
    }

    /// The client packets are published with.
    pub fn writer(&self) -> &Client {
        &self.writer
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

        let peer_batch = resolve_messages(&self.reader, peer_pubkey, &key_bytes).await?;
        let ack = peer_batch.map(|b| b.latest_timestamp).unwrap_or(0);

        let kept =
            publish_messages(&self.writer, &keypair, &messages, &key_bytes, ack, nick).await?;

        Ok(SendOutput {
            ok: true,
            timestamp,
            messages_kept: kept,
        })
    }

    pub async fn recv(&self, peer_pubkey: &str, shared_key: &str) -> Result<RecvOutput, String> {
        let key_bytes = from_base64_url(shared_key)?;

        let batch = resolve_messages(&self.reader, peer_pubkey, &key_bytes).await?;

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

/// What the CLI says when handed an app invite (WISP 801): it reads only its own `ghost://` URLs.
pub const APP_INVITE_ERROR: &str = "This is a Ghostly app invite (ghostly1...). The CLI is a compatibility client and reads only ghost:// invites; open this one in the Ghostly app, or ask for a ghost:// invite.";

/// A `ghostly1` code, bare or in a link, in any case: the app's invite, not the CLI's.
fn is_app_invite(input: &str) -> bool {
    let code = input.trim().rsplit('#').next().unwrap_or("");
    let code = code
        .strip_prefix("/chat/")
        .or_else(|| code.strip_prefix("chat/"))
        .unwrap_or(code);
    code.get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ghostly1"))
}

pub fn parse_invite(invite_url: &str) -> Result<ParsedInvite, String> {
    if is_app_invite(invite_url) {
        return Err(APP_INVITE_ERROR.to_string());
    }
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
