import { decode, encode } from "@ghostly/browser/backup/codec";
import { fromBase64Url } from "@ghostly/core";
import { MAX_BACKUP_BYTES, open } from "@ghostly/browser/backup/envelope";
import { BackupReader, BackupWriter, DEVICE_SET_BACKUP_VERSION, backupProtection, readBackupHeader, blobSource, bytesSource, isCancelled, memorySink, type BackupSink, type BackupSource } from "@ghostly/browser/backup/stream";
import { readDeviceRecord } from "@ghostly/browser/devices/store";
import { isBundleDevices, type BundleDevices } from "@ghostly/browser/devices/restoreGuard";
import { PENDING_RAISE_KEY, pendingRaise } from "@ghostly/browser/devices/raise";
import { unsealSeed } from "@ghostly/browser/engine/paymentAdapters/persistence";
import { createDatabase, databaseExists, putRows, restoreDatabase, snapshotDatabase, type DatabaseSnapshot, type StoreShape } from "@ghostly/browser/backup/database";
import { databaseName, wrap, type StoredFile } from "@ghostly/browser/shared/idb";
import { FILE_BYTES_STEP, SMALL_FILE_BYTES, checkFileId, dropFileSpace, fileBytes, fileBytesOf, type FileBytes, type FileBytesKind } from "@ghostly/browser/shared/fileBytes";
import { restoreArkDatabase, snapshotArkDatabase, type ArkDatabaseSnapshot } from "@ghostly/browser/engine/paymentAdapters/backup";
import { getPrefix, getStorageProfile, ownsKey } from "./storage";
import { assertUnlocked, identityKeysOf, profileIdentityKeys } from "./profileData";
import { builtInNameBefore, currentProfile, isBuiltInName, listProfiles, namespaceOf, newProfileId, registerProfile, registryKey, storedProfileName, type ProfileEntry } from "./profiles";

/** What a bundle says about the profile it holds, and the profile's local keys without its prefix. */
interface ProfileHead {
  /**
   * `builtIn`: whether `name` is the built-in name, which the restored profile shows in the app's language, or a name
   * someone gave, kept as written. Absent in a bundle made before the marker (see `builtInNameBefore`).
   */
  profile: { name: string; builtIn?: boolean };
  storage: Record<string, string>;
}

/** The decrypted content of a version 1 bundle (WISP 05): everything in one JSON document. Still restored, no longer made. */
interface ProfilePayload extends ProfileHead {
  format: "ghostly-profile";
  version: 1;
  createdAt: number;
  databases: { peer: DatabaseSnapshot | null; ark: Record<string, ArkDatabaseSnapshot> };
}

/** The records of a version 2 bundle, in the order they are written (WISP 05 § Payload). */
type BackupRecord =
  | ({ t: "profile"; format: "ghostly-profile"; version: 2; createdAt: number; files: number; bytes: number } & ProfileHead)
  /** The device set of an enrolled profile (WISP 06): its secret, the set and the turn; never a device signing key. */
  | ({ t: "devices" } & BundleDevices)
  | { t: "db"; db: "peer"; version: number; stores: StoreShape[] }
  | { t: "rows"; db: "peer"; store: string; keys: IDBValidKey[]; values: unknown[] }
  | { t: "ark"; walletId: string; snapshot: ArkDatabaseSnapshot }
  | { t: "file"; row: StoredFile; size: number; type: string }
  | { t: "file-end"; ok: boolean }
  | { t: "end"; files: number; bytes: number };

/** What a backup or a restore is doing now, for a progress bar. Bytes are those of the profile's files. */
export interface BackupProgress {
  stage: "collecting" | "writing" | "opening" | "restoring" | "verifying";
  files: number;
  filesTotal: number;
  bytes: number;
  bytesTotal: number;
}
/** How a backup or restore is watched and stopped. A stopped one throws an `AbortError` and leaves nothing behind. */
export interface BackupRun { signal?: AbortSignal; onProgress?: (progress: BackupProgress) => void }
export interface BackupOptions extends BackupRun {
  /** Null: the bundle is not encrypted. The caller has made sure that is what the person chose. */
  passphrase: string | null;
  /** Another profile of this space; the active one when left out. */
  id?: string;
  lockPassword?: string;
  /**
   * The part `db/peer` of a handoff (WISP 06 § The handoff), not a backup: every file's record goes without its bytes
   * (they move as parts of their own), the storage settings and credentials go along (the new active device keeps
   * holding items for contacts), and the lock's count of wrong attempts stays behind. The database is opened without
   * a version and read in one read-only transaction, so a frozen copy is never changed by it.
   */
  handoff?: true;
}
/** `skipped`: files whose bytes could not be read on this device; their messages are kept, the bytes are not in the bundle. */
export interface BackupResult { bytes: number; files: number; fileBytes: number; skipped: number }

export { isCancelled };

const ROWS_PER_RECORD = 400;
const isRecordOf = (rail: "arkWallet" | "barkWallet") => (key: IDBValidKey) => key === rail || (typeof key === "string" && (key.startsWith(`${rail}-retired-`) || key.startsWith(`${rail}-mode-`)));
const isArkRecord = isRecordOf("arkWallet");
/** A Bark wallet keeps its coins in a database of its own, named after its id (`ghostly-bark-<id>`), which no bundle carries. */
const isBarkRecord = isRecordOf("barkWallet");
const hasOwnDatabase = (key: IDBValidKey) => isArkRecord(key) || isBarkRecord(key);

/** One file's bytes, wherever they are, read a step at a time. */
export interface FileSource { size: number; read(offset: number, length: number): Promise<Uint8Array> }

/** The pieces of a file kept in a profile's own database (`fileBytesIdb.ts`), read from that database. */
function piecesSource(db: IDBDatabase, id: string): Promise<FileSource | null> {
  const store = () => db.transaction("fileChunks", "readonly").objectStore("fileChunks");
  return (async () => {
    if (!db.objectStoreNames.contains("fileChunks")) return null;
    const keys = (await wrap(store().getAllKeys(IDBKeyRange.bound([id, 0], [id, Infinity])))) as [string, number][];
    if (!keys.length) return null;
    const last = (await wrap(store().get(keys[keys.length - 1]))) as { length: number };
    return {
      size: (keys.length - 1) * FILE_BYTES_STEP + last.length,
      read: async (offset: number, length: number) => {
        const piece = (await wrap(store().get([id, Math.floor(offset / FILE_BYTES_STEP)]))) as { length: number; data: Blob } | undefined;
        if (!piece) return new Uint8Array();
        const from = offset % FILE_BYTES_STEP;
        return new Uint8Array(await piece.data.slice(from, Math.min(piece.length, from + length)).arrayBuffer());
      },
    };
  })();
}

/**
 * Where a stored file's bytes are read from: its Blob, or file storage under its id, in the profile's own space. Null
 * when they are not on this device, or not all of them yet (a transfer still under way keeps its record, not its bytes).
 */
export async function fileSource(file: StoredFile, space: string, active: boolean, pieces: () => Promise<IDBDatabase | null>): Promise<FileSource | null> {
  let source: FileSource | null = null;
  if (file.blob) {
    // A Blob on the record is the whole file: kept only once it was.
    const blob = file.blob;
    return { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) };
  }
  if (file.bytes) {
    const backend = await fileBytesOf(file.bytes);
    const store = !backend ? null : active ? backend : backend.forSpace?.(space) ?? null;
    if (store) {
      const size = await store.size(checkFileId(file.id));
      if (size !== null) source = { size, read: (offset, length) => store.read(file.id, offset, length) };
    } else if (backend && !active) {
      const db = await pieces();
      source = db ? await piecesSource(db, file.id) : null;
    }
  }
  const expected = file.metadata?.size;
  return source && (typeof expected !== "number" || source.size >= expected) ? source : null;
}

/**
 * Everything of a profile (chats and keys, messages and files of any size, wallets and their journal, services,
 * settings) written to `sink` as one bundle, a piece at a time: nothing of it is ever whole in memory but the
 * database's rows. Storage credentials are left out. By default the active profile; another one of this space can be
 * backed up without switching to it (before deleting it, say), with its lock password if it has a lock.
 */
export async function writeProfileBackup(sink: BackupSink, { passphrase, id, lockPassword, signal, onProgress, handoff }: BackupOptions): Promise<BackupResult> {
  const active = id === undefined || namespaceOf(id) === getStorageProfile();
  const ns = active ? getStorageProfile() : namespaceOf(id!);
  if (!active && !ns) throw new Error("Unknown profile");
  if (!active) await assertUnlocked(id!, lockPassword);
  const progress: BackupProgress = { stage: "collecting", files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0 };
  const tell = () => onProgress?.({ ...progress });
  tell();
  // An enrolled profile's bundle carries its device set (WISP 06), in an envelope an app from before refuses. A handoff
  // part does not: the device set never moves in a handoff.
  const devices = handoff ? null : await bundleDevicesOf(active ? databaseName() : `ghostly_${ns}`);
  // The key is derived first: a passphrase too short is refused before anything is read.
  const writer = await BackupWriter.start(sink, passphrase, signal, devices ? DEVICE_SET_BACKUP_VERSION : 2);

  const prefix = active ? getPrefix() : `ghostly_${ns}_`;
  const owns = (key: string) => (active ? ownsKey(key) : key.startsWith(prefix));
  const storage: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key === registryKey() || !owns(key)) continue;
    let value = localStorage.getItem(key);
    if (value === null) continue;
    const suffix = key.slice(prefix.length);
    // A handoff leaves the lock's count of wrong attempts behind, and what a staging namespace notes for itself.
    if (handoff && (suffix === "lock_attempts" || suffix.startsWith("handoff_"))) continue;
    if (suffix === "app_settings" && !handoff) {
      try { const settings = JSON.parse(value) as Record<string, unknown>; delete settings.backupS3; value = JSON.stringify(settings); } catch { /* kept as it is */ }
    }
    storage[suffix] = value;
  }
  const space = active ? databaseName() : `ghostly_${ns}`;
  // The pieces of large files are not read here: every file's bytes are read through file storage, a step at a time.
  const peer = await snapshotDatabase(space, ["fileChunks"]);
  const storeOf = (name: string) => peer?.stores.find((store) => store.name === name);
  const settingsStore = storeOf("settings");
  // The peer's copy of the storage credentials (for held messages, WISP 4xx) stays out too, like the page's, and so does
  // the push subscription (WISP 401 § Wake-up push): it belongs to this browser, and its key pair signs wake-ups.
  for (const [i, key] of (settingsStore?.keys ?? []).entries()) {
    const value = settingsStore!.values[i] as Record<string, unknown> | null;
    if (key === "settings" && value && typeof value === "object" && ("holdStorage" in value || "wake" in value)) {
      // A handoff keeps the hold storage (the new active device goes on holding items for contacts); the push
      // subscription belongs to this browser either way.
      const { holdStorage, wake: _wake, ...rest } = value;
      settingsStore!.values[i] = handoff && holdStorage !== undefined ? { ...rest, holdStorage } : rest;
    }
  }
  const ark: Record<string, ArkDatabaseSnapshot> = {};
  for (const [i, key] of (settingsStore?.keys ?? []).entries()) {
    if (!isArkRecord(key)) continue;
    const walletId = (settingsStore!.values[i] as { config?: { walletId?: string } })?.config?.walletId;
    if (!walletId || ark[walletId]) continue;
    // A wallet that never opened its own database here has nothing more to keep than its record. One
    // that has, and cannot be read, stops the backup: a copy without it would not be the whole wallet.
    if (!(await databaseExists(`ghostly-ark-${walletId}`))) continue;
    ark[walletId] = await snapshotArkDatabase(walletId).catch((e: unknown) => Promise.reject(Object.assign(new Error(`Could not read the Ark wallet for the backup: ${e instanceof Error ? e.message : e}`), { cause: e })));
  }

  // Every file with its bytes on this device: its record as it stands (what changed since it was stored read over it).
  let piecesDb: IDBDatabase | null = null;
  const pieces = async () => (piecesDb ??= (await databaseExists(space)) ? await wrap(indexedDB.open(space)) : null);
  try {
    const stateStore = storeOf("fileState");
    const state = new Map((stateStore?.values ?? []).map((value) => [(value as StoredFile).id, value as Partial<StoredFile>]));
    const plain: StoredFile[] = [], carried: { file: StoredFile; source: FileSource }[] = [];
    let skipped = 0;
    for (const value of storeOf("files")?.values ?? []) {
      const record = value as StoredFile;
      // A handoff: every record goes without its bytes, which move as parts of their own (the taker points it at them).
      if (handoff) { const { blob: _blob, bytes: _bytes, ...rest } = record ?? {} as StoredFile; plain.push(rest as StoredFile); continue; }
      const file = { ...record, ...state.get(record?.id) } as StoredFile;
      const source = file?.blob || file?.bytes ? await fileSource(file, space, active, pieces).catch(() => null) : null;
      if (source) { carried.push({ file, source }); progress.bytesTotal += source.size; }
      else {
        // No bytes to carry: the record goes as it is, without a Blob it could not be read from.
        if (record?.blob) { const { blob: _lost, ...rest } = record; plain.push(rest as StoredFile); skipped += 1; } else plain.push(record);
      }
      if (signal?.aborted) break;
    }
    const carriedIds = new Set(carried.map(({ file }) => file.id));
    progress.filesTotal = carried.length;
    progress.stage = "writing";
    tell();

    const name = storedProfileName(active ? currentProfile().id : id!) ?? "Profile";
    const put = async (record: BackupRecord) => writer.json(await encode(record));
    await put({ t: "profile", format: "ghostly-profile", version: 2, createdAt: Date.now(), profile: { name, builtIn: isBuiltInName(name) }, storage, files: carried.length, bytes: progress.bytesTotal });
    // Right after the head: a restore reads it before it writes anything (`openProfileBackup`).
    if (devices) await put({ t: "devices", ...devices });
    if (peer) {
      await put({ t: "db", db: "peer", version: peer.version, stores: peer.stores.map(({ keys: _keys, values: _values, ...shape }) => shape) });
      // Settings and chats first: a restore reads them before anything else, to tell whose profile this is.
      const order = [...peer.stores].sort((a, b) => Number(b.name === "settings") - Number(a.name === "settings") || Number(b.name === "links") - Number(a.name === "links"));
      for (const store of order) {
        let { keys, values } = store;
        if (store.name === "files") { values = plain; keys = plain.map((file) => file.id); }
        // What changed about a file whose record carries it already goes with the record.
        if (store.name === "fileState") { const kept = values.map((value, i) => [keys[i], value] as const).filter(([, value]) => !carriedIds.has((value as StoredFile)?.id)); keys = kept.map(([key]) => key); values = kept.map(([, value]) => value); }
        // Where a file's bytes are is the giver's: the taker says where it put them.
        if (store.name === "fileState" && handoff) values = values.map((value) => { const { bytes: _bytes, ...rest } = (value ?? {}) as Partial<StoredFile>; return rest; });
        for (let at = 0; at < values.length; at += ROWS_PER_RECORD) await put({ t: "rows", db: "peer", store: store.name, keys: keys.slice(at, at + ROWS_PER_RECORD), values: values.slice(at, at + ROWS_PER_RECORD) });
      }
    }
    for (const [walletId, snapshot] of Object.entries(ark)) await put({ t: "ark", walletId, snapshot });

    let files = 0, fileBytes = 0;
    for (const { file, source } of carried) {
      const { blob, bytes: _where, ...row } = file;
      await put({ t: "file", row: row as StoredFile, size: source.size, type: blob?.type ?? file.metadata?.mime ?? "" });
      let ok = true, done = 0;
      while (done < source.size) {
        let part: Uint8Array;
        try {
          part = await source.read(done, Math.min(FILE_BYTES_STEP, source.size - done));
          if (!part.length) throw new Error("The file is shorter than it says");
        } catch (error) {
          // A file this device can no longer read (WebKit can lose a stored Blob) is left out, not the whole backup.
          if (isCancelled(error) || signal?.aborted) throw error;
          ok = false;
          progress.bytes += source.size - done;
          break;
        }
        // A piece that cannot be written (no room left where the bundle is made) is another matter: it stops the
        // backup. Left out and gone on from, the bundle would miss a frame, and would never open again.
        await writer.bytes(part);
        done += part.length;
        progress.bytes += part.length;
        tell();
      }
      await put({ t: "file-end", ok });
      if (ok) { files += 1; fileBytes += source.size; } else skipped += 1;
      progress.files += 1;
      tell();
    }
    await put({ t: "end", files, bytes: fileBytes });
    return { bytes: await writer.finish(), files, fileBytes, skipped };
  } finally {
    (piecesDb as IDBDatabase | null)?.close();
  }
}

/**
 * What a bundle carries of a profile's device set (WISP 06 § A backup restored where a device set exists): the secret,
 * the set and the turn, and the takeover count, never the device signing key, the stored packet or the state of this
 * device. Null for a profile with no device set, and where the device state cannot be read.
 */
async function bundleDevicesOf(database: string): Promise<BundleDevices | null> {
  const record = await readDeviceRecord(database).catch(() => null);
  if (!record?.d) return null;
  return { d: record.d, set: record.deviceSet.map((slot) => slot && { key: slot.key, name: slot.name }), turn: record.turn, takeovers: record.takeovers };
}

/** `writeProfileBackup` into memory: for a profile small enough to hold whole (tests, a bundle sent to S3). */
export async function createProfileBackup(passphrase: string | null, id?: string, lockPassword?: string, run: BackupRun = {}): Promise<Uint8Array> {
  const sink = memorySink();
  await writeProfileBackup(sink, { passphrase, id, lockPassword, ...run });
  return sink.bytes();
}

const isQuotaError = (error: unknown) => (error as { name?: string })?.name === "QuotaExceededError";

/** Takes away what a failed restore wrote: its databases, its files and every local key of its namespace. */
async function undoRestore(ns: string, databases: string[], files = false): Promise<void> {
  for (const name of databases) {
    await new Promise<void>((resolve) => { try { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); } });
  }
  if (files) await dropFileSpace(`ghostly_${ns}`).catch(() => {});
  const prefix = `ghostly_${ns}_`;
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(prefix));
  for (const key of keys) { try { localStorage.removeItem(key); } catch { /* nothing more to do */ } }
}

/**
 * The file a profile's backup downloads as, named after the profile: its letters and digits in any script kept
 * ("仕事", "Trabalho-é"), everything else (spaces, punctuation, direction marks) a dash. A name with none left is "profile".
 */
export function backupFileName(profileName: string): string {
  const base = profileName.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return `${base || "profile"}.ghostly-backup`;
}

/** A bundle as it is handed over: a picked file, its bytes, or (version 1 only) its text. */
export type BackupInput = Blob | Uint8Array | string | BackupSource;
const sourceOf = (input: BackupInput): BackupSource =>
  typeof input === "string" ? bytesSource(new TextEncoder().encode(input)) : input instanceof Uint8Array ? bytesSource(input) : typeof Blob !== "undefined" && input instanceof Blob ? blobSource(input) : (input as BackupSource);

/** Whether a bundle is sealed with a passphrase or was made without one, read from its clear header alone. */
export const backupProtectionOf = (input: BackupInput): Promise<"passphrase" | "none"> => backupProtection(sourceOf(input));

/** A bundle opened (with its passphrase when it has one) and checked, not restored yet. */
export interface OpenedProfileBackup {
  readonly name: string;
  /** `none`: the file was not encrypted; anyone who had it could read it. */
  readonly protection: "passphrase" | "none";
  /** The profile's name and local keys, as the restore will write them. */
  readonly payload: ProfileHead;
  /** A version 1 bundle: all of it. */
  readonly whole?: ProfilePayload;
  /** A version 2 bundle: where to read it again from, and what tells whose profile it is. */
  readonly stream?: { source: BackupSource; passphrase?: string; links: unknown[]; did: unknown };
  /** The device set the bundle carries (WISP 06), when the profile had one. */
  readonly devices?: BundleDevices;
  /** The profile's password proof verifier, when it has one: a restored copy that takes over checks the lock password with it. */
  readonly verifier?: { v: 1; setup: string; record: string };
}

const NOT_A_PROFILE = "This backup does not hold a profile";
const DAMAGED = "This backup is damaged: it was changed or cut short";
const isHead = (value: Partial<ProfileHead> | null | undefined) => typeof value?.profile?.name === "string" && !!value.storage && typeof value.storage === "object";

/** Opens a bundle (with its passphrase when it has one), without writing anything. Throws when it is not a profile's. */
export async function openProfileBackup(input: BackupInput, passphrase?: string, { signal, onProgress }: BackupRun = {}): Promise<OpenedProfileBackup> {
  const source = sourceOf(input);
  onProgress?.({ stage: "opening", files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0 });
  const reader = await BackupReader.open(source, passphrase, signal);
  if (!reader) {
    // Version 1: one JSON document, read whole.
    if (source.size > MAX_BACKUP_BYTES * 1.4) throw new Error("This backup is too large to restore");
    const payload = decode(await open(new TextDecoder().decode(await source.read(0, source.size)), passphrase ?? "")) as ProfilePayload;
    if (payload?.format !== "ghostly-profile" || payload.version !== 1 || !isHead(payload) || !payload.databases) throw new Error(NOT_A_PROFILE);
    return { name: payload.profile.name, protection: "passphrase", payload, whole: payload };
  }
  const first = await reader.next();
  const head = first?.json === undefined ? null : (decode(first.json) as BackupRecord);
  if (head?.t !== "profile" || head.format !== "ghostly-profile" || !isHead(head)) throw new Error(NOT_A_PROFILE);
  if (head.version !== 2) throw new Error("This backup comes from a newer Ghostly; update to restore it");
  // The chats and the DID come right after: enough to tell whose profile this is before anything is written.
  const links: unknown[] = [];
  let did: unknown;
  let devices: BundleDevices | undefined;
  let verifier: OpenedProfileBackup["verifier"];
  for (let record = await reader.next(); record?.json !== undefined; record = await reader.next()) {
    const value = decode(record.json) as BackupRecord;
    if (value?.t === "db") continue;
    if (value?.t === "devices") {
      // A device set this build cannot read is refused, never restored as a profile of one device (WISP 06).
      const { t: _t, ...rest } = value;
      if (!isBundleDevices(rest)) throw new Error(DAMAGED);
      devices = rest;
      continue;
    }
    if (value?.t !== "rows" || (value.store !== "settings" && value.store !== "links")) break;
    if (value.store === "links") links.push(...value.values);
    else {
      const at = value.keys.findIndex((key) => key === "profileDid"); if (at >= 0) did = value.values[at];
      const proof = value.keys.findIndex((key) => key === "handoffVerifier");
      const found = proof >= 0 ? value.values[proof] as { v?: unknown; setup?: unknown; record?: unknown } : null;
      if (found && found.v === 1 && typeof found.setup === "string" && typeof found.record === "string") verifier = { v: 1, setup: found.setup, record: found.record };
    }
  }
  // The envelope of a bundle with a device set: without its record, it is not read as a profile of one device.
  if ((await readBackupHeader(source))?.header.version === DEVICE_SET_BACKUP_VERSION && !devices) throw new Error(DAMAGED);
  return { name: head.profile.name, protection: reader.protection, payload: { profile: head.profile, storage: head.storage }, stream: { source, passphrase, links, did }, ...(devices ? { devices } : {}), ...(verifier ? { verifier } : {}) };
}

/**
 * The profiles of this device that the bundle is a copy of: those sharing a chat key or the DID key with it (WISP 05
 * § Restoring on the same device). A copy restored beside one of them would answer its contacts as the same person.
 * Every profile is compared, a locked one too; only its name is shown.
 */
export async function sameIdentityProfiles(opened: OpenedProfileBackup): Promise<ProfileEntry[]> {
  let links: readonly unknown[], did: unknown;
  if (opened.stream) ({ links, did } = opened.stream);
  else {
    const peer = opened.whole?.databases.peer;
    const valuesOf = (name: string) => peer?.stores.find((store) => store.name === name);
    const settings = valuesOf("settings");
    const didAt = settings?.keys.findIndex((key) => key === "profileDid") ?? -1;
    links = valuesOf("links")?.values ?? [];
    did = didAt >= 0 ? settings!.values[didAt] : undefined;
  }
  const theirs = identityKeysOf(links, did);
  if (!theirs.size) return [];
  const found: ProfileEntry[] = [];
  for (const entry of listProfiles()) {
    const ours = await profileIdentityKeys(entry.id).catch(() => new Set<string>());
    if ([...ours].some((key) => theirs.has(key))) found.push(entry);
  }
  return found;
}

/**
 * The seed of the DID key a bundle carries, from which the profile's first device-set secret derives (WISP 06 § Terms),
 * or null when it carries none or it cannot be opened.
 */
export async function bundleDidSeed(opened: OpenedProfileBackup): Promise<Uint8Array | null> {
  let did: unknown;
  if (opened.stream) did = opened.stream.did;
  else {
    const settings = opened.whole?.databases.peer?.stores.find((store) => store.name === "settings");
    const at = settings?.keys.findIndex((key) => key === "profileDid") ?? -1;
    did = at >= 0 ? settings!.values[at] : undefined;
  }
  const seed = (did as { seed?: { sealed?: unknown; deviceKey?: unknown } } | undefined)?.seed;
  if (!seed || typeof seed.sealed !== "object" || typeof seed.deviceKey !== "string") return null;
  try {
    const text = await unsealSeed(seed.sealed as Parameters<typeof unsealSeed>[0], seed.deviceKey);
    const bytes = fromBase64Url(text);
    return bytes.length === 32 ? bytes : null;
  } catch { return null; }
}

/** The language the profile in a bundle was set to: its settings', or English, which an app with none set runs in. */
function languageOf(storage: Record<string, string>): string | undefined {
  try {
    const language = (JSON.parse(storage.app_settings ?? "{}") as { language?: unknown } | null)?.language;
    return typeof language === "string" ? language : undefined;
  } catch { return undefined; }
}

/**
 * Brings a bundle back as a new profile of this space, and returns it. Nothing existing is replaced.
 * Ark wallet databases move to fresh ids; unfinished payment attempts are kept as unknown.
 */
export async function restoreProfileBackup(input: BackupInput, passphrase?: string, run: BackupRun = {}): Promise<ProfileEntry> {
  return restoreOpenedBackup(await openProfileBackup(input, passphrase, run), run);
}

// Fedimint client databases are files of this origin, not in the bundle: every federation gets a new file name,
// which the wallet finds missing and fills by joining again with the mnemonic (the federation's recovery).
const freshFedimint = (value: unknown) => {
  const record = value as { database?: unknown; federations?: { database?: unknown }[] };
  const renamed = (f: { database?: unknown }) => typeof f?.database === "string" ? { ...f, database: `ghostly-fedimint-${crypto.randomUUID()}.db` } : f;
  return Array.isArray(record?.federations) ? { ...record, federations: record.federations.map(renamed) } : typeof record?.database === "string" ? renamed(record) : value;
};

/**
 * A store's rows as a restore writes them. Every Ark and Bark wallet gets a new id (`fresh`), with or without a copy of
 * its database: a restored profile must never share a database with the one it was copied from, which may still be on
 * this device. A Bark wallet's is never in the bundle: under its new id it starts empty and the server's recovery scan
 * fills it from the phrase, as a restore of a Bark backup does.
 */
function restoredRows(store: string, keys: IDBValidKey[], values: unknown[], fresh: (walletId: string) => string, handoff = false): unknown[] {
  if (store === "settings") {
    return values.map((value, i) => {
      const record = value as { config?: { walletId?: unknown } };
      const walletId = record?.config?.walletId;
      if (typeof keys[i] === "string" && (keys[i] as string).startsWith("fedimint")) return freshFedimint(value);
      return hasOwnDatabase(keys[i]) && typeof walletId === "string" ? { ...record, config: { ...record.config, walletId: fresh(walletId) } } : value;
    });
  }
  // A handoff moves payment attempts as they are: the device that had them was alive and settled its own business.
  if (store === "paymentIntents" && !handoff) {
    // An older copy cannot prove an unfinished attempt was never sent; it may not authorize a new one.
    return values.map((value) => {
      const intent = value as { review?: { state?: string } };
      return intent?.review && ["pending", "submitted", "unknown"].includes(intent.review.state ?? "") ? { ...intent, review: { ...intent.review, state: "unknown" } } : value;
    });
  }
  return values;
}

/** Writes the local keys and lists the profile: last, so an interrupted restore leaves no half-made profile in the list. */
function register(id: string, ns: string, { profile, storage }: ProfileHead): ProfileEntry {
  for (const [suffix, value] of Object.entries(storage)) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(suffix)) continue;
    localStorage.setItem(`ghostly_${ns}_${suffix}`, value);
  }
  // Its name as it was, marked restored: the app says "(restored)" in its language, which a name written here would
  // not follow. Only a name the bundle marks as the built-in one follows the language; one made before the marker is
  // read by its own language.
  const { name, builtIn } = profile;
  return registerProfile(id, name, true, typeof builtIn === "boolean" ? builtIn : builtInNameBefore(name, languageOf(storage)));
}

/** `restoreProfileBackup` of a bundle already opened (after `sameIdentityProfiles` was asked, say). */
export async function restoreOpenedBackup(opened: OpenedProfileBackup, run: BackupRun = {}, beforeRegister?: (database: string) => Promise<void>): Promise<ProfileEntry> {
  const id = newProfileId(), ns = namespaceOf(id);
  // What this restore has written so far: a restore that fails or is cancelled takes all of it away again, so a device
  // short of room is not left holding an unlisted copy of the profile (its keys included) that nothing would ever delete.
  const made: string[] = [];
  const state: RestoreState = { files: false, db: null, writing: null };
  const walletIds = new Map<string, string>();
  const fresh = (walletId: string) => walletIds.get(walletId) ?? (walletIds.set(walletId, crypto.randomUUID()), walletIds.get(walletId)!);
  try {
    if (opened.stream) await restoreStream(opened.stream, ns, made, state, fresh, walletIds, run);
    else await restoreWhole(opened.whole!, ns, made, fresh, walletIds);
    state.db?.close();
    state.db = null;
    // The copy is older state: its counters are raised before its engine first starts (WISP 06 § Raised counters), or
    // its first messages in a group are dropped where the profile sent since the backup was made.
    await markRestoreRaise(`ghostly_${ns}`, opened.devices?.takeovers ?? 0);
    // What must be true of the copy before it is listed (a takeover's standby record): a crash before this leaves an
    // unlisted copy, never a listed one that starts as a profile on one device.
    if (beforeRegister) await beforeRegister(`ghostly_${ns}`);
    return register(id, ns, opened.payload);
  } catch (error) {
    // The file it was in the middle of is let go first: file storage does not remove a folder with a file still open
    // in it (the origin-private file system refuses), and the half-written file would stay on the device for good.
    await state.writing?.discard().catch(() => {});
    state.db?.close();
    await undoRestore(ns, made, state.files);
    throw isQuotaError(error) ? Object.assign(new Error("This device has no room left for this backup. Free some space, then try again."), { cause: error }) : error;
  }
}

/** Notes in a restored profile's database the raise its engine makes at its first start (`devices/raise.ts`). */
async function markRestoreRaise(database: string, takeovers: number): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The restored profile did not open"));
  });
  try {
    if (!db.objectStoreNames.contains("settings")) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put(pendingRaise("restore", takeovers), PENDING_RAISE_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The restored profile could not be saved"));
    });
  } finally { db.close(); }
}

/**
 * The part `db/peer` of a handoff written into a staging namespace (WISP 06 § Installing the staged state): its
 * database and its local keys, and nothing on the list of profiles (pointing the profile at it is the install's).
 * Wallet databases arrive under new ids, as a restore does; payment attempts move as they are. Throws, and takes away
 * what it wrote, when the part is damaged.
 */
export async function restoreHandoffBundle(bundle: Uint8Array, ns: string): Promise<void> {
  const opened = await openProfileBackup(bundle);
  if (!opened.stream) throw new Error(NOT_A_PROFILE);
  const made: string[] = [];
  const state: RestoreState = { files: false, db: null, writing: null };
  const walletIds = new Map<string, string>();
  const fresh = (walletId: string) => walletIds.get(walletId) ?? (walletIds.set(walletId, crypto.randomUUID()), walletIds.get(walletId)!);
  try {
    await restoreStream(opened.stream, ns, made, state, fresh, walletIds, {}, true);
    state.db?.close();
    state.db = null;
    for (const [suffix, value] of Object.entries(opened.payload.storage)) {
      if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(suffix)) continue;
      localStorage.setItem(`ghostly_${ns}_${suffix}`, value);
    }
  } catch (error) {
    state.db?.close();
    for (const name of made) await new Promise<void>((resolve) => { try { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); } });
    throw isQuotaError(error) ? Object.assign(new Error("This device has no room left for this profile."), { cause: error }) : error;
  }
}

/** A version 1 bundle: every store written in one go. */
async function restoreWhole(payload: ProfilePayload, ns: string, made: string[], fresh: (walletId: string) => string, walletIds: Map<string, string>): Promise<void> {
  const ark = payload.databases.ark ?? {};
  const peer = payload.databases.peer;
  for (const store of peer?.stores ?? []) store.values = restoredRows(store.name, store.keys, store.values, fresh);
  for (const [oldId, id] of walletIds) {
    if (!Object.prototype.hasOwnProperty.call(ark, oldId)) continue;
    await restoreArkDatabase(id, ark[oldId]);
    made.push(`ghostly-ark-${id}`);
  }
  if (peer) {
    await restoreDatabase(`ghostly_${ns}`, peer);
    made.push(`ghostly_${ns}`);
  }
}

/** Where a restored file's bytes go when it is too large to keep as a Blob: this device's file storage, in the new profile's space. */
interface LargeFile { kind: FileBytesKind; append(bytes: Uint8Array): Promise<void>; close(): Promise<void>; discard(): Promise<void> }

async function largeFile(id: string, space: string, db: IDBDatabase): Promise<LargeFile> {
  const backend: FileBytes = await fileBytes();
  const store = backend.forSpace?.(space);
  if (store) {
    let offset = 0;
    await store.remove(id);
    return { kind: backend.kind, append: async (bytes) => { await store.append(id, offset, bytes); offset += bytes.length; }, close: () => store.close(id), discard: () => store.remove(id).catch(() => {}) };
  }
  // Pieces in the new profile's own database, as `fileBytesIdb.ts` keeps them: every piece but the last a full step.
  const buffer = new Uint8Array(FILE_BYTES_STEP);
  let held = 0, index = 0;
  const flush = async () => { if (held) { await putRows(db, "fileChunks", [[id, index]], [{ id, index, length: held, data: new Blob([buffer.slice(0, held)]) }]); index += 1; held = 0; } };
  return {
    kind: backend.kind,
    append: async (bytes) => {
      for (let at = 0; at < bytes.length;) {
        const take = Math.min(FILE_BYTES_STEP - held, bytes.length - at);
        buffer.set(bytes.subarray(at, at + take), held);
        held += take; at += take;
        if (held === FILE_BYTES_STEP) await flush();
      }
    },
    close: flush,
    discard: async () => { held = 0; await wrap(db.transaction("fileChunks", "readwrite").objectStore("fileChunks").delete(IDBKeyRange.bound([id, 0], [id, Infinity]))).catch(() => {}); },
  };
}

/** What a restore under way holds: whether it wrote to file storage, its database, and the large file it is writing now. */
interface RestoreState { files: boolean; db: IDBDatabase | null; writing: LargeFile | null }

/** A version 2 bundle: read record by record, each written as it comes. */
async function restoreStream(stream: NonNullable<OpenedProfileBackup["stream"]>, ns: string, made: string[], state: RestoreState, fresh: (walletId: string) => string, walletIds: Map<string, string>, { signal, onProgress }: BackupRun, handoff = false): Promise<void> {
  const space = `ghostly_${ns}`;
  const reader = await BackupReader.open(stream.source, stream.passphrase, signal);
  if (!reader) throw new Error(NOT_A_PROFILE);
  const progress: BackupProgress = { stage: "restoring", files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0 };
  const tell = () => onProgress?.({ ...progress });
  let file: { row: StoredFile; size: number; type: string; got: number; parts: Uint8Array[]; large: LargeFile | null } | null = null;
  let ended: { files: number; bytes: number } | null = null, restored = 0, restoredBytes = 0, started = false;
  const database = () => { if (!state.db) throw new Error(DAMAGED); return state.db; };

  for (let record = await reader.next(); record; record = await reader.next()) {
    if (ended) throw new Error(DAMAGED);
    if (record.bytes) {
      if (!file || file.got + record.bytes.length > file.size) throw new Error(DAMAGED);
      if (file.large) await file.large.append(record.bytes); else file.parts.push(record.bytes);
      file.got += record.bytes.length;
      progress.bytes += record.bytes.length;
      tell();
      continue;
    }
    const value = decode(record.json) as BackupRecord;
    if (file && value?.t !== "file-end") throw new Error(DAMAGED);
    if (!started && value?.t !== "profile") throw new Error(NOT_A_PROFILE);
    switch (value?.t) {
      case "profile":
        if (started) throw new Error(DAMAGED);
        started = true;
        progress.filesTotal = Number(value.files) || 0;
        progress.bytesTotal = Number(value.bytes) || 0;
        tell();
        break;
      case "db":
        if (state.db || value.db !== "peer") throw new Error(DAMAGED);
        state.db = await createDatabase(space, value.version, value.stores);
        made.push(space);
        break;
      case "rows":
        await putRows(database(), value.store, value.keys, restoredRows(value.store, value.keys, value.values, fresh, handoff));
        break;
      case "ark": {
        // Only a wallet the profile's records name is brought back, under the id those records were given.
        const moved = walletIds.get(value.walletId);
        if (!moved) break;
        await restoreArkDatabase(moved, value.snapshot);
        made.push(`ghostly-ark-${moved}`);
        break;
      }
      case "file": {
        const row = value.row;
        if (!row || typeof row.id !== "string" || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error(DAMAGED);
        checkFileId(row.id);
        const large = value.size > SMALL_FILE_BYTES ? await largeFile(row.id, space, database()) : null;
        if (large) { state.files = true; state.writing = large; }
        file = { row, size: value.size, type: typeof value.type === "string" ? value.type : "", got: 0, parts: [], large };
        break;
      }
      case "file-end": {
        if (!file) throw new Error(DAMAGED);
        const { blob: _blob, bytes: _bytes, ...row } = file.row;
        if (value.ok && file.got === file.size) {
          if (file.large) { await file.large.close(); state.writing = null; await putRows(database(), "files", [row.id], [{ ...row, bytes: file.large.kind }]); }
          else await putRows(database(), "files", [row.id], [{ ...row, blob: new Blob(file.parts as BlobPart[], { type: file.type }) }]);
          restored += 1;
          restoredBytes += file.size;
        } else if (value.ok) throw new Error(DAMAGED);
        else {
          // The device that made the backup could not read this file: its record comes back, its bytes do not.
          await file.large?.discard();
          state.writing = null;
          await putRows(database(), "files", [row.id], [row]);
          progress.bytes += file.size - file.got;
        }
        file = null;
        progress.files += 1;
        tell();
        break;
      }
      case "end":
        progress.stage = "verifying";
        tell();
        ended = { files: Number(value.files), bytes: Number(value.bytes) };
        break;
      default:
        // A record a newer version added: nothing this one knows how to write.
        break;
    }
  }
  // The reader has seen the final marker. What came back is what the bundle said it holds.
  if (!started || file || !ended || ended.files !== restored || ended.bytes !== restoredBytes) throw new Error(DAMAGED);
}
