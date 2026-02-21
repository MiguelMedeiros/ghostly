import { invoke } from "@tauri-apps/api/core";

export interface PkarrMessage {
  text: string;
  timestamp: number;
  nick?: string;
}

export interface PkarrResolvedBatch {
  messages: PkarrMessage[];
  latestTimestamp: number;
  peerAck: number;
  rawRecordNames: string[];
  encryptedPayloadLength: number;
  packetTimestamp: number;
  messageCount: number;
}

export interface CompactMessage {
  t: number;
  m: string;
}

interface RustResolvedBatch {
  messages: { text: string; timestamp: number; nick: string | null }[];
  latest_timestamp: number;
  peer_ack: number;
  raw_record_names: string[];
  encrypted_payload_length: number;
  packet_timestamp: number;
  message_count: number;
}

interface RustKeypairResult {
  seed_b64: string;
  pub_key_z32: string;
}

export async function createKeypair(): Promise<{
  seedB64: string;
  pubKeyZ32: string;
}> {
  const result = await invoke<RustKeypairResult>("create_keypair");
  return { seedB64: result.seed_b64, pubKeyZ32: result.pub_key_z32 };
}

export async function getPublicKeyFromSeed(
  seedB64: string,
): Promise<string> {
  return invoke<string>("get_public_key", { seedB64 });
}

export async function publishMessages(
  seedB64: string,
  messages: CompactMessage[],
  encKeyB64: string,
  ackTimestamp: number,
  nick?: string,
): Promise<number> {
  return invoke<number>("publish_messages", {
    seedB64,
    messages,
    encKeyB64,
    ackTimestamp,
    nick: nick ?? null,
  });
}

export async function resolveMessages(
  publicKeyZ32: string,
  encKeyB64: string,
): Promise<PkarrResolvedBatch | null> {
  const result = await invoke<RustResolvedBatch | null>("resolve_messages", {
    publicKeyZ32,
    encKeyB64,
  });

  if (!result) return null;

  return {
    messages: result.messages.map((m) => ({
      text: m.text,
      timestamp: m.timestamp,
      nick: m.nick ?? undefined,
    })),
    latestTimestamp: result.latest_timestamp,
    peerAck: result.peer_ack,
    rawRecordNames: result.raw_record_names,
    encryptedPayloadLength: result.encrypted_payload_length,
    packetTimestamp: result.packet_timestamp,
    messageCount: result.message_count,
  };
}

export { fromBase64Url, toBase64Url } from "./crypto";
