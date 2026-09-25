import { decode, encode } from "@ghostly/browser/backup/codec";
import { open, seal } from "@ghostly/browser/backup/envelope";
import { databaseExists, restoreDatabase, snapshotDatabase, type DatabaseSnapshot } from "@ghostly/browser/backup/database";
import { databaseName, type StoredFile } from "@ghostly/browser/shared/idb";
import { SMALL_FILE_BYTES } from "@ghostly/browser/shared/fileBytes";
import { storedBlob, storedSize } from "@ghostly/browser/shared/storedFiles";
import { restoreArkDatabase, snapshotArkDatabase, type ArkDatabaseSnapshot } from "@ghostly/browser/engine/paymentAdapters/backup";
import { getPrefix, getStorageProfile, ownsKey } from "./storage";
import { assertUnlocked } from "./profileData";
import { currentProfile, listProfiles, namespaceOf, newProfileId, registerProfile, registryKey, type ProfileEntry } from "./profiles";

/** The decrypted content of a profile bundle (WISP 05). */
interface ProfilePayload {
  format: "ghostly-profile";
  version: 1;
  createdAt: number;
  profile: { name: string };
  /** The profile's local keys, without its prefix. */
  storage: Record<string, string>;
  databases: { peer: DatabaseSnapshot | null; ark: Record<string, ArkDatabaseSnapshot> };
}

/**
 * Files whose bytes are in file storage rather than in IndexedDB: those up to 16 MiB go in the bundle as
 * Blobs (a picture, a voice message), as every file did before file storage; larger ones stay out, and
 * show as no longer available where the bundle is restored. The pieces store is emptied: its files are in
 * the bundle whole, or not at all. Only the active profile's storage can be read here.
 */
async function withFileBytes(peer: DatabaseSnapshot | null, active: boolean): Promise<void> {
  const files = peer?.stores.find((store) => store.name === "files");
  if (files && active) {
    files.values = await Promise.all(files.values.map(async (value) => {
      const file = value as StoredFile;
      if (!file?.bytes || file.blob || storedSize(file) > SMALL_FILE_BYTES) return value;
      const blob = await storedBlob(file, file.metadata?.mime ?? "").catch(() => null);
      return blob ? { ...file, blob: new Blob([await blob.arrayBuffer()], { type: blob.type }) } : value;
    }));
  }
  const pieces = peer?.stores.find((store) => store.name === "fileChunks");
  if (pieces) { pieces.keys = []; pieces.values = []; }
}

const isArkRecord = (key: IDBValidKey) => key === "arkWallet" || (typeof key === "string" && (key.startsWith("arkWallet-retired-") || key.startsWith("arkWallet-mode-")));

/**
 * Everything of a profile — chats and keys, messages and files, wallets and their journal, services,
 * settings — in one encrypted bundle. Storage credentials are left out. By default the active profile;
 * another one of this space can be backed up without switching to it (before deleting it, say), with
 * its lock password if it has a lock.
 */
export async function createProfileBackup(passphrase: string, id?: string, lockPassword?: string): Promise<string> {
  const active = id === undefined || namespaceOf(id) === getStorageProfile();
  const ns = active ? getStorageProfile() : namespaceOf(id!);
  if (!active && !ns) throw new Error("Unknown profile");
  if (!active) await assertUnlocked(id!, lockPassword);
  const prefix = active ? getPrefix() : `ghostly_${ns}_`;
  const owns = (key: string) => (active ? ownsKey(key) : key.startsWith(prefix));
  const storage: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === registryKey() || !owns(key)) continue;
    let value = localStorage.getItem(key);
    if (value === null) continue;
    const suffix = key.slice(prefix.length);
    if (suffix === "app_settings") {
      try { const settings = JSON.parse(value) as Record<string, unknown>; delete settings.backupS3; value = JSON.stringify(settings); } catch { /* kept as it is */ }
    }
    storage[suffix] = value;
  }
  const peer = await snapshotDatabase(active ? databaseName() : `ghostly_${ns}`);
  await withFileBytes(peer, active);
  const ark: Record<string, ArkDatabaseSnapshot> = {};
  const settingsStore = peer?.stores.find((s) => s.name === "settings");
  // The peer's copy of the storage credentials (for held messages, WISP 4xx) stays out too, like the page's.
  for (const [i, key] of (settingsStore?.keys ?? []).entries()) {
    const value = settingsStore!.values[i] as Record<string, unknown> | null;
    if (key === "settings" && value && typeof value === "object" && "holdStorage" in value) { const { holdStorage: _hold, ...rest } = value; settingsStore!.values[i] = rest; }
  }
  for (const [i, key] of (settingsStore?.keys ?? []).entries()) {
    if (!isArkRecord(key)) continue;
    const walletId = (settingsStore!.values[i] as { config?: { walletId?: string } })?.config?.walletId;
    if (!walletId || ark[walletId]) continue;
    // A wallet that never opened its own database here has nothing more to keep than its record. One
    // that has, and cannot be read, stops the backup: a copy without it would not be the whole wallet.
    if (!(await databaseExists(`ghostly-ark-${walletId}`))) continue;
    ark[walletId] = await snapshotArkDatabase(walletId).catch((e: unknown) => Promise.reject(Object.assign(new Error(`Could not read the Ark wallet for the backup: ${e instanceof Error ? e.message : e}`), { cause: e })));
  }
  const payload: ProfilePayload = { format: "ghostly-profile", version: 1, createdAt: Date.now(), profile: { name: active ? currentProfile().name : listProfiles().find((p) => p.id === id)?.name ?? "Profile" }, storage, databases: { peer, ark } };
  return seal(await encode(payload), passphrase);
}

/**
 * Brings a bundle back as a new profile of this space, and returns it. Nothing existing is replaced.
 * Ark wallet databases move to fresh ids; unfinished payment attempts are kept as unknown.
 */
export async function restoreProfileBackup(text: string, passphrase: string): Promise<ProfileEntry> {
  const payload = decode(await open(text, passphrase)) as ProfilePayload;
  if (payload?.format !== "ghostly-profile" || payload.version !== 1 || typeof payload.profile?.name !== "string" || !payload.storage || typeof payload.storage !== "object" || !payload.databases) throw new Error("This backup does not hold a profile");
  const id = newProfileId(), ns = namespaceOf(id);

  // Every Ark wallet gets a new id, with or without a copy of its database: a restored profile must never
  // share a database with the one it was copied from, which may still be on this device.
  const walletIds = new Map<string, string>();
  const ark = payload.databases.ark ?? {};
  const peer = payload.databases.peer;
  const settings = peer?.stores.find((store) => store.name === "settings");
  for (const [i, value] of (settings?.values ?? []).entries()) {
    const walletId = (value as { config?: { walletId?: unknown } })?.config?.walletId;
    if (isArkRecord(settings!.keys[i]) && typeof walletId === "string" && !walletIds.has(walletId)) walletIds.set(walletId, crypto.randomUUID());
  }
  for (const [oldId, fresh] of walletIds) if (Object.prototype.hasOwnProperty.call(ark, oldId)) await restoreArkDatabase(fresh, ark[oldId]);
  // Fedimint client databases are files of this origin, not in the bundle: every federation gets a new file name,
  // which the wallet finds missing and fills by joining again with the mnemonic (the federation's recovery).
  const freshFedimint = (value: unknown) => {
    const record = value as { database?: unknown; federations?: { database?: unknown }[] };
    const renamed = (f: { database?: unknown }) => typeof f?.database === "string" ? { ...f, database: `ghostly-fedimint-${crypto.randomUUID()}.db` } : f;
    return Array.isArray(record?.federations) ? { ...record, federations: record.federations.map(renamed) } : typeof record?.database === "string" ? renamed(record) : value;
  };
  if (peer) {
    for (const store of peer.stores) {
      if (store.name === "settings") {
        store.values = store.values.map((value, i) => {
          const record = value as { config?: { walletId?: string } };
          const moved = record?.config?.walletId && walletIds.get(record.config.walletId);
          if (typeof store.keys[i] === "string" && (store.keys[i] as string).startsWith("fedimint")) return freshFedimint(value);
          return isArkRecord(store.keys[i]) && moved ? { ...record, config: { ...record.config, walletId: moved } } : value;
        });
      }
      if (store.name === "paymentIntents") {
        // An older copy cannot prove an unfinished attempt was never sent; it may not authorize a new one.
        store.values = store.values.map((value) => {
          const intent = value as { review?: { state?: string } };
          return intent?.review && ["pending", "submitted", "unknown"].includes(intent.review.state ?? "") ? { ...intent, review: { ...intent.review, state: "unknown" } } : value;
        });
      }
    }
    await restoreDatabase(`ghostly_${ns}`, peer);
  }
  for (const [suffix, value] of Object.entries(payload.storage)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(suffix)) continue;
    localStorage.setItem(`ghostly_${ns}_${suffix}`, value);
  }
  // Registered last: an interrupted restore leaves no half-made profile in the list.
  return registerProfile(id, `${payload.profile.name} (restored)`.slice(0, 32));
}
