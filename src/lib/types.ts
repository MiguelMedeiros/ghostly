import type { CallEventType, VoiceMeta } from "@ghostly/core";

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
  /** A voice message: its length and the shape of its sound, measured when it was recorded. */
  voice?: VoiceMeta;
}

export interface ChatMessage {
  /** `held`: waiting in this device's storage for the contact to come back (WISP 4xx). */
  /** `waiting`: not sent yet, goes by itself when the chat can carry it ("Sends when live"). */
  delivery?: "sending" | "sent" | "queued" | "waiting" | "held" | "delivered" | "failed";
  deliveryError?: string;
  id: string;
  text: string;
  sender: "me" | "peer" | "system";
  timestamp: number;
  nick?: string;
  meta?: MessageMeta;
  file?: ChatFile;
  /** A payment or payment request; its live state is kept by the platform under this id. */
  paymentId?: string;
  /** A group message's mentions, with the names they show now (src/lib/parse/mentions.ts). */
  mentions?: import("./parse/mentions").MentionView[];
  /** A link preview made by the sender's app and carried with the text (WISP 401 § Link previews). */
  preview?: import("@ghostly/core").LinkPreview;
  /** The id both sides of the chat know this message by, which a reply to it names (the engine's `replyRef`). */
  ref?: string;
  /** The message this one answers (WISP 400 § Replies). */
  replyTo?: import("@ghostly/browser/shared/types").MessageReply;
  /** Reactions to it, one per person (WISP 400 § Reactions): `me`, `peer`, or a member's key. */
  reactions?: Record<string, import("@ghostly/browser/shared/types").MessageReaction>;
  /** An edited text (WISP 400 § Edits): `text` is the latest version; the earlier ones are in the history. */
  edit?: import("@ghostly/browser/shared/types").MessageEdit;
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
  profile?: "paired-chat/1";
  deliveryMode?: "stream" | "dht";
  id: string;
  mySeedB64: string;
  peerPubKeyB64: string;
  encKeyB64: string;
  /** The inviter's own participation seed, whose public key its `ghostly1` code carries. Never shared. */
  participationSeedB64?: string;
  /** The joiner's copy of that public key, from the code: the only key that may answer first. */
  peerParticipationKeyB64?: string;
  messages: ChatMessage[];
  createdAt: number;
  lastSyncAt?: number;
  /**
   * When the contact last shared an identity (milliseconds), mirrored from the engine: newer than the last message,
   * the chat list says so in its place and the chat moves up. Not a message, so not unread.
   */
  identitySharedAt?: number;
  /**
   * The chat's latest reaction (WISP 400 § Reactions), from the engine: the chat list says it in the preview's place
   * while it is newer than the last message, and the chat moves up. Not a message, so not unread.
   */
  lastReaction?: import("@ghostly/browser/shared/types").ReactionNote;
  /** The contact's name: what they last said they go by, or else read out of their messages. */
  nick?: string;
  /**
   * `profile`: `nick` is what the contact itself last said it goes by (WISP 401 § name and picture, or a
   * legacy chat's record), which a name read out of an older message no longer replaces.
   */
  nickSource?: "profile";
  /** The name given to this chat here; it wins over the contact's own. */
  label?: string;
  /** A compatibility chat (WISP 402) that invited its contact to a new chat: that chat's session id. */
  continuedIn?: string;
  /**
   * Messages deleted here, by id. The peer keeps republishing what it sent for
   * a few minutes and the peer engine mirrors its own store into this session,
   * so without this the message would simply come back.
   */
  deletedIds?: string[];
}

export interface ChatParams {
  profile?: "paired-chat/1";
  deliveryMode?: "stream" | "dht";
  /** The stored session these keys belong to. */
  sessionId: string;
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
