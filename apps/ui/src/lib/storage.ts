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

/** Whether a stored key is one of this profile's chats: the prefix and the chat's id; a longer key is another profile's, or not a chat. */
export function isSessionKey(key: string | null | undefined): key is string {
  return !!key?.startsWith(getPrefix()) && !key.slice(getPrefix().length).includes("_");
}

/**
 * Messages a chat's session keeps in localStorage when the engine keeps its history too (a paired chat's, in IndexedDB):
 * its last ones, for the chat list and a chat's first moment. The rest the page reads from the engine's copy. A chat of
 * thousands of messages used to fill the page's storage (5 MB in WebKit, the Desktop app's) and its writes failed
 * without a word, so it stopped showing what came; and every read parsed megabytes.
 */
export const STORED_MESSAGES = 200;

/** Per chat: the ids of the messages the engine keeps and the mirror would bring back (`platform/sync.ts`). */
const inEngine = new Map<string, ReadonlySet<string>>();

/**
 * The messages of this chat the engine keeps, as the mirror would write them into its session: those may leave the
 * session's stored copy, older than its last `STORED_MESSAGES`. Any other (a call's line, a file of mine the chat added
 * itself) stays there whatever its age: nothing else keeps it.
 */
export function setEngineMessages(sessionId: string, ids: ReadonlySet<string>): void {
  inEngine.set(sessionId, ids);
}

/**
 * Per chat: its whole history as this page last saved it, the messages its stored copy no longer holds included. A
 * session read here gets them back (`withWhole`), so the chat has all of it without localStorage holding it.
 */
const whole = new Map<string, ChatMessage[]>();

/**
 * The session as it is stored: without the messages the engine keeps older than its last `STORED_MESSAGES`, and how
 * many went (`older`), which the unread count needs.
 */
function stored(session: ChatSession): ChatSession {
  const ids = inEngine.get(session.id);
  const all = session.messages;
  if (!ids || all.length <= STORED_MESSAGES) return session;
  const from = all.length - STORED_MESSAGES;
  const keep = all.filter((m, i) => i >= from || !ids.has(m.id));
  if (keep.length === all.length) return session;
  return { ...session, messages: keep, older: (session.older ?? 0) + all.length - keep.length };
}

/**
 * A stored session with the messages its stored copy left out, as this page last saved them; one deleted since (here
 * or in another page of this app) stays out. Without them in this page (just loaded, before the engine speaks), its last
 * messages only, with `older` saying how many are not there.
 */
function withWhole(session: ChatSession, list = whole.get(session.id)): ChatSession {
  if (!session.older || !list) return session;
  const shown = new Set(session.messages.map((m) => m.id));
  for (const id of session.deletedIds ?? []) shown.add(id);
  const rest = list.filter((m) => !shown.has(m.id));
  // Both in time order: one pass puts them together.
  const messages: ChatMessage[] = [];
  let i = 0, j = 0;
  while (i < rest.length || j < session.messages.length) {
    if (j >= session.messages.length || (i < rest.length && rest[i].timestamp <= session.messages[j].timestamp)) messages.push(rest[i++]);
    else messages.push(session.messages[j++]);
  }
  const { older: _older, ...complete } = session;
  return { ...complete, messages };
}

export function saveSession(session: ChatSession): void {
  const kept = stored(session);
  // A whole history (not one read without its older messages) is what this page reads back from now on.
  if (!session.older) {
    if (kept !== session) whole.set(session.id, session.messages.slice());
    else whole.delete(session.id);
  }
  try {
    const raw = JSON.stringify(kept);
    // Unchanged: no write, so another page of this app (the extension's) is not told to read it again.
    if (localStorage.getItem(getKey(session.id)) === raw) return;
    localStorage.setItem(getKey(session.id), raw);
  } catch {
    // storage full or unavailable
  }
}

/** A session as stored, unparsed: to tell cheaply whether it changed. */
export function storedSession(sessionId: string): string | null {
  try {
    return localStorage.getItem(getKey(sessionId));
  } catch {
    return null;
  }
}

/** The session as stored, its older messages left out (see `STORED_MESSAGES`). */
function loadStored(sessionId: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(getKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}

/** A chat's session, with its whole history as this page knows it (see `withWhole`). */
export function loadSession(sessionId: string): ChatSession | null {
  const session = loadStored(sessionId);
  return session && withWhole(session);
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
  return addMessages(sessionId, [message]);
}

/**
 * `addMessage` for many at once: the session is read and written once, however many there are (a long history
 * coming in from the peer). Ones it has, or that were deleted here, are skipped.
 */
export function addMessages(
  sessionId: string,
  messages: readonly ChatMessage[],
  /** These bring back every message its stored copy left out (the engine's whole history): the list is whole again. */
  complete = false,
): ChatSession | null {
  const session = loadSession(sessionId);
  if (!session) return null;
  if (complete) delete session.older;

  const known = new Set([...session.messages.map((m) => m.id), ...(session.deletedIds ?? [])]);
  const fresh = messages.filter((m) => !known.has(m.id) && known.add(m.id));
  if (!fresh.length) return session;

  // A history made whole again (after a reload) brings back older messages, not new ones: the chat keeps its place and
  // time in the list unless one of them is newer than what it had.
  const newest = session.messages[session.messages.length - 1]?.timestamp ?? 0;
  session.messages.push(...fresh);
  session.messages.sort((a, b) => a.timestamp - b.timestamp);
  if (!complete || fresh.some((m) => m.timestamp > newest)) session.lastSyncAt = Date.now();

  for (const message of fresh) {
    if ((message.sender === "peer" || message.sender === "system") && message.id.startsWith("peer_")) {
      const joinMatch = message.nick ? null : message.text.match(/^👋 (.+) joined$/);
      const nick = peerDisplayName(message.nick ?? joinMatch?.[1]);
      if (nick && session.nickSource !== "profile") session.nick = nick;
    }
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
  const older = session.older ?? 0;
  setReadCount(sessionId, Math.min(older + index < lastRead ? lastRead - 1 : lastRead, older + session.messages.length));
  return session;
}

/**
 * The chats deleted on this page, by the contact's link key. Session sync gives a link with no chat 15 s before it
 * drops it (a chat the engine just made may not be mirrored yet); a chat the person deleted is not one of those, so
 * its link goes at once and the app stops answering for it (receipts included).
 */
const deletedPeers = new Set<string>();
export function wasDeleted(peerPubKeyB64: string): boolean {
  return deletedPeers.has(peerPubKeyB64);
}

export function deleteSession(sessionId: string): void {
  // The name and photo chosen for the contact (identities/contactFace.ts) go with their last chat.
  const peer = loadSession(sessionId)?.peerPubKeyB64;
  if (peer) deletedPeers.add(peer);
  const lastOfPeer = !!peer && !listSessions().some(s => s.id !== sessionId && s.peerPubKeyB64 === peer);
  whole.delete(sessionId);
  inEngine.delete(sessionId);
  for (const key of [
    // So do the card and network tab the payment sheet last used with them (lib/chatPayments.ts), kept by their key.
    ...(lastOfPeer ? [`${getPrefix()}face_${peer}`, `${getPrefix()}payment_rail_${peer}`, `${getPrefix()}payment_network_${peer}`] : []),
    getKey(sessionId),
    `${getPrefix()}read_${sessionId}`,
    `${getPrefix()}invite_${sessionId}`,
    `${getPrefix()}pin_${sessionId}`,
    `${getPrefix()}mute_${sessionId}`,
    `${getPrefix()}mute_mentions_${sessionId}`,
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

/**
 * Sessions already parsed, by key, with the text each was parsed from (`listSessions`). Whoever keeps one owns its
 * sessions: one changed in place must be saved, or dropped from the cache.
 */
export type SessionCache = Map<string, { raw: string; session: ChatSession; whole?: { list: ChatMessage[]; session: ChatSession } }>;

/** Every chat, pinned first, then the latest first. With a cache, only a session whose stored text changed is parsed. */
export function listSessions(cache?: SessionCache): ChatSession[] {
  const sessions: ChatSession[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    try {
      const key = localStorage.key(i);
      if (!isSessionKey(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const hit = cache?.get(key);
      const parsed = hit?.raw === raw ? hit.session : JSON.parse(raw) as ChatSession;
      // With its older messages, the same object while neither it nor its whole history changed (the sync's reconcile
      // tells an unchanged list by its sessions' identity).
      const list = parsed.older ? whole.get(parsed.id) : undefined;
      const known = hit?.session === parsed && list && hit.whole?.list === list ? hit.whole : undefined;
      const session = !list ? parsed : known?.session ?? withWhole(parsed, list);
      if (cache && (hit?.session !== parsed || hit.whole?.session !== (list ? session : undefined))) cache.set(key, { raw, session: parsed, ...(list && { whole: { list, session } }) });
      seen.add(key);
      if (session.id && session.mySeedB64 && session.peerPubKeyB64 && session.encKeyB64) {
        sessions.push(session);
      }
    } catch {
      continue;
    }
  }
  if (cache) for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
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
      unread += unreadAfter(session.messages, read - (session.older ?? 0));
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
  // As stored: how many there are, without putting the older ones back together.
  const session = loadStored(sessionId);
  if (!session) return;
  setReadCount(sessionId, (session.older ?? 0) + session.messages.length);
}

/**
 * What counts as unread: what came to me since the last read message. Never a message of mine (one forwarded here
 * from another chat lands while this one is not open) nor a join line, which the other side's app adds by itself.
 * Of a call's lines, only a missed call: the others tell of a call I was on or made, written while its chat was
 * loaded off screen (it rang, or I opened another chat during it).
 */
function countsAsUnread(message: ChatMessage): boolean {
  if (message.callEvent) return message.callEvent.type === "call_missed";
  return message.sender !== "me" && message.systemEvent?.type !== "join";
}

function unreadAfter(messages: readonly ChatMessage[], read: number): number {
  let unread = 0;
  for (let i = Math.max(0, read); i < messages.length; i++) if (countsAsUnread(messages[i]!)) unread++;
  return unread;
}

export function getUnreadCount(session: ChatSession): number {
  // A session read without its older messages counts from its first one kept.
  return unreadAfter(session.messages, getLastReadCount(session.id) - (session.older ?? 0));
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
