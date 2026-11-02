/**
 * What a contact's app kept on its origin, erased by the bridge on that origin (`bridge.ts`) when the app asks: its
 * local and session storage, its IndexedDB databases, its caches, its files in the origin-private file system, the
 * cookies its script set, and the services worker. Each kind on its own: one the browser refuses keeps none of the others.
 */
export async function clearSite(): Promise<void> {
  const steps: (() => unknown)[] = [
    () => localStorage.clear(),
    () => sessionStorage.clear(),
    async () => {
      for (const { name } of await indexedDB.databases()) {
        if (!name) continue;
        // Blocked by a page of the app still open: the delete goes on once it closes, without holding up the rest.
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
      }
    },
    async () => { for (const key of await caches.keys()) await caches.delete(key); },
    async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) await root.removeEntry(name, { recursive: true });
    },
    () => {
      for (const pair of document.cookie.split(";")) {
        const name = pair.split("=")[0]?.trim();
        // A date in the past, not Max-Age=0: that one expires "now", and is still there within the same millisecond.
        if (name) document.cookie = `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
      }
    },
    async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); },
  ];
  for (const step of steps) {
    try { await step(); } catch { /* not in this browser, or refused: the next kind still goes */ }
  }
}
