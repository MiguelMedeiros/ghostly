import { useSyncExternalStore } from "react";

/**
 * The chats whose last call found no path to the contact (`useWebRTC`'s `noPath`), until the note is closed or the
 * chat's next call starts. Kept here, not in the chat's page: `App` lets go of a chat that is not on screen once its
 * call ends (one the person left while it rang, for Settings or another chat), and the note went with it. The chat
 * shows it when it is opened again.
 */
const noPath = new Set<string>();
const listeners = new Set<() => void>();

export function setCallNoPath(sessionId: string, on: boolean): void {
  if (on === noPath.has(sessionId)) return;
  if (on) noPath.add(sessionId);
  else noPath.delete(sessionId);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether this chat's last call found no path, and its note is still to show. */
export function useCallNoPath(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => noPath.has(sessionId), () => false);
}
