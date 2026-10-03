import { STORES, openDb } from "./idb";

/**
 * What a restore changes in the money a backup carries (WISP 05 § Restoring). A bundle holds the wallet as it stood
 * when the backup was made, and the profile it came from may have gone on since: none of it is taken at its word.
 */
export const RESTORED_WALLET_STORES: readonly string[] = [STORES.proofs, STORES.swaps, STORES.intents];

/** One row of `store` as a restore writes it. A row of any other store, or one that is not what it should be, is kept as it is. */
export function restoredWalletRow(store: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (store === STORES.proofs) {
    // Ecash as it was when the backup was made: what was spent since is found by asking the mint, once the wallet runs.
    const proof = value as { secret?: unknown; reserved?: boolean };
    return typeof proof.secret === "string" && !proof.reserved ? { ...proof, unchecked: true } : value;
  }
  // A swap as it stood when the backup was made: what it brings is checked like the copy's ecash.
  if (store === STORES.swaps) return { ...value, restored: true };
  if (store === STORES.intents) {
    // An older copy cannot prove an unfinished attempt was never sent; it may not authorize a new one.
    const intent = value as { review?: { state?: string } };
    return intent.review && ["pending", "submitted", "unknown"].includes(intent.review.state ?? "") ? { ...intent, review: { ...intent.review, state: "unknown" } } : value;
  }
  return value;
}

/**
 * The same, for a restore that brought the profile's database back whole (the headless CLI's): every wallet row of
 * this profile's database is rewritten as `restoredWalletRow` says, in one transaction, before the engine reads any.
 * Doing it twice changes nothing more.
 */
export async function markRestoredWallet(): Promise<void> {
  const db = await openDb();
  const names = RESTORED_WALLET_STORES.filter((name) => db.objectStoreNames.contains(name));
  if (!names.length) return;
  const tx = db.transaction(names, "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("The restored wallet could not be marked"));
    tx.onerror = () => reject(tx.error ?? new Error("The restored wallet could not be marked"));
  });
  for (const name of names) {
    const walk = tx.objectStore(name).openCursor();
    walk.onsuccess = () => {
      const cursor = walk.result;
      if (!cursor) return;
      const next = restoredWalletRow(name, cursor.value);
      if (next !== cursor.value) cursor.update(next);
      cursor.continue();
    };
  }
  return done;
}

/**
 * Files a light backup left out (WISP 05 § Light backups), for a restore that brought the database back whole (the
 * headless CLI's): each record is marked `leftOut`, and nothing of it says any longer where its bytes were. A file
 * not in the database is passed over. Doing it twice changes nothing more.
 */
export async function markLeftOutFiles(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction([STORES.files, STORES.fileState], "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("The files left out could not be marked"));
    tx.onerror = () => reject(tx.error ?? new Error("The files left out could not be marked"));
  });
  const files = tx.objectStore(STORES.files), states = tx.objectStore(STORES.fileState);
  for (const id of ids) {
    const read = files.get(id);
    read.onsuccess = () => {
      const record = read.result as { blob?: unknown; bytes?: unknown } | undefined;
      if (!record) return;
      const { blob: _blob, bytes: _bytes, ...rest } = record;
      files.put({ ...rest, leftOut: true });
    };
    const state = states.get(id);
    state.onsuccess = () => {
      const value = state.result as { bytes?: unknown } | undefined;
      if (!value || !("bytes" in value)) return;
      const { bytes: _bytes, ...rest } = value;
      states.put(rest);
    };
  }
  return done;
}
