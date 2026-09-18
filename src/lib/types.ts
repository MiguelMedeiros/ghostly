import type { CallEventType } from "@ghostly/core";

export type { CallEventType, CallSignal, CallState } from "@ghostly/core";

export interface MessageMeta {
  dhtKey: string;
  encryptedPayloadLength: number;
  dnsRecords: string[];
  packetTimestamp?: number;
}

export type SystemEventType =
  | "join"
  | "call";

/** A file sent over the peer-to-peer link. The bytes are kept by the platform under `id`. */
export interface ChatFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface ChatMessage {
  id: string;
  text: string;
  sender: "me" | "peer" | "system";
  timestamp: number;
  nick?: string;
  meta?: MessageMeta;
  file?: ChatFile;
  systemEvent?: {
    type: SystemEventType;
    pubKey?: string;
  };
  callEvent?: {
    type: CallEventType;
    hasVideo?: boolean;
    duration?: number;
  };
}

export interface ChatSession {
  id: string;
  mySeedB64: string;
  peerPubKeyB64: string;
  encKeyB64: string;
  messages: ChatMessage[];
  createdAt: number;
  lastSyncAt?: number;
  nick?: string;
  label?: string;
}

export interface ChatParams {
  seedB64: string;
  peerPubKeyB64: string;
  encKeyB64: string;
  nick?: string;
}

export type ConnectionStatus = "connecting" | "online" | "offline" | "error";


export interface ChatTechInfo {
  sessionId: string;
  myPubKey: string;
  peerPubKey: string;
  encKeyPreview: string;
  pollCount: number;
  currentPollInterval: number;
  republishInterval: number;
  messageTtl: number;
  protocol: string;
  encryption: string;
  relays: string[];
  createdAt: number;
  myAck: number;
  peerAck: number;
  sentBufferSize: number;
}
