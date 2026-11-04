import { parseCallSignal } from "@ghostly/core";
import { RING_MS } from "@ghostly/react";
import { engine } from "@ghostly/browser/platform/engine";
import { sessionIdForPeer } from "./storage";

/**
 * The chat a call signal is for, when it is an offer: a call can come in for a chat that is not open, and that chat is
 * loaded, off screen, so it rings (App's loaded chats, and before the first unlock `PreUnlockRing`).
 */
export function offerSession(linkId: string, signal: string): string | undefined {
  if (parseCallSignal(signal)?.t !== "o") return undefined;
  const peer = engine.state?.links.find((link) => link.id === linkId)?.peerPubKeyZ32;
  return peer ? sessionIdForPeer(peer) : undefined;
}

/**
 * A call answered from the lock screen of an app locked since it started (WISP 601 § Locked). The chat that rang
 * before the password goes with the lock; the chat the app opens once unlocked takes the call over and answers it at
 * once, as it came. Kept for one ring at most, and for that offer only (its `ts`), so a handover nobody took never
 * answers a later call.
 */
let handed: { sessionId: string; offer: number; video: boolean; at: number } | null = null;

export function handOverCall(sessionId: string, offer: string | null | undefined, video: boolean): void {
  const ts = offer ? parseCallSignal(offer)?.ts : undefined;
  handed = ts === undefined ? null : { sessionId, offer: ts, video, at: Date.now() };
}

/** Whether to answer the offer ringing in this chat, and with the camera or not: once, and only the one handed over. */
export function takeHandedCall(sessionId: string, offer: string | null | undefined): boolean | undefined {
  if (!handed || handed.sessionId !== sessionId) return undefined;
  const { offer: ts, video, at } = handed;
  handed = null;
  if (!offer || parseCallSignal(offer)?.ts !== ts) return undefined;
  return Date.now() - at <= RING_MS ? video : undefined;
}
