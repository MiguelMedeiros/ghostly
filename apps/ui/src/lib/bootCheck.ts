/*
 * What the web app cannot run without, looked at before anything starts (apps/web/src/main.tsx). A browser that
 * lacks one of these used to give a blank page (no Web Locks) or an app that looked fine and never connected
 * (no IndexedDB, no Web Crypto). Now the app says which one is missing (components/UnsupportedBrowser).
 *
 * Only what is certain counts: an API that is not there, or one that refuses. One that is merely slow passes, and
 * the app starts as it always did.
 */

/**
 * `storage`: localStorage is not there or may not be touched (site data blocked). `indexedDB`: not there, or
 * opening a database fails (some private modes). `crypto`: no `crypto.subtle`, which browsers give only to a
 * secure address (https, or localhost). `locks`: no Web Locks, so the app cannot make sure it runs once.
 */
export type Essential = "storage" | "indexedDB" | "crypto" | "locks";

/** The database the check opens: its own, never the app's (opening that one here would create it empty). */
const PROBE_DATABASE = "ghostly-boot-check";

/** How long a database may take to open before the check stops waiting and lets the app start. */
const INDEXED_DB_WAIT_MS = 3000;

function storageWorks(): boolean {
  try { return typeof localStorage === "object" && localStorage !== null && typeof localStorage.length === "number"; } catch { return false; }
}

function cryptoWorks(): boolean {
  try { return typeof crypto === "object" && !!crypto.subtle && typeof crypto.getRandomValues === "function"; } catch { return false; }
}

function locksWork(): boolean {
  try { return typeof navigator === "object" && typeof navigator.locks?.request === "function"; } catch { return false; }
}

/** False only when a database certainly cannot be opened: no IndexedDB, `open` throws, or it answers with an error. */
function indexedDbWorks(waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let factory: IDBFactory | undefined;
    try { factory = typeof indexedDB === "undefined" ? undefined : indexedDB; } catch { factory = undefined; }
    if (!factory) { resolve(false); return; }
    let request: IDBOpenDBRequest;
    try { request = factory.open(PROBE_DATABASE); } catch { resolve(false); return; }
    const timer = setTimeout(() => resolve(true), waitMs);
    request.onsuccess = () => {
      clearTimeout(timer);
      // Nothing is left behind.
      try { request.result.close(); factory.deleteDatabase(PROBE_DATABASE); } catch { /* it stays, empty */ }
      resolve(true);
    };
    request.onerror = (event) => {
      clearTimeout(timer);
      // Handled here: it must not also reach the page as an uncaught error.
      try { event.preventDefault(); } catch { /* nothing to stop */ }
      resolve(false);
    };
  });
}

/** What this browser lacks of what the app cannot run without, in the order the screen lists it. Empty: start. */
export async function missingEssentials({ indexedDbWaitMs = INDEXED_DB_WAIT_MS } = {}): Promise<Essential[]> {
  const missing: Essential[] = [];
  if (!storageWorks()) missing.push("storage");
  if (!(await indexedDbWorks(indexedDbWaitMs))) missing.push("indexedDB");
  if (!cryptoWorks()) missing.push("crypto");
  if (!locksWork()) missing.push("locks");
  return missing;
}

/** What the boot guard (apps/web/public/boot-guard.js) offers the page; absent everywhere else. */
interface BootGuard {
  details(): string;
  clean(text: string): string;
}

/**
 * What "Copy details" holds on the "cannot run here" screen: what is missing, then the boot guard's report (the
 * browser's version and which APIs it has). No address fragment, nothing stored, nothing of a chat or a key.
 */
export function bootDetails(missing: readonly Essential[], error?: unknown): string {
  const guard = (globalThis as { __ghostlyBoot?: BootGuard }).__ghostlyBoot;
  const lines = [`missing: ${missing.join(", ") || "none"}`];
  if (error !== undefined) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    lines.push(`error: ${guard ? guard.clean(text) : text.slice(0, 200)}`);
  }
  try {
    if (guard) lines.push(guard.details());
    else lines.push(`browser: ${navigator.userAgent}`);
  } catch { /* the first lines are enough */ }
  return lines.join("\n");
}
