import { CLEAR_COOKIES } from "./protocol";

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

/** Expires each cookie this page sees on `domain` (none: this origin's own). */
function expireSeen(domain?: string): void {
  for (const name of cookieNames()) {
    try { expire(name, domain); } catch { /* refused: nothing else to do */ }
  }
}

/**
 * Has the server drop every cookie of this origin's site (`Clear-Site-Data: "cookies"`, nginx-services.conf), at every
 * path, partitioned or not. A script sees only the cookies whose path its page's URL is under, so one an app set at
 * `Path=/t` is never there to expire, and reaches every other app that opens a page under `/t`. The browser clears the
 * whole site: with a services host that is not a public suffix, the other apps' own cookies go too.
 */
async function clearCookies(): Promise<void> {
  const answer = await fetch(CLEAR_COOKIES, { cache: "no-store", credentials: "same-origin" });
  if (!answer.ok) throw new Error(`The server did not clear the cookies (${answer.status})`);
}

/**
 * Whether this browser takes a cookie for the whole services host (`Domain=<suffix>`) from this frame: none when the
 * host is a public suffix, or when it keeps no cookie of a frame under another site.
 */
function sharedCookiesTaken(suffix: string): boolean {
  const name = "ghostly-svc-probe";
  const base = `${name}=1; Path=/; Domain=${suffix}`;
  try {
    document.cookie = base;
    document.cookie = `${base}; Secure; SameSite=None`;
    document.cookie = `${base}; Secure; SameSite=None; Partitioned`;
  } catch { return false; }
  const taken = cookieNames().includes(name);
  if (taken) expire(name, suffix);
  return taken;
}

/**
 * Drops every cookie a contact's app set for the whole services host (`Domain=<suffix>`), at any path: each app's
 * script would read it, whichever chat or profile opened it, so one app could tell another it ran in the same browser.
 * Only where the browser takes one: on a services host that is a public suffix, this origin's own cookies stay. Done
 * by the bridge before it frames an app, and by its clear; it fails when the server did not clear them.
 */
export async function dropSharedCookies(suffix: string): Promise<void> {
  expireSeen(suffix);
  if (sharedCookiesTaken(suffix)) await clearCookies();
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
    () => expireSeen(),
    () => expireSeen(suffix),
    // Those at a path of their own too, which this page never sees.
    () => clearCookies(),
    async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); },
  ];
  for (const step of steps) {
    try { await step(); } catch { /* not in this browser, or refused: the next kind still goes */ }
  }
}
