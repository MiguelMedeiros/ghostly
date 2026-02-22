export interface MessageMeta {
  dhtKey: string;
  encryptedPayloadLength: number;
  dnsRecords: string[];
  packetTimestamp?: number;
}

export type CallEventType =
  | "call_started"
  | "call_received"
  | "call_connected"
  | "call_ended"
  | "call_missed"
  | "call_rejected";

export type SystemEventType =
  | "join"
  | "call";

export interface ChatMessage {
  id: string;
  text: string;
  sender: "me" | "peer" | "system";
  timestamp: number;
  nick?: string;
  meta?: MessageMeta;
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
}

export type ConnectionStatus = "connecting" | "online" | "offline" | "error";

export type CallState =
  | "idle"
  | "offering"
  | "incoming"
  | "answering"
  | "connecting"
  | "connected"
  | "ended";

export interface CallSignal {
  t: "o" | "a" | "h";
  ts: number;
  u?: string;
  p?: string;
  f?: string;
  s?: string;
  m?: string[];
  c?: string[];
  ss?: number[];
}

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
