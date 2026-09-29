import {
  addMessages,
  saveSession,
  ensureSession,
  findSession,
  forgetInviteCode,
  getInviteCode,
  getPrefix,
  isSessionKey,
  listSessions,
  loadSession,
  peerDisplayName,
  sessionLinkParams,
  setSessionPeerNick,
  storedSession,
  updateSessionLabel,
  wasDeleted,
  type SessionCache,
} from "../../../../src/lib/storage";
import type { ChatMessage, ChatSession } from "../../../../src/lib/types";
import type { EngineState, LinkView, StoredMessage } from "../shared/types";
import { engine } from "./engine";
import { replyRef } from "../shared/replies";

/**
 * The Desktop UI keeps its sessions in localStorage and that stays the list
 * the user sees and edits. The peer keeps the links it runs in IndexedDB. This
 * module keeps the two in step: sessions the UI knows are run by the peer,
 * links the UI forgot are dropped, and what the peer receives lands in the
 * session the way `useChat` stores it on Desktop.
 */
// Outside the `ghostly` prefix on purpose: "Clear all data" removes every key
// under it, and without this marker the links the user just let go would be
// imported again as chats. The old name still counts as imported.
const MIGRATED_KEY = "gb-sessions-imported";
const OLD_MIGRATED_KEY = "ghostly_browser_sessions_imported";
const FORGET_AFTER_MS = 15_000;
const JOIN_PATTERN = /^👋 (?:.+ )?joined$/;

export function notifySessionsChanged(): void {
  window.dispatchEvent(new Event("session-updated"));
}

/**
 * The sessions as this module last read them. Each engine update, `session-updated` and the 5 s tick reads them all:
 * a long chat's session is parsed again only when what is stored for it changed. One changed in place here is saved,
 * then forgotten (read again), so a write that failed does not linger as if it had been made.
 */
const cache: SessionCache = new Map();

function forget(sessionId: string): void {
  cache.delete(`${getPrefix()}${sessionId}`);
}

export function sessionForPeer(peerPubKeyZ32: string): ChatSession | undefined {
  return listSessions(cache).find((s) => s.peerPubKeyB64 === peerPubKeyZ32);
}

export function toChatMessage(message: StoredMessage, peerPubKeyZ32: string, myPubKeyZ32: string, modern = false): ChatMessage {
  const isJoin = JOIN_PATTERN.test(message.text);
  return {
    id: message.id,
    delivery: message.delivery,
    deliveryError: message.deliveryError,
    text: message.text,
    sender: isJoin ? "system" : message.sender,
    timestamp: message.timestamp,
    nick: message.nick,
    file: message.file,
    paymentId: message.paymentId,
    ...(message.preview && { preview: message.preview }),
    ...(modern && replyRef(message) && { ref: replyRef(message) }),
    ...(message.replyTo && { replyTo: message.replyTo }),
    ...(message.reactions && { reactions: message.reactions }),
    ...(message.edit && { edit: message.edit }),
    ...(message.forwarded && { forwarded: message.forwarded }),
    meta: modern ? undefined : {
      dhtKey: peerPubKeyZ32,
      encryptedPayloadLength: 0,
      dnsRecords: message.via === "datalink" ? ["webrtc"] : ["_msgs", "_ts", "_ack"],
      packetTimestamp: message.timestamp,
    },
    ...(isJoin && { systemEvent: { type: "join" as const, pubKey: message.sender === "me" ? myPubKeyZ32 : peerPubKeyZ32 } }),
  };
}

/** What each link's messages were last mirrored from: the list, and its session as stored after. */
const mirrored = new Map<string, { messages: StoredMessage[]; sessionId: string; stored: string | null }>();

/** Whether this list was mirrored into this session already, and nothing has written the session since. */
function mirroredAlready(linkId: string, messages: StoredMessage[]): boolean {
  const last = mirrored.get(linkId);
  return last?.messages === messages && storedSession(last.sessionId) === last.stored;
}

function mirrorMessages(linkId: string, messages: StoredMessage[]): void {
  const link = engine.state?.links.find((l) => l.id === linkId);
  const session = link && sessionForPeer(link.peerPubKeyZ32);
  if (!link || !session) return;

  // Every state change mirrors every chat: a long one must cost a pass over its messages, not a search per message,
  // and the session is written once at most, whatever changed.
  const byId = new Map(session.messages.map((m) => [m.id, m]));
  const added: ChatMessage[] = [];
  let dirty = false;
  for (const message of messages) {
    const previous = byId.get(message.id);
    // Reactions change rows of any kind, mine included (WISP 400 § Reactions).
    const reacted = !!previous && (!!previous.reactions || !!message.reactions) && JSON.stringify(previous.reactions ?? null) !== JSON.stringify(message.reactions ?? null);
    if (reacted) previous.reactions = message.reactions;
    // Reviewed payments originate in the engine (including recovery), without
    // the chat composer's optimistic message or text-delivery status; so do forwarded files (WISP 400 § Forwards).
    if (message.sender !== "peer" && !message.delivery && !message.paymentId && !message.forwarded) {
      if (reacted) dirty = true;
      continue;
    }
    const mapped = () => toChatMessage(message, link.peerPubKeyZ32, link.myPubKeyZ32, !!link.profile);
    if (previous) {
      let updated = reacted;
      if (message.delivery && (previous.delivery !== message.delivery || previous.deliveryError !== message.deliveryError)) {
        previous.delivery = message.delivery;
        previous.deliveryError = message.deliveryError;
        updated = true;
      }
      // An edit (WISP 400 § Edits): the new text in place, never a new message, so nothing counts as unread.
      if (message.edit && (previous.edit?.seq !== message.edit.seq || !!previous.edit?.pending !== !!message.edit.pending)) {
        previous.text = message.text;
        previous.edit = message.edit;
        if (message.preview) previous.preview = message.preview; else delete previous.preview;
        updated = true;
      }
      // Only a join announcement has one; the others are not mapped again.
      const systemEvent = JOIN_PATTERN.test(message.text) ? mapped().systemEvent : undefined;
      if (systemEvent && previous.systemEvent?.pubKey !== systemEvent.pubKey) {
        previous.systemEvent = systemEvent;
        updated = true;
      }
      if (updated) dirty = true;
      continue;
    }
    added.push(mapped());
  }
  let changed = dirty;
  if (dirty) saveSession(session);
  if (added.length) {
    const before = session.messages.length;
    const updated = addMessages(session.id, added);
    if (updated) session.messages = updated.messages;
    if (session.messages.length !== before) changed = true;
  }
  if (mirrorPeerNick(session, link)) changed = true;
  if (mirrorIdentityShare(session, link)) changed = true;
  if (mirrorReaction(session, link)) changed = true;
  if (dirty || added.length || changed) forget(session.id);
  mirrored.set(linkId, { messages, sessionId: session.id, stored: storedSession(session.id) });
  if (changed) notifySessionsChanged();
}

/**
 * The chat's latest reaction, for the chat list: its note, and its place, as a message would move it. Not a message,
 * so the unread count stays.
 */
function mirrorReaction(session: ChatSession, link: LinkView): boolean {
  const note = link.lastReaction;
  const shown = session.lastReaction;
  // A newer reaction, or the same one whose message was edited since (its line quotes the text).
  if (!note || note.at < (shown?.at ?? 0) || (note.at === shown?.at && note.snippet === shown.snippet)) return false;
  const fresh = loadSession(session.id);
  if (!fresh) return false;
  fresh.lastReaction = note;
  fresh.lastSyncAt = Math.max(fresh.lastSyncAt ?? 0, note.at);
  saveSession(fresh);
  session.lastReaction = note;
  forget(session.id);
  return true;
}

/**
 * The contact's latest identity share, for the chat list: its preview ("Shared an identity") and its place, as a
 * message would move it. Not a message, so the unread count stays (it counts messages).
 */
function mirrorIdentityShare(session: ChatSession, link: LinkView): boolean {
  const at = link.identitySharedAt;
  if (!at || at <= (session.identitySharedAt ?? 0)) return false;
  const fresh = loadSession(session.id);
  if (!fresh) return false;
  fresh.identitySharedAt = at;
  fresh.lastSyncAt = Math.max(fresh.lastSyncAt ?? 0, at);
  saveSession(fresh);
  session.identitySharedAt = at;
  forget(session.id);
  return true;
}

/**
 * The name the contact told the peer (on a paired session, or in a legacy chat's record) is the one the chat
 * list and header show, unless the chat was renamed here.
 */
function mirrorPeerNick(session: ChatSession, link: LinkView): boolean {
  if (link.peerNick === undefined) return false;
  // Already that name: the session is not read again to find out.
  if (session.nickSource === "profile" && session.nick === peerDisplayName(link.peerNick)) return false;
  return setSessionPeerNick(session.id, link.peerNick);
}

const ensuring = new Set<string>();
/**
 * The last reconcile that left nothing for later: every chat had its link and every link its chat. With the same
 * engine state and the same sessions (none stored differently since), the next one has nothing to do either.
 */
let settled: { state: EngineState; sessions: ChatSession[] } | undefined;

async function reconcile(): Promise<void> {
  const state = engine.state;
  if (!state) return;

  if (!localStorage.getItem(MIGRATED_KEY) && localStorage.getItem(OLD_MIGRATED_KEY)) localStorage.setItem(MIGRATED_KEY, "1");
  if (!localStorage.getItem(MIGRATED_KEY)) {
    // Links made before the UI kept sessions (or by another Ghostly page).
    for (const link of await engine.call("exportLinks")) {
      if (findSession(link.seedB64, link.peerPubKeyZ32)) continue;
      const id = ensureSession(
        { profile: link.profile, deliveryMode: link.deliveryMode, seedB64: link.seedB64, peerPubKeyB64: link.peerPubKeyZ32, encKeyB64: link.encKeyB64 },
        { inviteCode: link.inviteCode, createdAt: link.createdAt },
      );
      if (link.label) updateSessionLabel(id, link.label);
    }
    localStorage.setItem(MIGRATED_KEY, "1");
    notifySessionsChanged();
  }

  const sessions = listSessions(cache);
  const last = settled;
  if (last?.state === state && last.sessions.length === sessions.length && sessions.every((s) => last.sessions.includes(s))) return;
  settled = undefined;
  const peers = new Set(sessions.map((s) => s.peerPubKeyB64));
  let renamed = false;
  let later = false;

  for (const session of sessions) {
    const live = engine.linkByPeer(session.peerPubKeyB64);
    if (live && session.deliveryMode !== live.deliveryMode) { session.deliveryMode = live.deliveryMode; saveSession(session); forget(session.id); }
    if (live && mirrorPeerNick(session, live)) renamed = true;
    if (live && mirrorIdentityShare(session, live)) renamed = true;
    if (live && mirrorReaction(session, live)) renamed = true;
    if (session.profile && live?.pairing?.peerKey && ["ready", "waiting"].includes(live.pairing.status)) forgetInviteCode(session.id);
    if (live) continue;
    later = true;
    if (ensuring.has(session.id)) continue;
    ensuring.add(session.id);
    engine
      .call("ensureLink", {
        ...sessionLinkParams(session),
        // The side that made the invite still holds it; the engine learns who invited whom from that.
        inviteCode: getInviteCode(session.id) ?? undefined,
      })
      .catch(() => {})
      .finally(() => ensuring.delete(session.id));
  }
  if (renamed) notifySessionsChanged();

  for (const link of state.links) {
    if (peers.has(link.peerPubKeyZ32)) continue;
    later = true;
    // A link only just made may not have its chat yet; one whose chat was deleted here goes at once.
    if (Date.now() - link.createdAt < FORGET_AFTER_MS && !wasDeleted(link.peerPubKeyZ32)) continue;
    void engine.call("removeLink", { linkId: link.id }).catch(() => {});
  }
  if (!later && !renamed) settled = { state, sessions };
}

let started = false;

export function startSessionSync(): void {
  if (started) return;
  started = true;
  void engine.connect().catch(() => {});
  engine.onMessages(mirrorMessages);
  engine.subscribe(() => {
    void reconcile();
    // A list mirrored already, into a session nothing wrote since, has nothing new (reconcile mirrors the link's names).
    for (const [linkId, messages] of engine.messages) if (!mirroredAlready(linkId, messages)) mirrorMessages(linkId, messages);
  });
  // Deleting a chat only touches localStorage; notice it without waiting for the peer to speak.
  window.addEventListener("session-updated", () => void reconcile());
  // Another page of this app (a second tab of the extension, whose pages share one peer) wrote a chat: what it
  // mirrored first is already stored, so this page's mirror adds nothing and would never tell its chat to read again.
  // A chat cleared (`key` null: storage cleared) counts too.
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === null || isSessionKey(event.key)) notifySessionsChanged();
  });
  setInterval(() => void reconcile(), 5_000);
}
