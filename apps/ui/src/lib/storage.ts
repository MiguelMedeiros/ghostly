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
  const index = crypto.getRandomValues(new Uint32Array(1))[0]! % GHOST_NAMES.length;
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

/**
 * Messages a chat's stored copy keeps once it gave its room to another chat's (`makeRoom`), as `STORED_MESSAGES` does:
 * the engine keeps the rest. Room kept for this page's life, so the next write of that chat does not take it back.
 */
export const ROOM_MESSAGES = 20;
const gaveRoom = new Set<string>();

/**
 * A call's lines a chat keeps: its last ones; an older one goes from this device as a deleted message does
 * (`dropOldCallLines`). Nothing else keeps them, so its stored copy keeps every one it has (`stored`): a contact who
 * rang and hung up over and over left two lines a call, thousands, written again with every later message, until
 * localStorage refused the chat.
 */
export const CALL_LINES = STORED_MESSAGES;

/** Per chat: the ids of the messages the engine keeps and the mirror would bring back (`platform/sync.ts`). */
const inEngine = new Map<string, ReadonlySet<string>>();

/**
 * The messages of this chat the engine keeps, as the mirror would write them into its session: those may leave the
 * session's stored copy, older than its last `STORED_MESSAGES`. Any other (a call's line, a file of mine the chat added
 * itself) stays there whatever its age: nothing else keeps it. A chat keeps its last `CALL_LINES` call lines only.
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
  const last = gaveRoom.has(session.id) ? ROOM_MESSAGES : STORED_MESSAGES;
  if (!ids || all.length <= last) return session;
  const from = all.length - last;
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

/**
 * What this page wrote that localStorage refused (full: another profile's chats on the same origin, or this one's many),
 * by key: a chat's session, its read count. Read back from here before localStorage, so the chat list and the chat show
 * what the mirror put in (the engine keeps it, and the contact was told it was delivered) and my sends turn delivered.
 * Gone with the page: after a reload the engine's copy brings the rows back the same way. A write that succeeds later
 * takes its key out.
 */
const unsaved = new Map<string, string>();

/** A key as this page last wrote it: what localStorage refused to take, or what it holds. */
function readKey(key: string): string | null {
  return unsaved.get(key) ?? localStorage.getItem(key);
}

/** Writes a key, or keeps it in this page when localStorage refuses it (`unsaved`). Whether localStorage took it. */
function writeKey(key: string, value: string): boolean {
  const held = unsaved.size > 0;
  try {
    localStorage.setItem(key, value);
    unsaved.delete(key);
    return true;
  } catch {
    unsaved.set(key, value);
    return false;
  } finally {
    if (held !== unsaved.size > 0) tellUnsaved();
  }
}

function forgetKey(key: string): void {
  if (unsaved.delete(key) && !unsaved.size) tellUnsaved();
  localStorage.removeItem(key);
}

/**
 * Writes again what this page holds (`unsaved`), once room may have been made: a chat or profile deleted here, or in
 * another page of this origin (its `storage` event), or the person back on the page. What still does not fit stays held.
 */
export function retryUnsaved(): void {
  if (!unsaved.size) return;
  for (const [key, value] of [...unsaved]) {
    try {
      localStorage.setItem(key, value);
      unsaved.delete(key);
    } catch {
      // still no room for it
    }
  }
  if (!unsaved.size) tellUnsaved();
}

/** While this page holds something, room made elsewhere is tried at once (`retryUnsaved`). */
function watchForRoom(on: boolean): void {
  if (typeof window === "undefined") return;
  for (const event of ["storage", "focus"]) {
    if (on) window.addEventListener(event, retryUnsaved);
    else window.removeEventListener(event, retryUnsaved);
  }
}

/**
 * Whether this page holds something localStorage refused: storage is full, and what came since is shown but gone at a
 * reload until the engine brings it back (the storage-full notice, `StorageFullBanner`).
 */
export function holdsUnsaved(): boolean {
  return unsaved.size > 0;
}

const unsavedListeners = new Set<() => void>();
/** Told when `holdsUnsaved` changes. */
export function onUnsavedChange(listener: () => void): () => void {
  unsavedListeners.add(listener);
  return () => void unsavedListeners.delete(listener);
}
function tellUnsaved(): void {
  watchForRoom(unsaved.size > 0);
  // A write may come while a component draws: the notice draws again after it.
  queueMicrotask(() => { for (const listener of unsavedListeners) listener(); });
}

/**
 * False when localStorage did not take the session, even after making room (full, or unavailable): this page holds it
 * (`unsaved`) until a later write fits.
 */
export function saveSession(session: ChatSession): boolean {
  // Whether the session was stored (or needs no write).
  const write = (): boolean => {
    const kept = stored(session);
    // A whole history (not one read without its older messages) is what this page reads back from now on.
    if (!session.older) {
      if (kept !== session) whole.set(session.id, session.messages.slice());
      else whole.delete(session.id);
    }
    let raw: string;
    try {
      raw = JSON.stringify(kept);
      // Unchanged: no write, so another page of this app (the extension's) is not told to read it again. One only this
      // page holds is tried again.
      if (!unsaved.has(getKey(session.id)) && localStorage.getItem(getKey(session.id)) === raw) return true;
    } catch {
      // storage unavailable
      return true;
    }
    return writeKey(getKey(session.id), raw);
  };
  if (write()) return true;
  makeRoom(session.id, write);
  return !unsaved.has(getKey(session.id));
}

let makingRoom = false;

/**
 * Room for a chat's session that localStorage refused (full: each chat keeps its last messages there, and nothing bounds
 * how many chats): the other chats' stored copies keep only their last `ROOM_MESSAGES` of those the engine keeps, the
 * chat least recently active first, until the write fits; then, if it still does not, the chat's own. Rows only the page
 * keeps (a call's line) never go. What still does not fit stays in this page (`unsaved`).
 */
function makeRoom(chatId: string, write: () => boolean): void {
  // No chat left that could give room: nothing to read.
  if (makingRoom || [...inEngine.keys()].every((id) => gaveRoom.has(id))) return;
  makingRoom = true;
  try {
    const givers = listSessions()
      .filter((s) => s.id !== chatId && inEngine.has(s.id) && !gaveRoom.has(s.id))
      .sort((a, b) => (a.lastSyncAt ?? a.createdAt) - (b.lastSyncAt ?? b.createdAt) || a.createdAt - b.createdAt);
    for (const giver of givers) {
      gaveRoom.add(giver.id);
      saveSession(giver);
      if (write()) return;
    }
    if (inEngine.has(chatId) && !gaveRoom.has(chatId)) {
      gaveRoom.add(chatId);
      write();
    }
  } finally {
    makingRoom = false;
  }
}

/** A session as stored, unparsed: to tell cheaply whether it changed. */
export function storedSession(sessionId: string): string | null {
  try {
    return readKey(getKey(sessionId));
  } catch {
    return null;
  }
}

/** The session as stored, its older messages left out (see `STORED_MESSAGES`). */
function loadStored(sessionId: string): ChatSession | null {
  try {
    const raw = readKey(getKey(sessionId));
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
  /**
   * The session as it is stored now, read already (the mirror's, `platform/sync.ts`): not read again, which in a chat of
   * thousands is a parse and a merge of all of them. Its list is not changed in place.
   */
  held?: ChatSession,
): ChatSession | null {
  const session = held ? { ...held, messages: held.messages.slice() } : loadSession(sessionId);
  if (!session) return null;
  if (complete) delete session.older;

  const known = new Set(session.deletedIds);
  for (const m of session.messages) known.add(m.id);
  const fresh = messages.filter((m) => !known.has(m.id) && known.add(m.id));
  if (!fresh.length) return session;

  // A history made whole again (after a reload) brings back older messages, not new ones: the chat keeps its place and
  // time in the list unless one of them is newer than what it had.
  const newest = session.messages[session.messages.length - 1]?.timestamp ?? 0;
  // The common arrival: each one at or after the last, in order. Put after the others, they are where a (stable) sort
  // would put them, and none sorts in among the read ones: no pass over the whole history for either.
  const appended = fresh.every((m, i) => m.timestamp >= (i ? fresh[i - 1]!.timestamp : newest));
  session.messages.push(...fresh);
  if (!appended) session.messages.sort((a, b) => a.timestamp - b.timestamp);
  if (!complete || fresh.some((m) => m.timestamp > newest)) session.lastSyncAt = Date.now();
  // Unread is "messages since the last read one". A contact's message written before one already read here (it was
  // held up on its way: a resend once the chat is back, the DHT) sorts in among the read ones, and would never be
  // counted: the count starts again from it. Not for a history made whole again after a reload: that was read. Nor for
  // one after every message the session had: read here before, when the page could not store it (`unsaved`).
  if (!complete && !appended) {
    const older = session.older ?? 0;
    const read = getLastReadCount(sessionId) - older;
    const added = new Set(fresh);
    let had = session.messages.length - 1;
    while (had >= 0 && added.has(session.messages[had]!)) had--;
    const late = session.messages.findIndex((m, i) => i < read && i < had && added.has(m) && countsAsUnread(m));
    if (late >= 0) setReadCount(sessionId, older + late);
  }

  for (const message of fresh) {
    if ((message.sender === "peer" || message.sender === "system") && message.id.startsWith("peer_")) {
      const joinMatch = message.nick ? null : message.text.match(/^👋 (.+) joined$/);
      const nick = peerDisplayName(message.nick ?? joinMatch?.[1]);
      if (nick && session.nickSource !== "profile") session.nick = nick;
    }
  }

  dropOldCallLines(session);
  saveSession(session);
  return session;
}

/**
 * Takes out of a session the call lines older than its last `CALL_LINES`, and their places in the unread count as
 * `deleteMessage` does. All of them are in its list: the stored copy never leaves one out.
 */
function dropOldCallLines(session: ChatSession): void {
  let drop = -CALL_LINES;
  for (const m of session.messages) if (m.callEvent) drop++;
  if (drop <= 0) return;
  const older = session.older ?? 0;
  const lastRead = getLastReadCount(session.id);
  let read = lastRead;
  session.messages = session.messages.filter((m, i) => {
    if (!m.callEvent || drop <= 0) return true;
    drop--;
    if (older + i < lastRead) read--;
    return false;
  });
  if (read !== lastRead) setReadCount(session.id, read);
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
  gaveRoom.delete(sessionId);
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
      forgetKey(key);
    } catch {
      // ignore
    }
  }
  const order = storedPinOrder();
  if (order.includes(sessionId)) writePinOrder(order.filter(id => id !== sessionId));
  // The room it made may fit what this page held.
  retryUnsaved();
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

/*
 * The order of the pinned chats, as the person put them: one list of ids per profile, the first at the top of the chat
 * list. An id is a chat's (a group's would be `group:<id>`, as the mute store names it), so the same list can hold
 * every chat the day the whole list is ordered by hand. The pin itself stays the `pin_<id>` flag; the list only says
 * where a pinned chat goes. A pinned chat the list does not name (pinned before the list existed, or restored from an
 * older backup) comes after the named ones, the latest first, as all pinned chats were ordered before.
 */
const pinOrderKey = () => `${getPrefix()}pin_order`;

function storedPinOrder(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(pinOrderKey()) ?? "[]");
    return Array.isArray(stored) ? [...new Set(stored.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
}

function writePinOrder(order: readonly string[]): void {
  try {
    if (order.length) localStorage.setItem(pinOrderKey(), JSON.stringify(order));
    else localStorage.removeItem(pinOrderKey());
  } catch { /* storage unavailable: the pins fall back to the latest first */ }
}

/**
 * The pinned ids in the order they are shown: those the stored order names, as it names them, then the rest as
 * `pinned` gives them. Ids the stored order names that are not pinned (any more) are left out.
 */
export function orderPinned(stored: readonly string[], pinned: readonly string[]): string[] {
  const set = new Set(pinned);
  const listed = [...new Set(stored)].filter(id => set.has(id));
  const known = new Set(listed);
  return [...listed, ...pinned.filter(id => !known.has(id))];
}

/** `order` with `id` moved to `index` (past either end is that end); the same array when nothing moves. */
export function moveInOrder(order: readonly string[], id: string, index: number): readonly string[] {
  const from = order.indexOf(id);
  const to = Math.max(0, Math.min(order.length - 1, Math.trunc(index)));
  if (from < 0 || from === to) return order;
  const next = order.filter(other => other !== id);
  next.splice(to, 0, id);
  return next;
}

/** This profile's pinned chats, top first. Only a pinned chat the stored order does not name is read (for its time). */
export function pinnedOrder(): string[] {
  const start = `${getPrefix()}pin_`;
  const pinned: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(start) || key === pinOrderKey() || !ownsKey(key) || localStorage.getItem(key) !== "1") continue;
    const id = key.slice(start.length);
    if (localStorage.getItem(getKey(id)) !== null) pinned.push(id);
  }
  const stored = storedPinOrder();
  const named = new Set(stored);
  const time = (id: string) => { const session = loadSession(id); return session ? session.lastSyncAt ?? session.createdAt : 0; };
  const unlisted = pinned.filter(id => !named.has(id)).map(id => ({ id, at: time(id) })).sort((a, b) => b.at - a.at).map(p => p.id);
  return orderPinned(stored, [...pinned.filter(id => named.has(id)), ...unlisted]);
}

/** A place among the pinned chats: `index` from 0, the top. */
export interface PinnedPlace { index: number; count: number }

/** A pinned chat's place among the pinned ones, or undefined for a chat that is not pinned. */
export function pinnedPlace(sessionId: string): PinnedPlace | undefined {
  const order = pinnedOrder();
  const index = order.indexOf(sessionId);
  return index < 0 ? undefined : { index, count: order.length };
}

/** Pins a chat, at the top of the pinned ones, or unpins it. */
export function setSessionPinned(sessionId: string, pinned: boolean): void {
  if (!loadSession(sessionId)) return;
  const order = pinnedOrder().filter(id => id !== sessionId);
  const key = `${getPrefix()}pin_${sessionId}`;
  if (pinned) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
  writePinOrder(pinned ? [sessionId, ...order] : order);
  window.dispatchEvent(new Event("session-updated"));
}

/**
 * Moves a pinned chat to `index` among the pinned ones (0 is the top; past either end is that end). Its new place, or
 * undefined when it is not pinned or already there.
 */
export function movePinnedTo(sessionId: string, index: number): PinnedPlace | undefined {
  const order = pinnedOrder();
  const next = moveInOrder(order, sessionId, index);
  if (next === order) return undefined;
  writePinOrder(next);
  window.dispatchEvent(new Event("session-updated"));
  return { index: next.indexOf(sessionId), count: next.length };
}

/** Moves a pinned chat one place up or down; undefined at that end, or when it is not pinned. */
export function movePinned(sessionId: string, direction: "up" | "down"): PinnedPlace | undefined {
  const at = pinnedOrder().indexOf(sessionId);
  return at < 0 ? undefined : movePinnedTo(sessionId, at + (direction === "up" ? -1 : 1));
}

/**
 * Sessions already parsed, by key, with the text each was parsed from (`listSessions`). Whoever keeps one owns its
 * sessions: one changed in place must be saved, or dropped from the cache.
 */
export type SessionCache = Map<string, { raw: string; session: ChatSession; whole?: { list: ChatMessage[]; session: ChatSession } }>;

/** The keys chats are stored under, with those only this page holds (a chat made while localStorage was full). */
function sessionKeys(): string[] {
  const keys = new Set<string | null>([...unsaved.keys()]);
  for (let i = 0; i < localStorage.length; i++) keys.add(localStorage.key(i));
  return [...keys].filter(isSessionKey);
}

/**
 * The sessions as this page last read them for the chat list, the app's badge, the session sync and the open chat: each
 * reads them on every `session-updated` (and every few seconds), and a chat whose stored text changed (a message came)
 * is parsed, and merged with the messages its stored copy leaves out, once for all of them. None changes one in place.
 */
const shownCache: SessionCache = new Map();

/** Every chat, as `listSessions` reads them, through the page's one cache (`shownCache`). Not to be changed in place. */
export function listShownSessions(): ChatSession[] {
  return listSessions(shownCache);
}

/** A chat's session through the page's one cache: as stored (`parsed`), and with its older messages (`session`). */
function readShown(sessionId: string): { parsed: ChatSession; session: ChatSession } | null {
  const key = getKey(sessionId);
  try {
    const raw = readKey(key);
    return raw ? readThrough(key, raw, shownCache) : null;
  } catch {
    return null;
  }
}

/** A chat's session as `loadSession` reads it, through the page's one cache (`shownCache`). Not to be changed in place. */
export function loadShownSession(sessionId: string): ChatSession | null {
  return readShown(sessionId)?.session ?? null;
}

/** Reads a chat again from what is stored next time it is asked for (one this page just wrote, or meant to). */
export function forgetShownSession(sessionId: string): void {
  shownCache.delete(getKey(sessionId));
}

/**
 * A session stored as `raw`, parsed (as stored, `older` and all) and with its older messages (`withWhole`). With a cache,
 * parsed only when its stored text changed, and the same object while neither it nor its whole history did.
 */
function readThrough(key: string, raw: string, cache?: SessionCache): { parsed: ChatSession; session: ChatSession } {
  const hit = cache?.get(key);
  const parsed = hit?.raw === raw ? hit.session : JSON.parse(raw) as ChatSession;
  // With its older messages, the same object while neither it nor its whole history changed (the sync's reconcile
  // tells an unchanged list by its sessions' identity).
  const list = parsed.older ? whole.get(parsed.id) : undefined;
  const known = hit?.session === parsed && list && hit.whole?.list === list ? hit.whole : undefined;
  const session = !list ? parsed : known?.session ?? withWhole(parsed, list);
  if (cache && (hit?.session !== parsed || hit.whole?.session !== (list ? session : undefined))) cache.set(key, { raw, session: parsed, ...(list && { whole: { list, session } }) });
  return { parsed, session };
}

/** Every chat, pinned first, then the latest first. With a cache, only a session whose stored text changed is parsed. */
export function listSessions(cache?: SessionCache): ChatSession[] {
  const sessions: ChatSession[] = [];
  const seen = new Set<string>();
  for (const key of sessionKeys()) {
    try {
      const raw = readKey(key);
      if (!raw) continue;
      const { session } = readThrough(key, raw, cache);
      seen.add(key);
      if (session.id && session.mySeedB64 && session.peerPubKeyB64 && session.encKeyB64) {
        sessions.push(session);
      }
    } catch {
      continue;
    }
  }
  if (cache) for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  // A pinned chat's rank is its place in the stored order; one the order does not name comes after those, by its time.
  const place = new Map(storedPinOrder().map((id, index) => [id, index]));
  const rank = new Map(sessions.map(s => [s.id, isSessionPinned(s.id) ? place.get(s.id) ?? Infinity : undefined]));
  sessions.sort((a, b) => {
    const aRank = rank.get(a.id), bRank = rank.get(b.id);
    if ((aRank === undefined) !== (bRank === undefined)) return aRank === undefined ? 1 : -1;
    if (aRank !== undefined && bRank !== undefined && aRank !== bRank) return aRank - bRank;
    const aTime = a.lastSyncAt ?? a.createdAt;
    const bTime = b.lastSyncAt ?? b.createdAt;
    return bTime - aTime;
  });
  return sessions;
}

/** A chat's key, its id, its contact's key and my seed in it. None changes while the chat is stored under that key. */
type ChatKeys = { key: string; id: string; peer: string; seed: string };
/** Per chat's key, read once. */
const contacts = new Map<string, ChatKeys>();

/**
 * Every chat's keys, as `listSessions()` counts chats, without reading any chat's messages: each chat's stored copy is
 * parsed once, the first time it is looked through, and a long chat's whole history is never merged in.
 */
function chatKeys(): ChatKeys[] {
  const all: ChatKeys[] = [];
  const seen = new Set<string>();
  for (const key of sessionKeys()) {
    seen.add(key);
    let contact = contacts.get(key);
    if (!contact) {
      try {
        const session = JSON.parse(readKey(key) ?? "null") as ChatSession | null;
        // As `listSessions` counts a chat.
        if (!session?.id || !session.mySeedB64 || !session.peerPubKeyB64 || !session.encKeyB64) continue;
        contacts.set(key, contact = { key, id: session.id, peer: session.peerPubKeyB64, seed: session.mySeedB64 });
      } catch {
        continue;
      }
    }
    all.push(contact);
  }
  for (const key of contacts.keys()) if (!seen.has(key)) contacts.delete(key);
  return all;
}

/** Of the chats that match, the one the list shows first (`listSessions` is read only when there are two). */
function firstOf(matches: ChatKeys[]): ChatKeys | undefined {
  if (matches.length < 2) return matches[0];
  const ids = new Set(matches.map((m) => m.id));
  const id = listSessions().find((s) => ids.has(s.id))?.id;
  return matches.find((m) => m.id === id);
}

/** The chat with this contact, as `listSessions()` would find it first. An attention event, a call offer, finds its chat this way. */
export function sessionIdForPeer(peerPubKeyB64: string): string | undefined {
  return firstOf(chatKeys().filter((c) => c.peer === peerPubKeyB64))?.id;
}

/**
 * Each chat's id, my seed in it and its contact's key, in no order, read as `sessionIdForPeer` reads them: what an
 * invite's ownership check needs, with no chat's messages.
 */
export function knownChatKeys(): { id: string; seedB64: string; peerPubKeyZ32: string }[] {
  return chatKeys().map((c) => ({ id: c.id, seedB64: c.seed, peerPubKeyZ32: c.peer }));
}

/** Per chat's key: its names, with the stored text they were read from. */
const names = new Map<string, { raw: string; label?: string; nick?: string }>();

/**
 * The names of the chat with this contact (the chat's label, the contact's nickname), from the chat `sessionIdForPeer`
 * finds; that chat's stored copy is parsed again only when it changed. Undefined with no chat.
 */
export function chatNamesForPeer(peerPubKeyB64: string): { label?: string; nick?: string } | undefined {
  const chat = firstOf(chatKeys().filter((c) => c.peer === peerPubKeyB64));
  const raw = chat && readKey(chat.key);
  if (!chat || !raw) return undefined;
  let known = names.get(chat.key);
  if (known?.raw !== raw) {
    try {
      const session = JSON.parse(raw) as ChatSession;
      names.set(chat.key, known = { raw, label: session.label, nick: session.nick });
    } catch {
      return undefined;
    }
  }
  for (const key of names.keys()) if (!contacts.has(key)) names.delete(key);
  return { label: known.label, nick: known.nick };
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
    const val = readKey(`${getPrefix()}read_${sessionId}`);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

function setReadCount(sessionId: string, count: number): void {
  try {
    writeKey(`${getPrefix()}read_${sessionId}`, String(count));
  } catch {
    // storage unavailable
  }
}

export function markSessionAsRead(sessionId: string): void {
  // As stored: how many there are, without putting the older ones back together. Parsed once for every reader of the
  // page's cache (the chat list and the open chat mark it on each message that comes).
  const session = readShown(sessionId)?.parsed;
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

/** The most calls one line says it stands for: a stored count past it (a damaged or hand-edited copy) reads as this. */
export const MAX_CALL_LINE_COUNT = 9_999;

/**
 * How many calls a call's line stands for (`callEvent.count`): one for a line without a count, as every line written
 * before it was, and for a count that is not a whole number of at least two. Never more than `MAX_CALL_LINE_COUNT`.
 */
export function callLineCount(event: { count?: unknown } | undefined): number {
  const count = event?.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 2) return 1;
  return Math.min(count, MAX_CALL_LINE_COUNT);
}

/** What a message adds to the unread count: a line of several missed calls, each of them (`callLineCount`). */
function unreadAfter(messages: readonly ChatMessage[], read: number): number {
  let unread = 0;
  for (let i = Math.max(0, read); i < messages.length; i++) {
    const message = messages[i]!;
    if (countsAsUnread(message)) unread += message.callEvent ? callLineCount(message.callEvent) : 1;
  }
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

/** False when the code could not be stored (storage full or unavailable). */
export function saveInviteCode(sessionId: string, code: string): boolean {
  try {
    localStorage.setItem(`${getPrefix()}invite_${sessionId}`, code);
    return true;
  } catch {
    // storage full or unavailable
    return false;
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

/** What `ensureSession` throws when a new chat could not be stored: the storage is full (errorText.ts says it). */
export const NO_ROOM_FOR_CHAT = "There is no room left on this device for a new chat";

/**
 * The id of the session for these keys, stored first if it is new. Chats are
 * routed by this id so the keys never reach the address bar or the history.
 * A new one that could not be stored (or its invite, which the chat shows) throws
 * `NO_ROOM_FOR_CHAT`: its id would open no chat.
 */
export function ensureSession(
  keys: SessionKeys,
  options: { inviteCode?: string; createdAt?: number; viaLink?: boolean } = {},
): string {
  const existing = findSession(keys.seedB64, keys.peerPubKeyB64);
  if (existing && existing.profile !== keys.profile) throw new Error("Invitation profile does not match this stored conversation");
  const id = existing?.id ?? newSessionId();
  if (!existing) {
    const saved = saveSession({
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
      ...(options.viaLink ? { viaLink: true as const } : {}),
    });
    // Held only in this page, it would be gone at a reload, its link with it: not made at all.
    if (!saved) { forgetKey(getKey(id)); throw new Error(NO_ROOM_FOR_CHAT); }
  }
  if (options.inviteCode && !saveInviteCode(id, options.inviteCode) && !existing) {
    forgetKey(getKey(id));
    throw new Error(NO_ROOM_FOR_CHAT);
  }
  return id;
}

/**
 * How many chats made by an invite link may wait for an answer at once. Opening a link takes nothing from the person
 * (a page can send the browser to one), and each chat it makes is a row to delete and a link the engine runs: past
 * this, a link makes no chat until one of them is answered or deleted. Join's paste and scan are the person's own act
 * and are not counted.
 */
export const LINK_CHATS_WAITING = 3;

/** The chats an invite link made that nothing came back from yet: no message, no name, no sync. */
export function linkChatsWaiting(): number {
  return listSessions().filter((s) => s.viaLink && !s.messages.length && !s.older && !s.lastSyncAt && !s.nick).length;
}
