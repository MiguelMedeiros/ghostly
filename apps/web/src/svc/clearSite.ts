/** The names of the cookies this page's script sees. */
function cookieNames(): string[] {
  return document.cookie.split(";").map((pair) => pair.split("=")[0]?.trim() ?? "").filter(Boolean);
}

/**
 * Expires the cookie `name` on `domain` (none: this origin's own). This frame is under the web app's page, another site:
 * a write without `Secure; SameSite=None` is refused there, and a `Partitioned` one is another cookie, kept for the web
 * app's site. A date in the past, not Max-Age=0: that one expires "now", and is still there within the same millisecond.
 */
function expire(name: string, domain?: string): void {
  const base = `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/${domain ? `; Domain=${domain}` : ""}`;
  document.cookie = base;
  document.cookie = `${base}; Secure; SameSite=None`;
  document.cookie = `${base}; Secure; SameSite=None; Partitioned`;
}

/**
 * Expires every cookie a contact's app set for the whole services host (`Domain=<suffix>`): each app's script would
 * read it, whichever chat or profile opened it, so one app could tell another it ran in the same browser. A cookie of
 * this origin's own is another one (host-only) and stays. Done by the bridge before it frames an app, and by its clear.
 */
export function dropSharedCookies(suffix: string): void {
  for (const name of cookieNames()) {
    try { expire(name, suffix); } catch { /* refused: nothing else to do */ }
  }
}

/**
 * What a contact's app kept on its origin, erased by the bridge on that origin (`bridge.ts`) when the app asks: its
 * local and session storage, its IndexedDB databases, its caches, its files in the origin-private file system, the
 * cookies its script set (its own and those for the whole services host, `suffix`), and the services worker. Each kind
 * on its own: one the browser refuses keeps none of the others.
 */
export async function clearSite(suffix: string): Promise<void> {
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
    () => { for (const name of cookieNames()) expire(name); },
    () => dropSharedCookies(suffix),
    async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); },
  ];
  for (const step of steps) {
    try { await step(); } catch { /* not in this browser, or refused: the next kind still goes */ }
  }
}
