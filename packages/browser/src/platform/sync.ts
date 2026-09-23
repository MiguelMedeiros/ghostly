import {
  addMessage,
  saveSession,
  ensureSession,
  findSession,
  forgetInviteCode,
  listSessions,
  updateSessionLabel,
} from "../../../../src/lib/storage";
import type { ChatMessage, ChatSession } from "../../../../src/lib/types";
import type { StoredMessage } from "../shared/types";
import { engine } from "./engine";

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

export function sessionForPeer(peerPubKeyZ32: string): ChatSession | undefined {
  return listSessions().find((s) => s.peerPubKeyB64 === peerPubKeyZ32);
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
    meta: modern ? undefined : {
      dhtKey: peerPubKeyZ32,
      encryptedPayloadLength: 0,
      dnsRecords: message.via === "datalink" ? ["webrtc"] : ["_msgs", "_ts", "_ack"],
      packetTimestamp: message.timestamp,
    },
    ...(isJoin && { systemEvent: { type: "join" as const, pubKey: message.sender === "me" ? myPubKeyZ32 : peerPubKeyZ32 } }),
  };
}

function mirrorMessages(linkId: string, messages: StoredMessage[]): void {
  const link = engine.state?.links.find((l) => l.id === linkId);
  const session = link && sessionForPeer(link.peerPubKeyZ32);
  if (!link || !session) return;

  let changed = false;
  for (const message of messages) {
    // Reviewed payments originate in the engine (including recovery), without
    // the chat composer's optimistic message or text-delivery status.
    if (message.sender !== "peer" && !message.delivery && !message.paymentId) continue;
    const mapped = toChatMessage(message, link.peerPubKeyZ32, link.myPubKeyZ32, !!link.profile);
    const previous = session.messages.find(m => m.id === message.id);
    if (previous) {
      let updated = false;
      if (message.delivery && (previous.delivery !== message.delivery || previous.deliveryError !== message.deliveryError)) {
        previous.delivery = message.delivery;
        previous.deliveryError = message.deliveryError;
        updated = true;
      }
      if (mapped.systemEvent && previous.systemEvent?.pubKey !== mapped.systemEvent.pubKey) {
        previous.systemEvent = mapped.systemEvent;
        updated = true;
      }
      if (updated) {
        saveSession(session);
        changed = true;
      }
      continue;
    }
    const updated = addMessage(session.id, mapped);
    if (updated) session.messages = updated.messages;
    changed = true;
  }
  if (changed) notifySessionsChanged();
}

const ensuring = new Set<string>();

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

  const sessions = listSessions();
  const peers = new Set(sessions.map((s) => s.peerPubKeyB64));

  for (const session of sessions) {
    const live = engine.linkByPeer(session.peerPubKeyB64);
    if (live && session.deliveryMode !== live.deliveryMode) { session.deliveryMode = live.deliveryMode; saveSession(session); }
    if (session.profile && live?.pairing?.peerKey && ["ready", "waiting"].includes(live.pairing.status)) forgetInviteCode(session.id);
    if (engine.linkByPeer(session.peerPubKeyB64) || ensuring.has(session.id)) continue;
    ensuring.add(session.id);
    engine
      .call("ensureLink", {
        profile: session.profile,
        deliveryMode: session.deliveryMode,
        seedB64: session.mySeedB64,
        peerPubKeyZ32: session.peerPubKeyB64,
        encKeyB64: session.encKeyB64,
      })
      .catch(() => {})
      .finally(() => ensuring.delete(session.id));
  }

  for (const link of state.links) {
    if (peers.has(link.peerPubKeyZ32) || Date.now() - link.createdAt < FORGET_AFTER_MS) continue;
    void engine.call("removeLink", { linkId: link.id }).catch(() => {});
  }
}

let started = false;

export function startSessionSync(): void {
  if (started) return;
  started = true;
  void engine.connect().catch(() => {});
  engine.onMessages(mirrorMessages);
  engine.subscribe(() => {
    void reconcile();
    for (const [linkId, messages] of engine.messages) mirrorMessages(linkId, messages);
  });
  // Deleting a chat only touches localStorage; notice it without waiting for the peer to speak.
  window.addEventListener("session-updated", () => void reconcile());
  setInterval(() => void reconcile(), 5_000);
}
