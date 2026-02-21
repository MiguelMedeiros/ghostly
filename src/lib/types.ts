export interface MessageMeta {
  dhtKey: string;
  encryptedPayloadLength: number;
  dnsRecords: string[];
  packetTimestamp?: number;
}

export interface ChatMessage {
  id: string;
  text: string;
  sender: "me" | "peer";
  timestamp: number;
  nick?: string;
  meta?: MessageMeta;
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
}

export interface ChatParams {
  seedB64: string;
  peerPubKeyB64: string;
  encKeyB64: string;
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
