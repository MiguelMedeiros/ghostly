import { parseLocalTarget } from "@ghostly/core";
import { localAccessPattern } from "@ghostly/browser/host";
import { databaseExists } from "@ghostly/browser/backup/database";
import { listProfiles, namespaceOf } from "../../ui/src/lib/profiles";
import { activeNamespace, databaseFor } from "./profile";
import { ALLOWED_PREFIX, allowedKey, allowedOrigins, disallowLocalOrigin } from "./localAllowList";

/**
 * Chrome's optional host permissions for this machine's apps (`http://127.0.0.1/*`). One is granted per host, for
 * every port of it, and every profile of the extension has the same ones: a pattern goes back only once no app any
 * profile shares is at that host, whatever its port.
 */

/** The apps one profile shares, read from its peer database (`services`, kept unsealed) without starting it. */
async function sharedTargets(dbName: string): Promise<string[]> {
  if (!(await databaseExists(dbName))) return [];
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains("services")) return [];
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction("services", "readonly").objectStore("services").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return rows.map((row) => (row as { target?: unknown } | null)?.target).filter((t): t is string => typeof t === "string");
  } finally {
    db.close();
  }
}

/** The patterns some app of some profile on the list still needs. Throws when a profile could not be read. */
async function patternsInUse(): Promise<Set<string>> {
  const used = new Set<string>();
  for (const profile of listProfiles()) {
    for (const target of await sharedTargets(databaseFor(namespaceOf(profile.id)))) {
      try { used.add(localAccessPattern(parseLocalTarget(target).origin)); } catch { /* a target that no longer parses needs nothing */ }
    }
  }
  return used;
}

/** Gives back those of `patterns` no profile needs. A profile that could not be read keeps them all: asking again costs a prompt. */
async function release(patterns: string[]): Promise<void> {
  if (!patterns.length) return;
  let used: Set<string>;
  try { used = await patternsInUse(); } catch { return; }
  const unused = [...new Set(patterns)].filter((pattern) => !used.has(pattern));
  if (unused.length) await chrome.permissions.remove({ origins: unused });
}

/** The last app of this profile at `origin` went (`removeService`): off its list (localAllowList.ts), and its host's pattern, if nothing else is there. */
export async function forgetLocalAccess(origin: string): Promise<void> {
  await disallowLocalOrigin(activeNamespace(), origin);
  await release([localAccessPattern(origin)]);
}

/** Each listed profile keeps only the addresses it still shares an app at; a profile gone keeps none. */
async function pruneAllowed(): Promise<void> {
  const kept: Record<string, string[]> = {};
  for (const profile of listProfiles()) {
    const ns = namespaceOf(profile.id);
    const shared = new Set<string>();
    for (const target of await sharedTargets(databaseFor(ns))) {
      try { shared.add(parseLocalTarget(target).origin); } catch { /* a target that no longer parses is reached nowhere */ }
    }
    kept[allowedKey(ns)] = (await allowedOrigins(ns)).filter((origin) => shared.has(origin));
  }
  const gone = Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith(ALLOWED_PREFIX) && !(key in kept));
  await chrome.storage.local.set(kept);
  if (gone.length) await chrome.storage.local.remove(gone);
}

/** A profile's apps all went (Clear all data, a profile deleted): every local pattern Chrome granted and nobody needs. */
export async function releaseUnusedLocalAccess(): Promise<void> {
  // A profile that could not be read loses nothing it allowed: what it keeps still needs Chrome's permission too.
  await pruneAllowed().catch(() => {});
  const local = new Set(chrome.runtime.getManifest().optional_host_permissions ?? []);
  const { origins = [] } = await chrome.permissions.getAll();
  await release(origins.filter((pattern) => local.has(pattern)));
}
