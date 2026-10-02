import { fromBase64Url, toBase64Url } from "./codec";

/**
 * A backup written and read a piece at a time (WISP 05, envelope version 2), so a profile with years of files never
 * has to fit in memory. The file is one line of clear JSON (the header), then frames:
 *
 *   header line:  {"format":"ghostly-backup","version":2,"protection":"passphrase"|"none",...}\n
 *   frame:        kind (1 byte) | length (4 bytes, big endian) | body
 *
 * A frame carries one record: a piece of JSON (gzip or plain) or a piece of a file's bytes, at most `FRAME_BYTES`
 * of them. The last frame is the final marker; a file that ends without it was cut short and is refused.
 *
 * - `passphrase`: the key comes from the passphrase as in version 1 (PBKDF2-SHA256, 600 000 rounds, 16 byte salt).
 *   Every frame is sealed alone with AES-256-GCM: its nonce is the header's 7 random bytes, the frame's number
 *   (4 bytes) and its kind (1 byte), and the SHA-256 of the header line is its associated data. A frame changed,
 *   moved, dropped or retyped, a changed header, or a missing final marker fails to open.
 * - `none`: nothing is encrypted. A SHA-256 chain runs over the header line and every frame, and the final marker
 *   holds its last value, so a damaged or cut file is refused. It proves nothing about who made the file.
 */
export const FRAME_BYTES = 1024 * 1024;
/** No frame is larger than this: a reader refuses one that says it is, before reading it. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** One piece of JSON, decompressed: past it the backup is refused, not read. */
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const ITERATIONS = 600_000;
const TAG_BYTES = 16;

const KIND = { gzipJson: 1, json: 2, bytes: 3, final: 255 } as const;

export interface BackupHeader {
  format: "ghostly-backup";
  version: 2;
  protection: "passphrase" | "none";
  kdf?: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher?: { name: "AES-256-GCM"; nonce: string };
  check?: { name: "SHA-256-chain" };
}

/** Where a backup is written: in order, a piece at a time. */
export interface BackupSink { write(bytes: Uint8Array): Promise<void> }
/** Where a backup is read from: any range, so nothing is read before it is needed. */
export interface BackupSource { readonly size: number; read(offset: number, length: number): Promise<Uint8Array> }
/** One record of a backup: JSON text, or a piece of the bytes of the file the JSON before it announced. */
export type BackupRecord = { json: string; bytes?: undefined } | { bytes: Uint8Array; json?: undefined };

/** Thrown when the work was cancelled (`AbortSignal`): nothing is wrong with the backup. */
export class BackupCancelled extends Error {
  constructor() { super("Cancelled"); this.name = "AbortError"; }
}
export const isCancelled = (error: unknown) => (error as { name?: string })?.name === "AbortError";
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new BackupCancelled(); };

/** A Blob (a picked file) as a source, read in slices: never `stream()`, which WebKit fails on for some stored Blobs. */
export const blobSource = (blob: Blob): BackupSource => ({ size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) });
export const bytesSource = (bytes: Uint8Array): BackupSource => ({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
/** A sink that keeps what is written (tests, and a backup small enough to hand over whole). */
export function memorySink(): BackupSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: async (bytes) => { parts.push(bytes.slice()); },
    bytes: () => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; },
  };
}

const canCompress = () => typeof CompressionStream !== "undefined";
async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.length;
    if (size > limit) { await reader.cancel(); throw new Error("This backup is too large to restore"); }
    chunks.push(next.value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await crypto.subtle.digest("SHA-256", join(parts) as BufferSource));
function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function prefix(kind: number, length: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, length);
  return out;
}
function nonce(base: Uint8Array, frame: number, kind: number): Uint8Array {
  const out = new Uint8Array(12);
  out.set(base, 0);
  new DataView(out.buffer).setUint32(7, frame);
  out[11] = kind;
  return out;
}

/** Writes a backup: `json` and `bytes` in the order they are to be read, then `finish`. */
export class BackupWriter {
  private frame = 0;
  /** Bytes handed to the sink so far. */
  written = 0;
  private finished = false;
  /** Set once the sink refused a frame: the error it gave, thrown again at every later write. */
  private failed: { error: unknown } | null = null;

  private constructor(private readonly sink: BackupSink, private readonly key: CryptoKey | null, private readonly base: Uint8Array, private chain: Uint8Array, private readonly signal?: AbortSignal) {}

  /** `passphrase` null: a backup anyone can read (the caller has made sure that is what the person chose). */
  static async start(sink: BackupSink, passphrase: string | null, signal?: AbortSignal): Promise<BackupWriter> {
    if (passphrase !== null && passphrase.length < 12) throw new Error("Use at least 12 characters for the backup passphrase");
    check(signal);
    const salt = crypto.getRandomValues(new Uint8Array(16)), base = crypto.getRandomValues(new Uint8Array(7));
    const header: BackupHeader = passphrase === null
      ? { format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } }
      : { format: "ghostly-backup", version: 2, protection: "passphrase", kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toBase64Url(salt) }, cipher: { name: "AES-256-GCM", nonce: toBase64Url(base) } };
    const line = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
    const key = passphrase === null ? null : await keyFrom(passphrase, salt, ITERATIONS);
    const writer = new BackupWriter(sink, key, base, await sha256(line), signal);
    await sink.write(line);
    writer.written = line.length;
    return writer;
  }

  private async put(kind: number, plain: Uint8Array): Promise<void> {
    check(this.signal);
    if (this.failed) throw this.failed.error;
    if (this.finished) throw new Error("This backup is already finished");
    if (this.frame >= 0xffffffff) throw new Error("This backup is too large");
    // What a reader refuses is not written: found out now, not when the backup is needed.
    if (plain.length > MAX_FRAME_BYTES) throw new Error("A record of this profile is too large for a backup");
    let out: Uint8Array;
    if (this.key) {
      // The header's digest is every frame's associated data: a frame of another backup, or under a changed header, fails.
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(this.base, this.frame, kind) as BufferSource, additionalData: this.chain as BufferSource }, this.key, plain as BufferSource));
      out = join([prefix(kind, sealed.length), sealed]);
    } else {
      const head = prefix(kind, kind === KIND.final ? 32 : plain.length);
      if (kind === KIND.final) out = join([head, this.chain]);
      else { out = join([head, plain]); this.chain = await sha256(this.chain, out); }
    }
    this.frame += 1;
    // A frame the sink did not take (no room left, say) is the end of this backup: every frame after it would be
    // numbered past a gap, and the file would never open. Nothing more is written, whatever the caller does next.
    try { await this.sink.write(out); } catch (error) { this.failed = { error }; throw error; }
    this.written += out.length;
  }

  /** One piece of JSON, compressed where the platform can. */
  async json(text: string): Promise<void> {
    const plain = new TextEncoder().encode(text);
    if (plain.length > MAX_JSON_BYTES) throw new Error("A record of this profile is too large for a backup");
    if (canCompress()) await this.put(KIND.gzipJson, await through(plain, new CompressionStream("gzip")));
    else await this.put(KIND.json, plain);
  }

  /** Bytes of the file the last JSON announced, cut into frames. */
  async bytes(chunk: Uint8Array): Promise<void> {
    for (let at = 0; at < chunk.length; at += FRAME_BYTES) await this.put(KIND.bytes, chunk.subarray(at, Math.min(chunk.length, at + FRAME_BYTES)));
  }

  /** The final marker: without it a reader refuses the backup. Resolves to the size of the whole backup. */
  async finish(): Promise<number> {
    await this.put(KIND.final, new Uint8Array());
    this.finished = true;
    return this.written;
  }
}

/** The first line of a version 2 backup, or null when this is not one (version 1 is one JSON object with no line end). */
export async function readBackupHeader(source: BackupSource): Promise<{ header: BackupHeader; line: Uint8Array } | null> {
  const start = await source.read(0, Math.min(MAX_HEADER_BYTES, source.size));
  const end = start.indexOf(10);
  if (end < 0) return null;
  let header: BackupHeader;
  try { header = JSON.parse(new TextDecoder().decode(start.subarray(0, end))) as BackupHeader; } catch { return null; }
  if (header?.format !== "ghostly-backup" || typeof header.version !== "number" || header.version < 2) return null;
  if (header.version !== 2) throw new Error("This backup comes from a newer Ghostly; update to restore it");
  if (header.protection === "none") {
    if (header.check?.name !== "SHA-256-chain") throw new Error("Unsupported backup format");
  } else if (header.protection === "passphrase") {
    if (header.kdf?.name !== "PBKDF2-SHA256" || !(header.kdf.iterations >= ITERATIONS) || header.kdf.iterations > 10_000_000 || header.cipher?.name !== "AES-256-GCM") throw new Error("Unsupported backup encryption");
  } else throw new Error("Unsupported backup format");
  return { header, line: start.slice(0, end + 1) };
}

/** How a backup is protected, read from its clear header without opening it: version 1 is always sealed. */
export async function backupProtection(source: BackupSource): Promise<"passphrase" | "none"> {
  return (await readBackupHeader(source))?.header.protection ?? "passphrase";
}

const DAMAGED = "This backup is damaged: it was changed or cut short";

/** Reads a version 2 backup record by record. Nothing of a frame is handed out before it passed its check. */
export class BackupReader {
  private frame = 0;
  private at: number;
  private block: Uint8Array = new Uint8Array();
  private blockAt = 0;
  private done = false;

  private constructor(private readonly source: BackupSource, private readonly key: CryptoKey | null, private readonly base: Uint8Array, private chain: Uint8Array, start: number, private readonly signal?: AbortSignal) { this.at = start; }

  get protection(): "passphrase" | "none" { return this.key ? "passphrase" : "none"; }

  /** Null when `source` is not a version 2 backup. `passphrase` is needed, and used, only for a sealed one. */
  static async open(source: BackupSource, passphrase?: string, signal?: AbortSignal): Promise<BackupReader | null> {
    const found = await readBackupHeader(source);
    if (!found) return null;
    check(signal);
    const { header, line } = found;
    if (header.protection === "none") return new BackupReader(source, null, new Uint8Array(), await sha256(line), line.length, signal);
    let key: CryptoKey, base: Uint8Array;
    try {
      base = fromBase64Url(header.cipher!.nonce);
      if (base.length !== 7) throw new Error("nonce");
      key = await keyFrom(passphrase ?? "", fromBase64Url(header.kdf!.salt), header.kdf!.iterations);
    } catch { throw new Error("Unsupported backup encryption"); }
    return new BackupReader(source, key, base, await sha256(line), line.length, signal);
  }

  /** Bytes of the source read so far (for progress). */
  get position(): number { return this.at; }

  /** `length` bytes at the reading point, through a read-ahead block so a source is asked a few times per megabyte, not per frame. */
  private async take(length: number): Promise<Uint8Array> {
    if (this.at + length > this.source.size) throw new Error(DAMAGED);
    const from = this.at - this.blockAt;
    if (from < 0 || from + length > this.block.length) {
      this.block = await this.source.read(this.at, Math.min(this.source.size - this.at, Math.max(length, 4 * FRAME_BYTES)));
      this.blockAt = this.at;
      if (this.block.length < length) throw new Error(DAMAGED);
    }
    const out = this.block.subarray(this.at - this.blockAt, this.at - this.blockAt + length);
    this.at += length;
    return out;
  }

  /** The next record, or null at the end: only then is the backup known to be whole. */
  async next(): Promise<BackupRecord | null> {
    check(this.signal);
    if (this.done) return null;
    const head = await this.take(5);
    const kind = head[0], length = new DataView(head.buffer, head.byteOffset, 5).getUint32(1);
    if (length > MAX_FRAME_BYTES + TAG_BYTES || !Object.values(KIND).includes(kind as never)) throw new Error(DAMAGED);
    const headCopy = head.slice();
    const body = await this.take(length);
    let plain: Uint8Array;
    if (this.key) {
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(this.base, this.frame, kind) as BufferSource, additionalData: this.chain as BufferSource }, this.key, body as BufferSource));
      } catch { throw new Error(this.frame === 0 ? "Wrong passphrase, or the backup was changed" : DAMAGED); }
    } else if (kind === KIND.final) {
      if (body.length !== 32 || body.some((byte, i) => byte !== this.chain[i])) throw new Error(DAMAGED);
      plain = new Uint8Array();
    } else {
      this.chain = await sha256(this.chain, headCopy, body);
      plain = body.slice();
    }
    this.frame += 1;
    if (kind === KIND.final) {
      if (plain.length || this.at !== this.source.size) throw new Error(DAMAGED);
      this.done = true;
      return null;
    }
    if (kind === KIND.bytes) return { bytes: plain };
    const text = kind === KIND.gzipJson ? await through(plain, new DecompressionStream("gzip"), MAX_JSON_BYTES).catch((error: unknown) => { throw error instanceof Error && error.message.startsWith("This backup is too large") ? error : new Error(DAMAGED); }) : plain;
    return { json: new TextDecoder().decode(text) };
  }
}
