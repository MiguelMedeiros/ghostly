use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct KeypairResult {
    pub seed_b64: String,
    pub pub_key_z32: String,
}

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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PkarrMessage {
    pub text: String,
    pub timestamp: i64,
    pub nick: Option<String>,
}
