import { amend, parseDeviceRecord, stricter, transition, runsEngine, type DevicePatch, type DeviceRecord, type DeviceState, type StoredDeviceState } from "./state";

/*
 * The device state database (WISP 06 § Durable device state): `ghostly-devices`, apart from every profile's own
 * database, one record per profile. It decides whether a profile may run on this device at all, so:
 *
 * - every write asks for strict durability and waits for the transaction to complete;
 * - it is the only thing read before the engine starts (`gate.ts`);
 * - on Desktop the same record also goes to a file that Rust fsyncs (`setDeviceMirror`), and a read takes the stricter
 *   of the two.
 *
 * A profile with no record is `single`, and a read never makes the database: only a write does. So a device where no
 * profile was ever enrolled has no `ghostly-devices` database at all, and nothing about this file can keep such a
 * profile from starting. The rule for a read that fails is: closed only when there is evidence of a device set (the
 * database exists, or Desktop's file holds a record); with none, the profile is `single`.
 *
 * Nothing writes a record yet: enrollment, the handoff, the takeover and removal (later parts of the WISP) are what
 * will, all through `enrollDevice`, `moveDevice` and `amendDevice` below. Those are the only ways to change a record.
 */

export const DEVICES_DB = "ghostly-devices";
/** The schema of the device state database itself. A database stored at a higher one is a newer build's: nothing starts. */
export const DEVICES_DB_VERSION = 1;
const STORE = "devices";

/**
 * How long a read may take. `existsMs`: to learn whether the database exists at all; past it there is no evidence of
 * a device set, and the profile is `single`. `readMs`: to read a database that does exist, or Desktop's file; past
 * it the state is unreadable.
 */
export const DEVICE_READ_TIMINGS = { existsMs: 2_000, readMs: 8_000 };

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

/** The read did not finish in time (`DEVICE_READ_TIMINGS`). */
export class DeviceReadTimeout extends Error {
  constructor(what: string) {
    super(`${what} did not answer in time`);
    this.name = "DeviceReadTimeout";
  }
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeviceReadTimeout(what)), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Opens the database, making it when it is not there: for a write, or for a read once it is known to exist. */
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
  // An open that never answered is not waited for: it is closed if it ever does.
  if (open) await Promise.race([open.then((db) => db.close(), () => {}), new Promise<void>((resolve) => setTimeout(resolve, 50))]);
}

/**
 * Whether the device state database exists, without making it. Where the browser cannot list its databases, an open
 * that names no version tells: it would make the database, and that is undone before it happens. Anything that goes
 * wrong here, a timeout included, is no evidence of a device set: false.
 */
async function devicesDbExists(): Promise<boolean> {
  if (dbPromise) return true;
  const probe = async (): Promise<boolean> => {
    if (typeof indexedDB.databases === "function") return (await indexedDB.databases()).some((d) => d.name === DEVICES_DB);
    return new Promise<boolean>((resolve) => {
      const request = indexedDB.open(DEVICES_DB);
      let made = false;
      request.onupgradeneeded = () => { made = true; try { request.transaction?.abort(); } catch { /* already over */ } };
      request.onsuccess = () => { request.result.close(); resolve(!made); };
      request.onerror = (event) => { event.preventDefault?.(); resolve(false); };
      request.onblocked = () => resolve(true);
    });
  };
  try { return await within(probe(), DEVICE_READ_TIMINGS.existsMs, "The list of databases"); } catch { return false; }
}

/** Whether the last write was made with strict durability. False where the engine does not know the option (an old WebView). */
let lastWriteStrict = false;
export const lastDeviceWriteWasStrict = (): boolean => lastWriteStrict;

/** The record in the database: null when there is no database or no record; throws when what is there cannot be read. */
async function readLocal(profile: string): Promise<DeviceRecord | null> {
  if (!(await devicesDbExists())) return null;
  const read = async (): Promise<unknown> => {
    const db = await openDevicesDb();
    if (!db.objectStoreNames.contains(STORE)) throw new Error("The device state database has no records store");
    return new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(profile);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  const stored = await within(read(), DEVICE_READ_TIMINGS.readMs, "The device state database");
  return stored === undefined ? null : parseDeviceRecord(stored);
}

/**
 * Stores `record` in one strict transaction, only if what is stored still has the write count `expected` (null: no
 * record). The check and the write are one transaction, so two pages or documents cannot both write over the same
 * record. Resolves once the transaction has completed.
 */
async function swap(profile: string, expected: number | null, record: DeviceRecord | null): Promise<void> {
  const db = await openDevicesDb();
  const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
  lastWriteStrict = tx.durability === "strict";
  await new Promise<void>((resolve, reject) => {
    let refused: Error | null = null;
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(refused ?? tx.error ?? new Error("The device state could not be saved"));
    const store = tx.objectStore(STORE);
    const current = store.get(profile);
    current.onsuccess = () => {
      const now = current.result as { saved?: unknown } | undefined;
      const found = now === undefined ? null : typeof now.saved === "number" ? now.saved : NaN;
      if (found !== expected) {
        refused = new Error("The device state changed in another window. Nothing was written.");
        try { tx.abort(); } catch { /* already over */ }
        return;
      }
      if (record) store.put(record); else store.delete(profile);
    };
  });
}

/** A file that is there and is not this profile's record: evidence of a device set that cannot be read. */
class DeviceFileInvalid extends Error {}

/** The file's record: null when it holds none. */
async function readMirror(profile: string): Promise<DeviceRecord | null> {
  const text = await within(mirror!.read(profile), DEVICE_READ_TIMINGS.readMs, "The device state file");
  if (text === null) return null;
  let filed: DeviceRecord;
  try { filed = parseDeviceRecord(JSON.parse(text)); } catch (error) { throw new DeviceFileInvalid(error instanceof Error ? error.message : String(error)); }
  if (filed.profile !== profile) throw new DeviceFileInvalid("The device state file belongs to another profile");
  return filed;
}

/**
 * The profile's record, or null for a `single` profile. With a mirror, the stricter of the two copies, and the other
 * copy is brought in line. Throws when there is evidence of a device set that cannot be read: the caller must then
 * start nothing. With no such evidence (no database, and no file that says otherwise) the answer is null.
 */
export async function readDeviceRecord(profile: string): Promise<DeviceRecord | null> {
  if (!mirror) return readLocal(profile);
  let local: DeviceRecord | null = null, localError: unknown = null;
  try { local = await readLocal(profile); } catch (error) { localError = error; }
  let filed: DeviceRecord | null = null, fileError: unknown = null;
  try { filed = await readMirror(profile); } catch (error) { fileError = error; }
  // The database exists and cannot be read. A file that stops the engine is believed; otherwise unreadable.
  if (localError) { if (filed && !runsEngine(filed.state)) return filed; throw localError; }
  // The file cannot be read. A record that stops the engine is believed. A file that is there and is not a record
  // is evidence of a device set: unreadable. Otherwise (the folder or the command is unavailable): with no record in
  // the database there is no evidence of one, so `single`; with an `active` one the file may be stricter: unreadable.
  if (fileError) {
    if (local && !runsEngine(local.state)) return local;
    if (!local && !(fileError instanceof DeviceFileInvalid)) return null;
    throw fileError;
  }
  return reconcile(profile, local, filed);
}

async function reconcile(profile: string, local: DeviceRecord | null, filed: DeviceRecord | null): Promise<DeviceRecord | null> {
  const winner = stricter(local, filed);
  if (!winner) return null;
  const same = (a: DeviceRecord | null) => JSON.stringify(a) === JSON.stringify(winner);
  if (!same(filed)) await mirror!.write(profile, JSON.stringify(winner));
  if (!same(local)) await swap(profile, local ? local.saved : null, winner);
  return winner;
}

/** The state alone. `single` when there is no record. */
export async function deviceStateOf(profile: string): Promise<DeviceState> {
  return (await readDeviceRecord(profile))?.state ?? "single";
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

/** One writer at a time in this page; across pages and documents, the Web Lock below and the check inside `swap`. */
let queue: Promise<unknown> = Promise.resolve();
const WRITE_LOCK = "ghostly-devices-write";

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const run = queue.catch(() => {}).then(() => (locks && typeof locks.request === "function" ? locks.request(WRITE_LOCK, work) as Promise<T> : work()));
  queue = run;
  return run;
}

/**
 * Reads the record, checks the change, and writes: the file first (Desktop), then the database, in a transaction
 * that also checks nobody else wrote meanwhile. A crash between the two leaves the newer record in the file, which
 * the next read takes when it is the stricter one.
 */
function change(profile: string, next: (current: DeviceRecord | null) => DeviceRecord): Promise<DeviceRecord> {
  return exclusive(async () => {
    const current = await readDeviceRecord(profile);
    const record = parseDeviceRecord({ ...next(current), saved: (current?.saved ?? 0) + 1 });
    if (mirror) await mirror.write(profile, JSON.stringify(record));
    await swap(profile, current ? current.saved : null, record);
    return record;
  });
}

/** The profile is gone from this device: its record goes too, from both homes. Makes no database where there is none. */
export async function forgetDevice(profile: string): Promise<void> {
  await exclusive(async () => {
    if (mirror) await mirror.write(profile, null);
    if (!(await devicesDbExists())) return;
    const db = await openDevicesDb();
    const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The device state could not be removed"));
      tx.objectStore(STORE).delete(profile);
    });
  });
}
