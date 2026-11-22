import { useSyncExternalStore } from "react";

/**
 * The chats a call is on or rings in (placed, ringing either way, answered, or waking the contact for one): `App` keeps
 * their pages loaded, wherever the person goes. Such a chat is not deleted under its call. It used to be: the call
 * talked on in a chat gone from the list, its hang-up then had no link left to cross, and the contact's call ended
 * only when its media gave up, half a minute later (as `chat remove` in the CLI, refused there too).
 */
const onCall = new Set<string>();
const listeners = new Set<() => void>();

/** The chat's call is on, or no longer (its page says so as its call changes, and as it goes). */
export function setChatOnCall(sessionId: string, on: boolean): void {
  if (on === onCall.has(sessionId)) return;
  if (on) onCall.add(sessionId);
  else onCall.delete(sessionId);
  for (const listener of [...listeners]) listener();
}

export function chatOnCall(sessionId: string | null | undefined): boolean {
  return !!sessionId && onCall.has(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a call is on or rings in this chat, as it changes. */
export function useChatOnCall(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => chatOnCall(sessionId), () => false);
}

/** Whether a call is on or rings in any chat: Settings' Delete all chats waits for it to end. */
export function anyChatOnCall(): boolean {
  return onCall.size > 0;
}

/** Whether a call is on or rings in any chat, as it changes. */
export function useAnyChatOnCall(): boolean {
  return useSyncExternalStore(subscribe, anyChatOnCall, () => false);
}
