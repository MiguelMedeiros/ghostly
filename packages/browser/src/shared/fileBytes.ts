import { sha256 } from "@noble/hashes/sha2.js";
import { databaseName } from "./idb";
import { digestText } from "./fileBytesCommon";

/**
 * Where the bytes of a file live when they may be more than memory holds: a file sent or received in a chat.
 * Every implementation keeps one file per id under the profile's space (`databaseName()`), is written in
 * order (`append` at the stored size, `truncate` to go back), and is read in ranges, so no caller ever needs
 * the whole file at once.
 *
 * - `opfs`: the origin-private file system, written by a worker with sync access handles (web, extension).
 * - `native`: a real file in the app's data folder, through Rust (Desktop).
 * - `idb`: 1 MiB records in IndexedDB, where neither of those exists (and in tests).
 */
export interface FileBytes {
  readonly kind: FileBytesKind;
  /** Copies a picked file in, hashing it on the way. Resolves to its SHA-256, base64url. */
  stage(id: string, source: Blob, onProgress?: (copied: number) => void): Promise<string>;
  /** Writes at `offset`, which must be the stored size. Resolves once written; `flush` makes it durable. */
  append(id: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** What was appended so far survives a crash. */
  flush(id: string): Promise<void>;
  /** Writing is over for now: flushed, and the file let go so it can be read elsewhere. */
  close(id: string): Promise<void>;
  /** Bytes stored, or null when there is no such file. */
  size(id: string): Promise<number | null>;
  /** Cuts the file to `size` bytes (a transfer going back to its last durable point). */
  truncate(id: string, size: number): Promise<void>;
  /** At most `length` bytes from `offset`; fewer only at the end of the file. */
  read(id: string, offset: number, length: number): Promise<Uint8Array>;
  /** SHA-256 of what is stored, base64url: read back from storage, so it checks what was written. */
  digest(id: string): Promise<string>;
  /**
   * The file as a Blob to show or save, backed by storage rather than memory, or null where this platform
   * cannot hand one out (Desktop, above `NATIVE_BLOB_MAX`: saved with `save` instead).
   */
  blob(id: string, type: string): Promise<Blob | null>;
  remove(id: string): Promise<void>;
  /** Removes every file whose id starts with `prefix` ("" for all of this space). */
  removeWhere(prefix: string): Promise<void>;
  /** Bytes this device can still take for files, or null when the platform does not say. */
  room(): Promise<number | null>;
  /** Saves a copy where the person chooses, where the platform has a dialog for it. False when they cancelled. */
  save?(id: string, name: string): Promise<boolean>;
  /** Removes another profile's folder (a deleted profile). IndexedDB pieces go with the profile's database. */
  dropSpace?(space: string): Promise<void>;
}

export type FileBytesKind = "opfs" | "native" | "idb";

/** Files sent from memory-sized sources stay whole in IndexedDB; anything larger goes through a `FileBytes`. */
export const SMALL_FILE_BYTES = 16 * 1024 * 1024;

export { FILE_BYTES_STEP, digestText } from "./fileBytesCommon";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const SPACE = /^[A-Za-z0-9_.-]{1,100}$/;

/** A file id every backend accepts as a file name as it is: never a path. */
export function checkFileId(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid file id");
  return id;
}

/** This profile's folder name. */
export function fileSpace(): string {
  const space = databaseName();
  if (!SPACE.test(space)) throw new Error("Invalid profile space");
  return space;
}

/** SHA-256 of a Blob, read as a stream: memory stays at one read. */
export async function blobDigest(blob: Blob, onProgress?: (done: number) => void): Promise<string> {
  const hash = sha256.create();
  let done = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    hash.update(value);
    done += value.length;
    onProgress?.(done);
  }
  return digestText(hash.digest());
}

type Maker = () => Promise<FileBytes | null>;
const makers = new Map<FileBytesKind, Maker>([
  ["opfs", () => import("./fileBytesOpfs").then((m) => m.OpfsFileBytes.open())],
  ["idb", () => import("./fileBytesIdb").then((m) => new m.IdbFileBytes())],
]);
const made = new Map<FileBytesKind, Promise<FileBytes | null>>();
let preferred: FileBytesKind[] = ["opfs", "idb"];

/** How a backend is made. The platform registers its own (Desktop: `native`) before anything uses it. */
export function registerFileBytes(kind: FileBytesKind, make: Maker, prefer = false): void {
  makers.set(kind, make);
  made.delete(kind);
  if (prefer) preferred = [kind, ...preferred.filter((k) => k !== kind)];
}

/** The backend of this kind, or null where this platform has none. */
export function fileBytesOf(kind: FileBytesKind): Promise<FileBytes | null> {
  let backend = made.get(kind);
  if (!backend) {
    const make = makers.get(kind);
    backend = make ? make().catch(() => null) : Promise.resolve(null);
    made.set(kind, backend);
  }
  return backend;
}

/** Where new files go: the first backend this platform has. */
export async function fileBytes(): Promise<FileBytes> {
  for (const kind of preferred) {
    const backend = await fileBytesOf(kind);
    if (backend) return backend;
  }
  throw new Error("This device has no storage for files");
}

/** "Clear all data" and a deleted chat: the bytes of its files go with it, wherever they are. */
export async function removeFileBytes(prefix = ""): Promise<void> {
  await Promise.all([...makers.keys()].map(async (kind) => (await fileBytesOf(kind))?.removeWhere(prefix)));
}

/** A deleted profile's files, wherever they are. */
export async function dropFileSpace(space: string): Promise<void> {
  if (!SPACE.test(space)) throw new Error("Invalid profile space");
  await Promise.all([...makers.keys()].map(async (kind) => (await fileBytesOf(kind))?.dropSpace?.(space)));
}

/** Tests: forget what was made and which backend comes first. */
export function resetFileBytes(order: FileBytesKind[] = ["opfs", "idb"]): void {
  made.clear();
  preferred = order;
}
