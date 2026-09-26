import { MAX_NICK_LENGTH, sanitizeDisplayText, type LinkParams } from "@ghostly/core";
import type { ChatMessage, ChatSession } from "./types";

/**
 * The name a peer goes by in the sidebar and the chat header. It comes from
 * the peer, either as `_nick` or read back out of its "joined" message, so it
 * is cut and stripped of what could make it read as another contact.
 */
export function peerDisplayName(name: string | undefined): string | undefined {
  return name ? sanitizeDisplayText(name, MAX_NICK_LENGTH) : undefined;
}

export const GHOST_NAMES = [
  "Casper", "Phantom", "Specter", "Shadow", "Wraith",
  "Spirit", "Poltergeist", "Banshee", "Shade", "Apparition",
  "Ghoul", "Spook", "Haunt", "Eidolon", "Revenant",
  "Wisp", "Vapor", "Mist", "Echo", "Whisper",
  "Glimmer", "Flicker", "Drift", "Haze", "Blur",
  "Enigma", "Mystery", "Riddle", "Puzzle", "Cipher",
  "Twilight", "Dusk", "Dawn", "Midnight", "Eclipse",
  "Frost", "Storm", "Thunder", "Lightning", "Tempest",
  "Raven", "Crow", "Owl", "Bat", "Wolf",
  "Onyx", "Obsidian", "Cobalt", "Slate", "Ash"
];

export function getRandomGhostName(): string {
  const index = Math.floor(Math.random() * GHOST_NAMES.length);
  return GHOST_NAMES[index];
}

export function getGhostName(peerKey: string): string {
  let hash = 0;
  for (let i = 0; i < peerKey.length; i++) {
    const char = peerKey.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const index = Math.abs(hash) % GHOST_NAMES.length;
  return GHOST_NAMES[index];
}

let _profile = "";

export function setStorageProfile(profile: string): void {
  _profile = profile;
}

/** The local profile this app runs as (WISP 04). Empty: the default profile, the original namespace. */
export function getStorageProfile(): string {
  return _profile;
}

export function getPrefix(): string {
  return _profile ? `ghostly_${_profile}_` : "ghostly_";
}

/**
 * Whether a key with this app's prefix belongs to this profile. The default profile's prefix is also the
 * start of every other profile's, whose keys carry `<profile>_` after it; a chat's own id never has `_`.
 */
export function ownsKey(key: string): boolean {
  if (!key.startsWith(getPrefix())) return false;
  if (_profile) return true;
  const rest = key.slice(getPrefix().length);
  return !PROFILE_KEY.test(rest) && !otherSpaces().some((ns) => rest.startsWith(`${ns}_`));
}
/**
 * Other storage spaces in this storage area (Desktop's GHOSTLY_PROFILE, and their profiles): each keeps
 * its settings under `ghostly_<space>_app_settings`, so its keys are not the default profile's.
 */
function otherSpaces(): string[] {
  const spaces: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const match = /^ghostly_(.+)_app_settings$/.exec(localStorage.key(i) ?? "");
    if (match) spaces.push(match[1]);
  }
  return spaces;
}
/** What follows `ghostly_` in another profile's keys: its 10-character id and `_`. */
const PROFILE_KEY = /^[a-z0-9]{10}_/;

function getKey(sessionId: string): string {
  return `${getPrefix()}${sessionId}`;
}

export function saveSession(session: ChatSession): void {
  try {
    localStorage.setItem(getKey(session.id), JSON.stringify(session));
  } catch {
    // storage full or unavailable
  }
}

export function loadSession(sessionId: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(getKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}

/**
 * How many deleted ids a chat remembers. They only keep what the peer is still
 * republishing from coming back, so the oldest ones can go.
 */
const MAX_DELETED_IDS = 500;

export function addMessage(
  sessionId: string,
  message: ChatMessage,
): ChatSession | null {
  const session = loadSession(sessionId);
  if (!session) return null;

  const exists = session.messages.some((m) => m.id === message.id);
  if (exists) return session;
  if (session.deletedIds?.includes(message.id)) return session;

  session.messages.push(message);
  session.messages.sort((a, b) => a.timestamp - b.timestamp);
  session.lastSyncAt = Date.now();
  
  if ((message.sender === "peer" || message.sender === "system") && message.id.startsWith("peer_")) {
    const joinMatch = message.nick ? null : message.text.match(/^👋 (.+) joined$/);
    const nick = peerDisplayName(message.nick ?? joinMatch?.[1]);
    if (nick && session.nickSource !== "profile") session.nick = nick;
  }
  
  saveSession(session);
  return session;
}

/**
 * Forgets one message on this device. The contact keeps their copy: nothing is
 * sent, and what the peer already published stays published until it expires.
 */
export function deleteMessage(
  sessionId: string,
  messageId: string,
): ChatSession | null {
  const session = loadSession(sessionId);
  if (!session) return null;

  const index = session.messages.findIndex((m) => m.id === messageId);
  if (index === -1) return null;

  session.messages.splice(index, 1);
  session.deletedIds = [...(session.deletedIds ?? []), messageId].slice(-MAX_DELETED_IDS);
  saveSession(session);

  // Unread is "messages since the last read one": a read message that goes
  // takes its place in that count with it, or every later one reads as unread.
  const lastRead = getLastReadCount(sessionId);
  setReadCount(sessionId, Math.min(index < lastRead ? lastRead - 1 : lastRead, session.messages.length));
  return session;
}

export function deleteSession(sessionId: string): void {
  // The name and photo chosen for the contact (identities/contactFace.ts) go with their last chat.
  const peer = loadSession(sessionId)?.peerPubKeyB64;
  const lastOfPeer = !!peer && !listSessions().some(s => s.id !== sessionId && s.peerPubKeyB64 === peer);
  for (const key of [
    ...(lastOfPeer ? [`${getPrefix()}face_${peer}`] : []),
    getKey(sessionId),
    `${getPrefix()}read_${sessionId}`,
    `${getPrefix()}invite_${sessionId}`,
    `${getPrefix()}pin_${sessionId}`,
    `${getPrefix()}mute_${sessionId}`,
    `${getPrefix()}draft_${sessionId}`,
    joinKey(sessionId),
    LEGACY_JOIN_PREFIX + sessionId,
  ]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

/**
 * Only the chats. Settings, call window preferences and the record of settled
 * payments share the `ghostly_` prefix and must survive this.
 */
export function deleteAllSessions(): void {
  for (const session of listSessions()) deleteSession(session.id);
}

export function getSessionDraft(id: string): string {
  try { return localStorage.getItem(`${getPrefix()}draft_${id}`) ?? ""; } catch { return ""; }
}
export function setSessionDraft(id: string, text: string): void {
  try { const key=`${getPrefix()}draft_${id}`; if(text) localStorage.setItem(key,text); else localStorage.removeItem(key); } catch { /* Keep the in-memory draft if storage is unavailable. */ }
}

export function isSessionPinned(sessionId: string): boolean {
  return localStorage.getItem(`${getPrefix()}pin_${sessionId}`) === "1";
}

export function setSessionPinned(sessionId: string, pinned: boolean): void {
  if (!loadSession(sessionId)) return;
  const key = `${getPrefix()}pin_${sessionId}`;
  if (pinned) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
  window.dispatchEvent(new Event("session-updated"));
}

export function listSessions(): ChatSession[] {
  const sessions: ChatSession[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    try {
      const key = localStorage.key(i);
      // A chat's key is the prefix and its id; a longer key is another profile's, or not a chat.
      if (!key?.startsWith(getPrefix()) || key.slice(getPrefix().length).includes("_")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const session = JSON.parse(raw) as ChatSession;
      if (session.id && session.mySeedB64 && session.peerPubKeyB64 && session.encKeyB64) {
        sessions.push(session);
      }
    } catch {
      continue;
    }
  }
  sessions.sort((a, b) => {
    const pinOrder = Number(isSessionPinned(b.id)) - Number(isSessionPinned(a.id));
    if (pinOrder) return pinOrder;
    const aTime = a.lastSyncAt ?? a.createdAt;
    const bTime = b.lastSyncAt ?? b.createdAt;
    return bTime - aTime;
  });
  return sessions;
}

/**
 * Unread messages in the chats kept under a storage prefix: another profile's, read without starting it
 * (the account bar's switcher). Same count as the chat list's: messages since the last read one.
 */
export function unreadUnder(prefix: string): number {
  let unread = 0;
  for (let i = 0; i < localStorage.length; i++) {
    try {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) || key.slice(prefix.length).includes("_")) continue;
      const session = JSON.parse(localStorage.getItem(key) ?? "null") as ChatSession | null;
      if (!session?.id || !session.mySeedB64 || !session.peerPubKeyB64 || !session.encKeyB64 || !Array.isArray(session.messages)) continue;
      const read = parseInt(localStorage.getItem(`${prefix}read_${session.id}`) ?? "0", 10) || 0;
      unread += Math.max(0, session.messages.length - read);
    } catch {
      continue;
    }
  }
  return unread;
}

export function getLastReadCount(sessionId: string): number {
  try {
    const val = localStorage.getItem(`${getPrefix()}read_${sessionId}`);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

function setReadCount(sessionId: string, count: number): void {
  try {
    localStorage.setItem(`${getPrefix()}read_${sessionId}`, String(count));
  } catch {
    // storage full or unavailable
  }
}

export function markSessionAsRead(sessionId: string): void {
  const session = loadSession(sessionId);
  if (!session) return;
  setReadCount(sessionId, session.messages.length);
}

export function getUnreadCount(session: ChatSession): number {
  const lastRead = getLastReadCount(session.id);
  return Math.max(0, session.messages.length - lastRead);
}

/**
 * Keeps the chat's contact name to what the contact itself last said (on the paired session, or in a legacy
 * chat's record); `""` means they have none to show. Returns whether anything changed.
 */
export function setSessionPeerNick(sessionId: string, peerNick: string): boolean {
  const session = loadSession(sessionId);
  if (!session) return false;
  const nick = peerDisplayName(peerNick);
  if (session.nickSource === "profile" && session.nick === nick) return false;
  session.nick = nick;
  session.nickSource = "profile";
  saveSession(session);
  return true;
}

export function updateSessionLabel(sessionId: string, label: string): void {
  const session = loadSession(sessionId);
  if (!session) return;
  session.label = label || undefined;
  saveSession(session);
}

/**
 * Whether this side already announced itself on a chat. Written outside the
 * `ghostly` namespace once, which meant deleting a chat and "Clear all data"
 * both left one key per chat behind, each carrying its session id.
 */
export const LEGACY_JOIN_PREFIX = "joinSent_";

function joinKey(sessionId: string): string {
  return `${getPrefix()}join_${sessionId}`;
}

export function hasAnnouncedJoin(sessionId: string): boolean {
  try {
    return (
      localStorage.getItem(joinKey(sessionId)) === "true" ||
      localStorage.getItem(LEGACY_JOIN_PREFIX + sessionId) === "true"
    );
  } catch {
    return false;
  }
}

export function markJoinAnnounced(sessionId: string): void {
  try {
    localStorage.setItem(joinKey(sessionId), "true");
    localStorage.removeItem(LEGACY_JOIN_PREFIX + sessionId);
  } catch {
    // storage full or unavailable
  }
}

export function saveInviteCode(sessionId: string, code: string): void {
  try {
    localStorage.setItem(`${getPrefix()}invite_${sessionId}`, code);
  } catch {
    // storage full or unavailable
  }
}

export function forgetInviteCode(sessionId: string): void {
  localStorage.removeItem(`${getPrefix()}invite_${sessionId}`);
}

export function getInviteCode(sessionId: string): string | null {
  try {
    return localStorage.getItem(`${getPrefix()}invite_${sessionId}`);
  } catch {
    return null;
  }
}

/**
 * The id sessions were stored under before ids became random: a 32-bit hash of
 * the first characters of the keys. Only used to find those sessions again.
 */
function legacySessionId(mySeedB64: string, peerPubKeyB64: string): string {
  const combined = mySeedB64.slice(0, 8) + peerPubKeyB64.slice(0, 8);
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** 128 random bits. Opaque: the id is what goes in the URL, never the keys. */
function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stored session for this pair of keys, whatever id it was stored under. */
export function findSession(
  mySeedB64: string,
  peerPubKeyB64: string,
): ChatSession | null {
  const matches = (s: ChatSession | null): s is ChatSession =>
    !!s && s.mySeedB64 === mySeedB64 && s.peerPubKeyB64 === peerPubKeyB64;
  const legacy = loadSession(legacySessionId(mySeedB64, peerPubKeyB64));
  if (matches(legacy)) return legacy;
  return listSessions().find(matches) ?? null;
}

export interface SessionKeys {
  profile?: "paired-chat/1";
  deliveryMode?: "stream" | "dht";
  seedB64: string;
  peerPubKeyB64: string;
  encKeyB64: string;
  participationSeedB64?: string;
  peerParticipationKeyB64?: string;
}

/** What the engine needs to run a stored session's link (`ensureLink`). */
export function sessionLinkParams(session: ChatSession): LinkParams {
  return {
    profile: session.profile,
    deliveryMode: session.deliveryMode,
    seedB64: session.mySeedB64,
    peerPubKeyZ32: session.peerPubKeyB64,
    encKeyB64: session.encKeyB64,
    ...(session.participationSeedB64 ? { participationSeedB64: session.participationSeedB64 } : {}),
    ...(session.peerParticipationKeyB64 ? { peerParticipationKeyZ32: session.peerParticipationKeyB64 } : {}),
  };
}

/**
 * The id of the session for these keys, stored first if it is new. Chats are
 * routed by this id so the keys never reach the address bar or the history.
 */
export function ensureSession(
  keys: SessionKeys,
  options: { inviteCode?: string; createdAt?: number } = {},
): string {
  const existing = findSession(keys.seedB64, keys.peerPubKeyB64);
  if (existing && existing.profile !== keys.profile) throw new Error("Invitation profile does not match this stored conversation");
  const id = existing?.id ?? newSessionId();
  if (!existing) {
    saveSession({
      id,
      profile: keys.profile,
      deliveryMode: keys.deliveryMode,
      mySeedB64: keys.seedB64,
      peerPubKeyB64: keys.peerPubKeyB64,
      encKeyB64: keys.encKeyB64,
      ...(keys.participationSeedB64 ? { participationSeedB64: keys.participationSeedB64 } : {}),
      ...(keys.peerParticipationKeyB64 ? { peerParticipationKeyB64: keys.peerParticipationKeyB64 } : {}),
      messages: [],
      createdAt: options.createdAt ?? Date.now(),
    });
  }
  if (options.inviteCode) saveInviteCode(id, options.inviteCode);
  return id;
}
