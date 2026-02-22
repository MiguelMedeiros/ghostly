use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompactMessage {
    pub t: i64,
    pub m: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedBatch {
    pub messages: Vec<PkarrMessage>,
    pub latest_timestamp: i64,
    pub peer_ack: i64,
    pub raw_record_names: Vec<String>,
    pub encrypted_payload_length: usize,
    pub packet_timestamp: i64,
    pub message_count: usize,
    pub call_signal: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PkarrMessage {
    pub text: String,
    pub timestamp: i64,
    pub nick: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IdentityOutput {
    pub seed: String,
    pub pubkey: String,
    pub shared_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InviteOutput {
    pub invite_url: String,
    pub pubkey: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedInvite {
    pub peer_pubkey: String,
    pub shared_key: String,
    pub my_seed: String,
    pub my_pubkey: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SendOutput {
    pub ok: bool,
    pub timestamp: i64,
    pub messages_kept: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecvOutput {
    pub messages: Vec<PkarrMessage>,
    pub peer_ack: i64,
    pub latest_ts: i64,
    pub message_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WatchEvent {
    pub from: String,
    pub text: String,
    pub timestamp: i64,
    pub nick: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorOutput {
    pub error: String,
}
