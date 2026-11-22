/*
 * One window listener for a store kept in localStorage, shared by every subscriber of it. Another page of the app (another
 * profile's, often) writes its keys many times a second, and the browser calls each `storage` listener on the window for
 * every write: a listener per chat-list row was 900 calls per write with 300 chats. Here a write is read once and only
 * the subscribers of its key are called.
 */

/**
 * `event`: the event this page sends when it writes the store itself (every subscriber is called: it names no key).
 * `keyOf`: the subscriber key a stored key belongs to, or undefined for a key of another store or another profile.
 * Subscribing with `null` hears every key.
 */
export function keyedStorage(event: string, keyOf: (storageKey: string) => string | undefined) {
  const subscribers = new Map<string | null, Set<() => void>>();
  const call = (sets: (Set<() => void> | undefined)[]) => { for (const listener of sets.flatMap(set => set ? [...set] : [])) listener(); };
  const everyone = () => call([...subscribers.values()]);
  const stored = (e: StorageEvent) => {
    // No key: the other page cleared the storage.
    if (!e.key) return everyone();
    const key = keyOf(e.key);
    if (key !== undefined) call([subscribers.get(key), subscribers.get(null)]);
  };
  return (key: string | null, listener: () => void): (() => void) => {
    if (!subscribers.size) {
      window.addEventListener(event, everyone);
      window.addEventListener("storage", stored);
    }
    const set = subscribers.get(key) ?? new Set();
    subscribers.set(key, set.add(listener));
    return () => {
      set.delete(listener);
      if (set.size || subscribers.get(key) !== set) return;
      subscribers.delete(key);
      if (subscribers.size) return;
      window.removeEventListener(event, everyone);
      window.removeEventListener("storage", stored);
    };
  };
}
