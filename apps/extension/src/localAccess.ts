import { parseLocalTarget } from "@ghostly/core";
import { localAccessPattern } from "@ghostly/browser/host";
import { databaseExists } from "@ghostly/browser/backup/database";
import { listProfiles, namespaceOf } from "../../ui/src/lib/profiles";
import { databaseFor } from "./profile";

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

/**
 * The Web Lock (the extension's origin: every page, the worker and the offscreen document share it) under which a page
 * reads the apps and gives a pattern back, and under which a share checks its pattern and adds its app. Without it,
 * a share in another tab, answered at once while the pattern is still granted, adds its app between the read and the
 * remove, and the remove takes the access that app needs. Never held over a prompt: the share asks before taking it.
 */
const LOCK = "ghostly-local-access";

async function locked<T>(task: () => Promise<T>): Promise<T> {
  // Every context of the extension has `navigator.locks` (Chrome 69); a test or a context without it runs unordered.
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? await locks.request(LOCK, task) : task();
}

/** Gives back those of `patterns` no profile needs. A profile that could not be read keeps them all: asking again costs a prompt. */
function release(patterns: string[]): Promise<void> {
  if (!patterns.length) return Promise.resolve();
  return locked(async () => {
    let used: Set<string>;
    try { used = await patternsInUse(); } catch { return; }
    const unused = [...new Set(patterns)].filter((pattern) => !used.has(pattern));
    if (unused.length) await chrome.permissions.remove({ origins: unused });
  });
}

/**
 * A share's `addService`, once Chrome said yes to `pattern`: run while no page can give the pattern back, and only if
 * Chrome still holds it (another tab may have given it back after the yes). False: it was not run, ask again.
 */
export function withLocalAccess(pattern: string, task: () => Promise<void>): Promise<boolean> {
  return locked(async () => {
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) return false;
    await task();
    return true;
  });
}

/** The last app of this profile at `origin` went (`removeService`): its host's pattern, if nothing else is there. */
export const forgetLocalAccess = (origin: string): Promise<void> => release([localAccessPattern(origin)]);

/** A profile's apps all went (Clear all data, a profile deleted): every local pattern Chrome granted and nobody needs. */
export async function releaseUnusedLocalAccess(): Promise<void> {
  const local = new Set(chrome.runtime.getManifest().optional_host_permissions ?? []);
  const { origins = [] } = await chrome.permissions.getAll();
  await release(origins.filter((pattern) => local.has(pattern)));
}
