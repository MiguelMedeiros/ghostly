import type { GroupView, LinkView, MessageFile, StoredMessage } from "@ghostly/browser/shared/types";
import type { StatusCard } from "@ghostly/core";

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
  /** The contact sent a picture (checked by the engine; `engine getState` has it). */
  peerPicture: boolean;
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
    peerPicture: !!link.peerAvatar,
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
  /** A file or voice message: its id is what `file wait`, `file save` and the `file.*` events name. */
  file?: { id: string; name: string; size: number; mime: string; voice?: { duration: number; peaks?: number[] }; image?: { width: number; height: number } };
  paymentId?: string;
  event?: unknown;
  /**
   * The message this one answers (WISP 400 § Replies). `id`: the original's message id here when it is in this chat
   * (`found`), else the id the reply named. `from`: null when nothing says (only the id came, over the DHT).
   */
  replyTo?: { id: string; snippet: string; from: "me" | "peer" | null; member?: string; found: boolean };
  /** Reactions to it, one per person (WISP 400 § Reactions): `by` is `me`, `peer` or a member's key. */
  reactions?: { by: string; emoji: string; at: number }[];
  /** An edited text (WISP 400 § Edits): `text` is the latest version, `edits` its number, `editedAt` when it was made. */
  edits?: number;
  editedAt?: number;
  /** Mine: the contact has not confirmed the latest edit yet. */
  editPending?: boolean;
  /** A forwarded message (WISP 400 § Forwards): how many times it has been forwarded. Never who wrote it first. */
  forwarded?: number;
  /** A bot's task or routine (WISP 4xx · Status Cards), as its version says it; `text` is its fallback. */
  card?: StatusCard;
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
    ...(message.file ? { file: fileJson(message.file) } : {}),
    ...(message.paymentId ? { paymentId: message.paymentId } : {}),
    ...(message.event ? { event: message.event } : {}),
    ...(message.replyTo ? { replyTo: { id: message.replyTo.messageId ?? message.replyTo.id, snippet: message.replyTo.snippet, from: message.replyTo.from ?? null,
      ...(message.replyTo.member ? { member: message.replyTo.member } : {}), found: !!message.replyTo.messageId } } : {}),
    ...(reactionsJson(message).length ? { reactions: reactionsJson(message) } : {}),
    ...(message.edit ? { edits: message.edit.seq, editedAt: message.edit.at, ...(message.edit.pending ? { editPending: true } : {}) } : {}),
    ...(message.forwarded ? { forwarded: message.forwarded } : {}),
    ...(message.card ? { card: message.card } : {}),
  };
}

/**
 * A message's file; a voice note's length (ms) and loudness bars ride along (older releases said only `voice: true`),
 * and a picture's size as it is shown when its sender sent it.
 */
export function fileJson(file: MessageFile): NonNullable<MessageJson["file"]> {
  return {
    id: file.id, name: file.name, size: file.size, mime: file.mime,
    ...(file.voice ? { voice: { duration: file.voice.duration, ...(file.voice.peaks?.length ? { peaks: [...file.voice.peaks] } : {}) } } : {}),
    ...(file.image ? { image: { width: file.image.width, height: file.image.height } } : {}),
  };
}

/** A message's reactions shown now (taken-back ones left out), oldest first. */
export function reactionsJson(message: StoredMessage): { by: string; emoji: string; at: number }[] {
  return Object.entries(message.reactions ?? {}).filter(([, r]) => r.e).sort(([, a], [, b]) => a.at - b.at).map(([by, r]) => ({ by, emoji: r.e, at: r.at }));
}

/**
 * A group's message with its author named: mesh and community messages are kept with the member's key only (the
 * name rides on the edge or the roster), so the roster fills `nick` when the message has none, and for an author no
 * longer in it (removed, or back with a new member key) the name the group knew them by.
 */
export function groupMessageJson(message: StoredMessage, group: Pick<GroupView, "members" | "formerNames"> | undefined): MessageJson {
  const json = messageJson(message);
  if (json.nick || !message.member) return json;
  const nick = group?.members.find((m) => m.key === message.member)?.nick ?? group?.formerNames?.[message.member];
  return nick ? { ...json, nick } : json;
}

/**
 * A group as the CLI prints it. The entry link lets anyone who reads it join, so it is `<hidden>` unless asked for
 * (`--show-secret`, or `group link`); null when the group has none.
 */
export function groupJson(group: GroupView, showSecret = false) {
  return {
    id: group.id,
    name: group.name,
    profile: group.profile,
    status: group.status ?? (group.invitation ? "invited" : null),
    statusReason: group.statusReason ?? null,
    admin: group.isAdmin,
    me: group.myKey ?? null,
    canSend: group.canSend,
    link: group.entryLink ? (showSecret ? group.entryLink : "<hidden>") : null,
    lastMessageAt: group.lastMessageAt,
    // Past 16 members with hubs (WISP 9xx · Group Mesh § Hubs): who is one, who is reached through them, what the admin chose.
    members: group.members.map((m) => ({ key: m.key, name: m.nick ?? null, role: m.role, me: m.me, online: m.online,
      ...(m.hub ? { hub: true } : {}), ...(m.viaHub ? { viaHub: true } : {}), ...(m.hubRole ? { hubRole: m.hubRole } : {}) })),
    ...(group.hubs ? { hubs: group.hubs } : {}),
    invitation: group.invitation ? { chat: group.invitation.linkId, accepted: group.invitation.accepted, viaLink: !!group.invitation.viaLink, stage: group.invitation.stage ?? null } : null,
    community: group.community ?? null,
    picture: !!group.picture,
  };
}
