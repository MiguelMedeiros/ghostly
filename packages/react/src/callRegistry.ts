/**
 * The calls this app is on, across its chats (WISP 601, "On a call already"). Each chat runs a call of its own
 * (`useWebRTC`), so a second call could ring in another chat while one is on; answering it ends this one first, so
 * there are never two calls at once. A call is on from the moment it is placed or answered (ringing out, answering,
 * connecting, connected) until it ends; a call that only rings here is not on.
 *
 * A call ringing in still holds the device for a handoff (WISP 06 § States and events): moving the profile then would
 * lose it without a word, the caller ringing on to its timeout. So the chats ringing in are kept apart from the calls on,
 * and only `callHoldsDevice` counts them.
 */

/** Each call on, by the chat's own key, with what ends it as its person's hang-up would. */
const calls = new Map<symbol, () => void>();
/** The chats a call rings in, not answered yet. */
const ringing = new Set<symbol>();
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

/** A call rings in this chat (true), or no longer: declined, answered, rung out, the caller gave up, the chat went away. */
export function setRingingIn(key: symbol, on: boolean): void {
  if (on ? ringing.has(key) : !ringing.has(key)) return;
  if (on) ringing.add(key);
  else ringing.delete(key);
  changed();
}

/** Whether a call is on or rings in this app: a handoff waits for it to end. */
export function callHoldsDevice(): boolean {
  return calls.size > 0 || ringing.size > 0;
}

export function subscribeCalls(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
