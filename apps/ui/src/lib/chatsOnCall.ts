import { useSyncExternalStore } from "react";

/**
 * The chats a call is on in (placed, ringing out, answered, or waking the contact for one). Such a chat is not deleted
 * under its call. It used to be: the call talked on in a chat gone from the list, its hang-up then had no link left to
 * cross, and the contact's call ended only when its media gave up, half a minute later (as `chat remove` in the CLI,
 * refused there too).
 *
 * A call that only rings in is not one of them: a contact who calls again and again kept it ringing for as long as
 * they wanted, and the chat could never be deleted. Deleting it declines that call first (`declineRingIn`), while its
 * link is still there for the decline to cross.
 */
const onCall = new Set<string>();
const ringsIn = new Map<string, () => void>();
const listeners = new Set<() => void>();

/** The chat's call is on, or no longer (its page says so as its call changes, and as it goes). */
export function setChatOnCall(sessionId: string, on: boolean): void {
  if (on === onCall.has(sessionId)) return;
  if (on) onCall.add(sessionId);
  else onCall.delete(sessionId);
  for (const listener of [...listeners]) listener();
}

/** A call rings in the chat, and how to decline it; or `null`: it no longer does (answered, declined, gone). */
export function setChatRingsIn(sessionId: string, decline: (() => void) | null): void {
  if (decline) ringsIn.set(sessionId, decline);
  else ringsIn.delete(sessionId);
}

/** Declines the call ringing in the chat, if one does: the chat is about to be deleted. */
export function declineRingIn(sessionId: string): void {
  ringsIn.get(sessionId)?.();
}

/** Declines the calls ringing in every chat: they are all about to be deleted. */
export function declineAllRingsIn(): void {
  for (const decline of [...ringsIn.values()]) decline();
}

export function chatOnCall(sessionId: string | null | undefined): boolean {
  return !!sessionId && onCall.has(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a call is on in this chat, as it changes. */
export function useChatOnCall(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => chatOnCall(sessionId), () => false);
}

/** Whether a call is on in any chat: Settings' Delete all chats waits for it to end. */
export function anyChatOnCall(): boolean {
  return onCall.size > 0;
}

/** Whether a call is on in any chat, as it changes. */
export function useAnyChatOnCall(): boolean {
  return useSyncExternalStore(subscribe, anyChatOnCall, () => false);
}
