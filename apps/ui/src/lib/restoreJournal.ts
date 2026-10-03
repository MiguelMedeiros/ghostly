import { dropFileSpace } from "@ghostly/browser/shared/fileBytes";
import { listProfiles, namespaceOf, registryKey } from "./profiles";

/**
 * What each restore under way has written so far, kept where a closed tab, a reload or a crash cannot lose it: a
 * restore writes a new profile's databases and files before the profile is listed, and one stopped half way would
 * otherwise leave them on the device for good, keys included, with nothing that would ever delete them.
 *
 * A restore holds a Web Lock while it runs. Whatever a restore left whose lock is free and whose profile is not
 * listed is taken back (`sweepInterruptedRestores`): at the next start of the app, and before the next restore.
 * Not under `ghostly_`: the first profile's keys are those, and this one must never travel in its backups.
 */
const journalKey = () => `ghostly-restoring:${registryKey()}`;
const lockName = (ns: string) => `ghostly-restore-${ns}`;
const NS = /^[A-Za-z0-9_.-]{1,120}$/;
type Journal = Record<string, string[]>;

function read(): Journal {
  try {
    const value = JSON.parse(localStorage.getItem(journalKey()) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Journal) : {};
  } catch { return {}; }
}
function write(journal: Journal): void {
  try {
    if (Object.keys(journal).length) localStorage.setItem(journalKey(), JSON.stringify(journal));
    else localStorage.removeItem(journalKey());
  } catch { /* nothing more to do */ }
}

/** Notes the databases a restore into `ns` may have made (`null`: it is over, made or taken back). */
export function noteRestore(ns: string, databases: string[] | null): void {
  const journal = read();
  if (databases) journal[ns] = databases; else delete journal[ns];
  write(journal);
}

/** Only what a restore into `ns` makes: its peer database and its Ark wallets' databases. Nothing else is ever deleted. */
const ownDatabase = (ns: string) => (name: unknown): name is string =>
  typeof name === "string" && (name === `ghostly_${ns}` || /^ghostly-ark-[0-9a-f-]{36}$/.test(name));

/** Takes away what a restore wrote: its databases, its files and every local key of its namespace. */
export async function undoRestore(ns: string, databases: string[], files = false): Promise<void> {
  for (const name of databases) {
    await new Promise<void>((resolve) => { try { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); } });
  }
  if (files) await dropFileSpace(`ghostly_${ns}`).catch(() => {});
  const prefix = `ghostly_${ns}_`;
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(prefix));
  for (const key of keys) { try { localStorage.removeItem(key); } catch { /* nothing more to do */ } }
}

type Locks = { request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<void>; request(name: string, callback: () => Promise<void>): Promise<void> };
const locks = (): Locks | null => (typeof navigator !== "undefined" && (navigator as Navigator & { locks?: Locks }).locks) || null;

/** Held while a restore into `ns` runs, so no other tab takes back what it is writing. Resolves to its release. */
export async function holdRestore(ns: string): Promise<() => void> {
  const manager = locks();
  if (!manager) return () => {};
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // A lock the page cannot have (a context that refuses them) never holds the restore up: it runs as it did before.
  await new Promise<void>((acquired) => { manager.request(lockName(ns), () => { acquired(); return held; }).catch(() => acquired()); });
  return release;
}

/**
 * Takes back what restores that never finished left: a namespace in the journal whose profile is not listed and whose
 * restore no tab still runs. A listed one finished: its note is dropped and nothing of it is touched. Without Web Locks
 * nothing is taken back, since a restore running in another tab could not be told apart from one stopped.
 */
export async function sweepInterruptedRestores(): Promise<void> {
  const manager = locks();
  if (!manager) return;
  const listed = new Set(listProfiles().map((entry) => namespaceOf(entry.id)));
  for (const [ns, databases] of Object.entries(read())) {
    if (!NS.test(ns) || listed.has(ns) || !Array.isArray(databases)) { noteRestore(ns, null); continue; }
    await manager.request(lockName(ns), { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await undoRestore(ns, databases.filter(ownDatabase(ns)), true);
      noteRestore(ns, null);
    }).catch(() => {});
  }
}
