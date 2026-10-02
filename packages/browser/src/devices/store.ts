import { amend, parseDeviceRecord, stricter, transition, type DevicePatch, type DeviceRecord, type DeviceState, type StoredDeviceState } from "./state";

/*
 * The device state database (WISP 06 § Durable device state): `ghostly-devices`, apart from every profile's own
 * database, one record per profile. It decides whether a profile may run on this device at all, so:
 *
 * - every write asks for strict durability and waits for the transaction to complete;
 * - it is the only thing read before the engine starts (`gate.ts`), and a record that cannot be read stops the start;
 * - on Desktop the same record also goes to a file that Rust fsyncs (`setDeviceMirror`), and a read takes the stricter
 *   of the two.
 *
 * A profile with no record is `single`. Nothing writes a record yet: enrollment, the handoff, the takeover and removal
 * (later parts of the WISP) are what will, all through `enrollDevice`, `moveDevice` and `amendDevice` below.
 */

export const DEVICES_DB = "ghostly-devices";
/** The schema of the device state database itself. A database stored at a higher one is a newer build's: nothing starts. */
export const DEVICES_DB_VERSION = 1;
const STORE = "devices";

/**
 * A second, fsynced home for the record: Desktop's file, written by a Rust command. `read` answers the stored JSON or
 * null; `write` stores it (null removes it) and returns only once it is on disk.
 */
export interface DeviceMirror {
  read(profile: string): Promise<string | null>;
  write(profile: string, record: string | null): Promise<void>;
}
let mirror: DeviceMirror | null = null;
/** Before the first read. Desktop sets its file; the web app and the extension have none. */
export function setDeviceMirror(next: DeviceMirror | null): void {
  mirror = next;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDevicesDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICES_DB, DEVICES_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "profile" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another context wants to change the schema: let it, and open again on the next use.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = (event) => { event.preventDefault?.(); reject(request.error ?? new Error("The device state database did not open")); };
    request.onblocked = () => reject(new Error("The device state database is held open by another window at an older version"));
  }).catch((error: unknown) => { dbPromise = null; throw error; });
  return dbPromise;
}

/** Closes the connection (tests, and before the database is deleted). */
export async function closeDevicesDb(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  if (open) (await open.catch(() => null))?.close();
}

/** Whether the last write was made with strict durability. False where the engine does not know the option (an old WebView). */
let lastWriteStrict = false;
export const lastDeviceWriteWasStrict = (): boolean => lastWriteStrict;

async function readLocal(profile: string): Promise<DeviceRecord | null> {
  const db = await openDevicesDb();
  const stored = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(profile);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return stored === undefined ? null : parseDeviceRecord(stored);
}

/** One strict transaction: `work` queues its requests, and the promise settles when the transaction has completed. */
async function strictWrite(work: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDevicesDb();
  const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
  lastWriteStrict = tx.durability === "strict";
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The device state could not be saved"));
    try { work(tx.objectStore(STORE)); } catch (error) { try { tx.abort(); } catch { /* already over */ } reject(error); }
  });
}

/**
 * The profile's record, or null for a `single` profile. With a mirror, the stricter of the two copies, and the other
 * copy is brought in line. Throws when either copy cannot be read or is not valid: the caller must then start nothing.
 */
export async function readDeviceRecord(profile: string): Promise<DeviceRecord | null> {
  const local = await readLocal(profile);
  if (!mirror) return local;
  const text = await mirror.read(profile);
  const filed = text === null ? null : parseDeviceRecord(JSON.parse(text));
  if (filed && filed.profile !== profile) throw new Error("The device state file belongs to another profile");
  const winner = stricter(local, filed);
  if (winner && (JSON.stringify(local) !== JSON.stringify(winner) || JSON.stringify(filed) !== JSON.stringify(winner))) await writeDeviceRecord(winner);
  return winner;
}

/** The state alone. `single` when there is no record. */
export async function deviceStateOf(profile: string): Promise<DeviceState> {
  return (await readDeviceRecord(profile))?.state ?? "single";
}

/**
 * Stores a record as it is, durably: the file first (Desktop), then the database. No check of the change of state:
 * `enrollDevice`, `moveDevice` and `amendDevice` are the ways to change a record; this is under them, and what a test
 * uses to put a profile in a state directly.
 */
export async function writeDeviceRecord(record: DeviceRecord): Promise<void> {
  const valid = parseDeviceRecord(record);
  if (mirror) await mirror.write(valid.profile, JSON.stringify(valid));
  await strictWrite((store) => { store.put(valid); });
}

/** A `single` profile gets its first record: `active` (it enrolled another device, or took over) or `standby` (it was enrolled). */
export async function enrollDevice(profile: string, state: "active" | "standby", patch: DevicePatch = {}): Promise<DeviceRecord> {
  return change(profile, (current) => transition(current, profile, state, patch));
}

/** A legal change of state (see `state.ts`), written durably before it resolves. Throws `DeviceTransitionError` otherwise. */
export async function moveDevice(profile: string, to: StoredDeviceState, patch: DevicePatch = {}): Promise<DeviceRecord> {
  return change(profile, (current) => transition(current, profile, to, patch));
}

/** Fields of the record changed, its state kept. There must be a record. */
export async function amendDevice(profile: string, patch: DevicePatch): Promise<DeviceRecord> {
  return change(profile, (current) => {
    if (!current) throw new Error("This profile has no device set");
    return amend(current, patch);
  });
}

/** One writer at a time per page: a change reads the record, so two at once must not both read the old one. */
let queue: Promise<unknown> = Promise.resolve();

function change(profile: string, next: (current: DeviceRecord | null) => DeviceRecord): Promise<DeviceRecord> {
  const run = queue.catch(() => {}).then(async () => {
    const current = await readDeviceRecord(profile);
    const record = { ...next(current), saved: (current?.saved ?? 0) + 1 };
    await writeDeviceRecord(record);
    return record;
  });
  queue = run;
  return run;
}

/** The profile is gone from this device: its record goes too, from both homes. */
export async function forgetDevice(profile: string): Promise<void> {
  if (mirror) await mirror.write(profile, null);
  await strictWrite((store) => { store.delete(profile); });
}
