import {
  addMessage,
  generateSessionId,
  listSessions,
  loadSession,
  saveInviteCode,
  saveSession,
  updateSessionLabel,
} from "../../../src/lib/storage";
import type { ChatMessage, ChatSession } from "../../../src/lib/types";
import type { StoredMessage } from "../shared/types";
import { engine } from "./engine";

/**
 * The Desktop UI keeps its sessions in localStorage and that stays the list
 * the user sees and edits. The peer keeps the links it runs in IndexedDB. This
 * module keeps the two in step: sessions the UI knows are run by the peer,
 * links the UI forgot are dropped, and what the peer receives lands in the
 * session the way `useChat` stores it on Desktop.
 */
const MIGRATED_KEY = "ghostly_browser_sessions_imported";
const FORGET_AFTER_MS = 15_000;
const JOIN_PATTERN = /^👋 (?:.+ )?joined$/;

export function notifySessionsChanged(): void {
  window.dispatchEvent(new Event("session-updated"));
}

export function sessionForPeer(peerPubKeyZ32: string): ChatSession | undefined {
  return listSessions().find((s) => s.peerPubKeyB64 === peerPubKeyZ32);
}

export function toChatMessage(message: StoredMessage, peerPubKeyZ32: string): ChatMessage {
  const isJoin = JOIN_PATTERN.test(message.text);
  return {
    id: message.id,
    text: message.text,
    sender: isJoin ? "system" : message.sender,
    timestamp: message.timestamp,
    nick: message.nick,
    file: message.file,
    paymentId: message.paymentId,
    meta: {
      dhtKey: peerPubKeyZ32,
      encryptedPayloadLength: 0,
      dnsRecords: message.via === "datalink" ? ["webrtc"] : ["_msgs", "_ts", "_ack"],
      packetTimestamp: message.timestamp,
    },
    ...(isJoin && { systemEvent: { type: "join" as const, pubKey: peerPubKeyZ32 } }),
  };
}

function mirrorMessages(linkId: string, messages: StoredMessage[]): void {
  const link = engine.state?.links.find((l) => l.id === linkId);
  const session = link && sessionForPeer(link.peerPubKeyZ32);
  if (!link || !session) return;

  let changed = false;
  const known = new Set(session.messages.map((m) => m.id));
  for (const message of messages) {
    // What I sent is stored by the UI when I send it, like on Desktop.
    if (message.sender !== "peer" || known.has(message.id)) continue;
    addMessage(session.id, toChatMessage(message, link.peerPubKeyZ32));
    changed = true;
  }
  if (changed) notifySessionsChanged();
}

const ensuring = new Set<string>();

async function reconcile(): Promise<void> {
  const state = engine.state;
  if (!state) return;

  if (!localStorage.getItem(MIGRATED_KEY)) {
    // Links made before the UI kept sessions (or by another Ghostly page).
    for (const link of await engine.call("exportLinks")) {
      const id = generateSessionId(link.seedB64, link.peerPubKeyZ32);
      if (loadSession(id)) continue;
      saveSession({
        id,
        mySeedB64: link.seedB64,
        peerPubKeyB64: link.peerPubKeyZ32,
        encKeyB64: link.encKeyB64,
        messages: [],
        createdAt: link.createdAt,
      });
      if (link.inviteCode) saveInviteCode(id, link.inviteCode);
      if (link.label) updateSessionLabel(id, link.label);
    }
    localStorage.setItem(MIGRATED_KEY, "1");
    notifySessionsChanged();
  }

  const sessions = listSessions();
  const peers = new Set(sessions.map((s) => s.peerPubKeyB64));

  for (const session of sessions) {
    if (engine.linkByPeer(session.peerPubKeyB64) || ensuring.has(session.id)) continue;
    ensuring.add(session.id);
    engine
      .call("ensureLink", {
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
  engine.onMessages(mirrorMessages);
  engine.subscribe(() => {
    void reconcile();
    for (const [linkId, messages] of engine.messages) mirrorMessages(linkId, messages);
  });
  // Deleting a chat only touches localStorage; notice it without waiting for the peer to speak.
  window.addEventListener("session-updated", () => void reconcile());
  setInterval(() => void reconcile(), 5_000);
}
