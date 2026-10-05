/**
 * The calls this app is on, across its chats (WISP 601, "On a call already"). Each chat runs a call of its own
 * (`useWebRTC`), so a second call could ring in another chat while one is on; answering it ends this one first, so
 * there are never two calls at once. A call is on from the moment it is placed or answered (ringing out, answering,
 * connecting, connected) until it ends; a call that only rings here is not on.
 */

/** Each call on, by the chat's own key, with what ends it as its person's hang-up would. */
const calls = new Map<symbol, () => void>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** This chat's call is on (`end` hangs it up), or not (null). */
export function setCallOn(key: symbol, end: (() => void) | null): void {
  if (end) {
    const had = calls.has(key);
    calls.set(key, end);
    if (!had) changed();
  } else if (calls.delete(key)) {
    changed();
  }
}

/** Whether a call other than `key`'s is on. */
export function otherCallOn(key: symbol): boolean {
  for (const other of calls.keys()) if (other !== key) return true;
  return false;
}

/** Ends every call but `key`'s, each as its person's hang-up would: the contact is told, and its chat keeps its end line. */
export function endOtherCalls(key: symbol): number {
  let ended = 0;
  for (const [other, end] of [...calls]) {
    if (other === key) continue;
    calls.delete(other);
    end();
    ended++;
  }
  if (ended) changed();
  return ended;
}

/** Whether any call is on in this app. */
export function anyCallOn(): boolean {
  return calls.size > 0;
}

export function subscribeCalls(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
