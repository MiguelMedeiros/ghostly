import {
  CHUNK_KIND,
  LIMITS,
  encodeControl,
  sendBody,
  type ChunkFrame,
  type FileFrame,
  type FrameChannel,
  type ResetFrame,
} from "./frames";
import { PLAYABLE_AUDIO, type VoiceMeta } from "./voice";

/**
 * Files over the data link. A `file` frame announces name, size and type, the
 * bytes follow as chunks, and the receiver only keeps the file if exactly the
 * announced number of bytes arrived. Nothing touches Pkarr: files go peer to
 * peer or not at all.
 */
export interface FileInfo {
  /** Chosen by the sender. */
  id: string;
  name: string;
  size: number;
  mime: string;
  timestamp: number;
  /** A voice message: its length and the shape of its sound (files/2 and held items only). */
  voice?: VoiceMeta;
}

/** Where a platform puts incoming bytes: memory, IndexedDB, disk. */
export interface FileSink {
  write(chunk: Uint8Array): void | Promise<void>;
  close(digest?: string): void | Promise<void>;
  abort(): void;
}

export interface FileTransferEvents {
  /** Return a sink to accept the file, null to refuse it, or the reason for refusing it. */
  onIncoming(file: FileInfo): FileSink | string | null;
  onProgress?(fileId: string, transferred: number, direction: "in" | "out"): void;
  onComplete?(fileId: string, direction: "in" | "out"): void;
  onFailed?(fileId: string, reason: string, direction: "in" | "out"): void;
}

const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;
const MAX_NAME_LENGTH = 200;

/**
 * Invisible and direction-changing characters: bidi overrides turn
 * "invoice\u202Efdp.exe" into what reads as "invoiceexe.pdf", zero-width ones hide
 * text. Cf covers both; line and paragraph separators break the layout.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A file name is display text and a download suggestion, never a path. */
export function sanitizeFileName(name: string): string {
  const visible = name.replace(INVISIBLE, "").replace(/[/\\:]/g, "");
  // Whitespace before the dots must not hide them: " .bashrc" is a dotfile too.
  const clean = [...visible.replace(/^[\s.]+/, "")].slice(0, MAX_NAME_LENGTH).join("").trim();
  return clean || "file";
}

export function sanitizeMime(mime: string): string {
  return MIME.test(mime) ? mime.toLowerCase() : "application/octet-stream";
}

/** Raster images a UI may show inline. SVG is left out on purpose: it can carry scripts. */
export const PREVIEWABLE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

/**
 * The type received bytes are served with. The peer picks the announced type,
 * and a blob: URL typed text/html or image/svg+xml would run in the app's
 * origin, so anything but a previewable image or playable audio is opaque bytes.
 * Audio keeps its type because WebKit will not play what is typed as bytes.
 */
export function safeBlobType(mime: string): string {
  const clean = sanitizeMime(mime);
  return PREVIEWABLE_IMAGE.test(clean) || PLAYABLE_AUDIO.test(clean) ? clean : "application/octet-stream";
}

interface Incoming {
  file: FileInfo;
  sink: FileSink;
  received: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Writes are chained so a slow sink cannot reorder chunks. */
  queue: Promise<void>;
}

export class FileTransfers {
  private nextStreamId = 1;
  private readonly incoming = new Map<number, Incoming>();
  private readonly outgoing = new Map<number, { fileId: string; cancelled: boolean }>();

  constructor(
    private readonly channel: FrameChannel,
    private readonly events: FileTransferEvents,
  ) {}

  /** Streams a file to the peer. Resolves once every byte is handed to the channel. */
  async send(file: FileInfo, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (file.size > LIMITS.maxFileBytes) throw new Error("File is too large");
    const id = this.nextStreamId++;
    const state = { fileId: file.id, cancelled: false };
    this.outgoing.set(id, state);

    try {
      this.channel.send(
        encodeControl({
          t: "file",
          id,
          f: file.id,
          ts: file.timestamp,
          n: sanitizeFileName(file.name),
          s: file.size,
          m: sanitizeMime(file.mime),
        }),
      );
      let sent = 0;
      const counted = async function* (this: FileTransfers) {
        for await (const part of source) {
          sent += part.length;
          yield part;
          this.events.onProgress?.(file.id, sent, "out");
        }
      }.call(this);
      await sendBody(this.channel, CHUNK_KIND.fileBody, id, counted, () => state.cancelled);
      if (state.cancelled) throw new Error("The peer refused the file");
      if (sent !== file.size) throw new Error("File changed while it was being sent");
      this.events.onComplete?.(file.id, "out");
    } catch (error) {
      if (!state.cancelled) {
        try {
          this.channel.send(encodeControl({ t: "rst", id, d: "f", e: "aborted" }));
        } catch {
          // channel already closed
        }
      }
      this.events.onFailed?.(file.id, error instanceof Error ? error.message : String(error), "out");
      throw error;
    } finally {
      this.outgoing.delete(id);
    }
  }

  handleFile(frame: FileFrame): void {
    if (this.incoming.has(frame.id)) return;
    const refuse = (reason: string) => {
      try {
        this.channel.send(encodeControl({ t: "rst", id: frame.id, d: "f", e: reason }));
      } catch {
        // channel already closed
      }
    };
    if (!FILE_ID.test(frame.f)) return refuse("invalid file id");
    if (frame.s > LIMITS.maxFileBytes) return refuse("file too large");
    if (this.incoming.size >= LIMITS.maxIncomingFilesPerPeer) return refuse("too many transfers");

    const file: FileInfo = {
      id: frame.f,
      name: sanitizeFileName(frame.n),
      size: frame.s,
      mime: sanitizeMime(frame.m),
      timestamp: frame.ts,
    };
    const sink = this.events.onIncoming(file);
    if (!sink || typeof sink === "string") return refuse(sink || "refused");

    const entry: Incoming = { file, sink, received: 0, queue: Promise.resolve() };
    this.incoming.set(frame.id, entry);
    this.armIdleTimer(frame.id, entry);
  }

  handleChunk(chunk: ChunkFrame): void {
    const entry = this.incoming.get(chunk.id);
    if (!entry) return;

    entry.received += chunk.payload.length;
    if (entry.received > entry.file.size) return this.failIncoming(chunk.id, "more data than announced", true);

    if (chunk.payload.length > 0) {
      const payload = chunk.payload.slice();
      entry.queue = entry.queue.then(() => entry.sink.write(payload));
      this.events.onProgress?.(entry.file.id, entry.received, "in");
    }
    if (!chunk.end) return this.armIdleTimer(chunk.id, entry);

    if (entry.received !== entry.file.size) return this.failIncoming(chunk.id, "incomplete file", false);
    clearTimeout(entry.idleTimer);
    this.incoming.delete(chunk.id);
    entry.queue
      .then(() => entry.sink.close())
      .then(
        () => this.events.onComplete?.(entry.file.id, "in"),
        () => {
          entry.sink.abort();
          this.events.onFailed?.(entry.file.id, "could not store the file", "in");
        },
      );
  }

  handleReset(frame: ResetFrame): void {
    if (this.incoming.has(frame.id)) this.failIncoming(frame.id, frame.e || "cancelled by the sender", false);
    const sending = this.outgoing.get(frame.id);
    if (sending) sending.cancelled = true;
  }

  /** The link went away: nothing in flight can finish. */
  closeAll(): void {
    for (const id of [...this.incoming.keys()]) this.failIncoming(id, "connection lost", false);
    for (const sending of this.outgoing.values()) sending.cancelled = true;
  }

  private armIdleTimer(id: number, entry: Incoming): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.failIncoming(id, "transfer stalled", true), LIMITS.bodyIdleTimeoutMs);
  }

  private failIncoming(id: number, reason: string, notifyPeer: boolean): void {
    const entry = this.incoming.get(id);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    this.incoming.delete(id);
    entry.sink.abort();
    if (notifyPeer) {
      try {
        this.channel.send(encodeControl({ t: "rst", id, d: "f", e: reason }));
      } catch {
        // channel already closed
      }
    }
    this.events.onFailed?.(entry.file.id, reason, "in");
  }
}
