import type { GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";

/**
 * The JSON shapes the CLI and the daemon answer with. They are the contract bots code against (WISP 11xx), kept
 * apart from the engine's views: those change with the app, these only by adding fields.
 */

export interface ChatJson {
  id: string;
  /** The label set here, else the name the contact gave, else null. */
  name: string | null;
  label: string | null;
  peerName: string | null;
  /** The contact's key for this chat (z-base-32). */
  peer: string;
  createdAt: number;
  lastMessageAt: number;
  /** A live session carries the chat (text, files, payments go at once). */
  live: boolean;
  /** The transport of the live session, or null. */
  transport: string | null;
  /** How text goes now: `stream` (live), `dht` (the DHT floor, 256 bytes), `hold`, or `unavailable`. */
  text: string;
  /** The pairing's state: connecting, waiting, ready, failed. */
  pairing: string | null;
  /** How far the first pairing got (publishing, waiting, resolving, on-dht, live, …), while it is under way. */
  stage: string | null;
  verified: boolean;
  /** The invite this side made for the chat, while it waits for the contact. */
  invite: string | null;
  /** A chat of the older protocol (WISP 402). */
  compatibility: boolean;
}

export function chatJson(link: LinkView): ChatJson {
  const label = link.label?.trim() || null;
  const peerName = link.peerNick?.trim() || null;
  const live = link.textDelivery === "stream";
  return {
    id: link.id,
    name: label ?? peerName,
    label,
    peerName,
    peer: link.peerPubKeyZ32,
    createdAt: link.createdAt,
    lastMessageAt: link.lastMessageAt,
    live,
    transport: live ? (link.pairing?.transport ?? link.pairingProgress?.transport ?? null) : null,
    text: link.textDelivery ?? (link.profile ? "unavailable" : "dht"),
    pairing: link.pairing?.status ?? null,
    stage: link.pairingProgress?.stage ?? null,
    verified: !!link.peerVerified,
    invite: link.pairing?.status === "ready" ? null : link.inviteCode ?? null,
    compatibility: !link.profile,
  };
}

/** A chat's details: the summary plus what its connection panel shows. */
export function chatDetailsJson(link: LinkView) {
  return {
    ...chatJson(link),
    progress: link.pairingProgress ?? null,
    transports: { mine: link.availableTransports ?? [], peer: link.peerTransports ?? [], preferred: link.preferredTransport ?? null, fallback: link.transportFallback ?? null, automatic: link.transportAutomatic ?? null, relayed: link.relayedTransports ?? [] },
    wait: link.transportWait ?? null,
    lastAttempt: link.liveAttempt ?? null,
    liveSince: link.transportLive?.since ?? null,
    rttMs: link.transportRttMs ?? null,
    relays: link.transportRelayed?.relays ?? null,
    deliveryMode: link.deliveryMode ?? null,
    capabilities: link.capabilities ?? null,
    hold: link.hold ?? null,
    peerOnline: link.peerOnline,
    peerLastSeenAt: link.peerLastSeenAt || null,
    history: link.transportHistory ?? null,
    errors: link.transportErrors ?? null,
    comparisonCode: link.pairing?.code ?? null,
  };
}

export interface MessageJson {
  id: string;
  chat: string;
  from: "me" | "peer";
  text: string;
  timestamp: number;
  delivery: string | null;
  deliveryError: string | null;
  via: string;
  nick: string | null;
  member?: string;
  mentions?: { key: string; offset: number; length: number }[];
  mentioned?: boolean;
  file?: { id: string; name: string; size: number; mime: string; voice?: boolean };
  paymentId?: string;
  event?: unknown;
}

export function messageJson(message: StoredMessage): MessageJson {
  return {
    id: message.id,
    chat: message.linkId,
    from: message.sender,
    text: message.text,
    timestamp: message.timestamp,
    // A received message is delivered by definition; one of mine without a state went before states existed.
    delivery: message.delivery ?? (message.sender === "peer" ? null : "sent"),
    deliveryError: message.deliveryError ?? null,
    via: message.via,
    nick: message.nick ?? null,
    ...(message.member ? { member: message.member } : {}),
    ...(message.mentions?.length ? { mentions: message.mentions.map((m) => ({ key: m.k, offset: m.o, length: m.l })) } : {}),
    ...(message.mentioned ? { mentioned: true } : {}),
    ...(message.file ? { file: { id: message.file.id, name: message.file.name, size: message.file.size, mime: message.file.mime, ...(message.file.voice ? { voice: true } : {}) } } : {}),
    ...(message.paymentId ? { paymentId: message.paymentId } : {}),
    ...(message.event ? { event: message.event } : {}),
  };
}

export function groupJson(group: GroupView) {
  return {
    id: group.id,
    name: group.name,
    profile: group.profile,
    status: group.status ?? (group.invitation ? "invited" : null),
    statusReason: group.statusReason ?? null,
    admin: group.isAdmin,
    me: group.myKey ?? null,
    canSend: group.canSend,
    link: group.entryLink ?? null,
    lastMessageAt: group.lastMessageAt,
    members: group.members.map((m) => ({ key: m.key, name: m.nick ?? null, role: m.role, me: m.me, online: m.online })),
    invitation: group.invitation ? { chat: group.invitation.linkId, accepted: group.invitation.accepted, viaLink: !!group.invitation.viaLink, stage: group.invitation.stage ?? null } : null,
    community: group.community ?? null,
  };
}
