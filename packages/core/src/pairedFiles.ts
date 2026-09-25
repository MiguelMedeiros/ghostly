import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, toBase64Url } from "./bytes";
import { LIMITS, type FrameChannel } from "./frames";
import { sanitizeFileName, sanitizeMime, type FileInfo, type FileSink, type FileTransferEvents } from "./files";
import { parseVoiceMeta } from "./voice";

const CHUNK = 16 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
interface Incoming {
  file: FileInfo;
  sink: FileSink | null;
  stored?: string;
  hash: ReturnType<typeof sha256.create>;
  offset: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface Pending { resolve(): void; reject(error: Error): void; }

/** files/2: authenticated text frames work on RTC, Iroh and HyperDHT alike.
 * Stop-and-wait credits bound each sender to one 16 KiB chunk in flight.
 * Final receipt follows digest verification and durable sink.close, never merely send(). */
export class PairedFiles {
  private incoming = new Map<string, Incoming>();
  private outgoing = new Set<string>();
  private pending = new Map<string, Pending>();
  private closed = false;
  constructor(private channel: FrameChannel, private events: FileTransferEvents & {
    onStored?(file: FileInfo): Promise<string | undefined>;
  }) {}

  private sendFrame(frame: object): void {
    if (this.closed) throw new Error("Connection lost");
    this.channel.send(JSON.stringify(frame));
  }

  private exchange(id: string, offset: number, phase: string, frame: object): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("File transfer timed out")), LIMITS.bodyIdleTimeoutMs);
      const key = `${id}:${phase}:${offset}`;
      const finish = (error?: Error) => {
        clearTimeout(timer); this.pending.delete(key);
        if (error) reject(error); else resolve();
      };
      this.pending.set(key, { resolve: () => finish(), reject: finish });
      try { this.sendFrame(frame); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  async send(file: FileInfo, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.closed || !ID.test(file.id) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.maxFileBytes)
      throw new Error("Invalid file or connection closed");
    if (this.outgoing.has(file.id) || this.outgoing.size >= LIMITS.maxIncomingFilesPerPeer) throw new Error("File transfer already active");
    this.outgoing.add(file.id);
    try {
      await this.exchange(file.id, 0, "start", { t: "pf-start", ...file, name: sanitizeFileName(file.name), mime: sanitizeMime(file.mime), voice: parseVoiceMeta(file.voice, sanitizeMime(file.mime)) });
      const hash = sha256.create();
      let offset = 0;
      for await (const part of source) {
        for (let pos = 0; pos < part.length; pos += CHUNK) {
          const chunk = part.subarray(pos, pos + CHUNK);
          if (offset + chunk.length > file.size) throw new Error("File changed during transfer");
          hash.update(chunk);
          await this.exchange(file.id, offset + chunk.length, "chunk", { t: "pf-chunk", id: file.id, offset, data: toBase64Url(chunk) });
          offset += chunk.length;
          this.events.onProgress?.(file.id, offset, "out");
        }
      }
      if (offset !== file.size) throw new Error("Incomplete file");
      await this.exchange(file.id, offset, "end", { t: "pf-end", id: file.id, offset, digest: toBase64Url(hash.digest()) });
      this.events.onComplete?.(file.id, "out");
    } catch (error) {
      try { this.sendFrame({ t: "pf-cancel", id: file.id, target: "receiver" }); } catch { /* disconnected */ }
      this.events.onFailed?.(file.id, error instanceof Error ? error.message : String(error), "out");
      throw error;
    } finally { this.outgoing.delete(file.id); }
  }

  async handle(frame: Record<string, unknown>): Promise<void> {
    if (this.closed || typeof frame.id !== "string" || !ID.test(frame.id)) return;
    const id = frame.id;
    if (frame.t === "pf-ack") {
      if (Number.isSafeInteger(frame.offset) && ["start", "chunk", "end"].includes(String(frame.phase)))
        this.pending.get(`${id}:${frame.phase}:${frame.offset}`)?.resolve();
      return;
    }
    if (frame.t === "pf-cancel") {
      if (frame.target === "receiver") this.fail(id, "Cancelled by sender", false);
      if (frame.target === "sender") for (const [key, pending] of this.pending)
        if (key.startsWith(`${id}:`)) pending.reject(new Error("Peer refused or could not store the file"));
      return;
    }
    try {
      if (frame.t === "pf-start") {
        if (this.incoming.has(id)) throw new Error("Duplicate active file");
        if (typeof frame.name !== "string" || frame.name.length > 1000 || typeof frame.mime !== "string" || frame.mime.length > 130 ||
          typeof frame.size !== "number" || !Number.isSafeInteger(frame.size) || frame.size < 0 || frame.size > LIMITS.maxFileBytes ||
          typeof frame.timestamp !== "number" || !Number.isSafeInteger(frame.timestamp) || frame.timestamp <= 0 ||
          this.incoming.size >= LIMITS.maxIncomingFilesPerPeer) throw new Error("Invalid file announcement");
        const file: FileInfo = { id, name: sanitizeFileName(frame.name), mime: sanitizeMime(frame.mime), size: frame.size, timestamp: frame.timestamp };
        // A description that does not check out only costs the player: the file itself is fine.
        const voice = parseVoiceMeta(frame.voice, file.mime);
        if (voice) file.voice = voice;
        const stored = await this.events.onStored?.(file);
        if (this.closed) return;
        const sink = stored ? null : this.events.onIncoming(file);
        if (!stored && (!sink || typeof sink === "string")) throw new Error(typeof sink === "string" ? sink : "File refused");
        const entry: Incoming = { file, sink: sink as FileSink | null, stored, hash: sha256.create(), offset: 0 };
        this.incoming.set(id, entry); this.arm(id, entry);
        this.sendFrame({ t: "pf-ack", id, phase: "start", offset: 0 });
        return;
      }
      const entry = this.incoming.get(id);
      if (!entry) return;
      if (frame.offset !== entry.offset) throw new Error("Invalid file offset");
      if (frame.t === "pf-chunk") {
        if (typeof frame.data !== "string" || frame.data.length > Math.ceil(CHUNK * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(frame.data)) throw new Error("Invalid chunk");
        const bytes = fromBase64Url(frame.data);
        if (!bytes.length || bytes.length > CHUNK || entry.offset + bytes.length > entry.file.size) throw new Error("Invalid chunk size");
        entry.hash.update(bytes);
        await entry.sink?.write(bytes);
        if (this.incoming.get(id) !== entry) return;
        entry.offset += bytes.length;
        this.arm(id, entry);
        this.events.onProgress?.(id, entry.offset, "in");
        this.sendFrame({ t: "pf-ack", id, phase: "chunk", offset: entry.offset });
      } else if (frame.t === "pf-end") {
        const digest = toBase64Url(entry.hash.digest());
        if (entry.offset !== entry.file.size || frame.digest !== digest || (entry.stored && entry.stored !== digest)) throw new Error("File integrity check failed");
        await entry.sink?.close(digest);
        if (this.incoming.get(id) !== entry) return;
        clearTimeout(entry.timer); this.incoming.delete(id);
        if (!entry.stored) this.events.onComplete?.(id, "in");
        this.sendFrame({ t: "pf-ack", id, phase: "end", offset: entry.offset });
      }
    } catch (error) { this.fail(id, error instanceof Error ? error.message : String(error), true); }
  }

  private arm(id: string, entry: Incoming): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.fail(id, "File transfer stalled", true), LIMITS.bodyIdleTimeoutMs);
  }
  private fail(id: string, reason: string, notify: boolean): void {
    const entry = this.incoming.get(id);
    if (entry) {
      clearTimeout(entry.timer); this.incoming.delete(id); entry.sink?.abort();
      if (!entry.stored) this.events.onFailed?.(id, reason, "in");
    }
    if (notify) try { this.sendFrame({ t: "pf-cancel", id, target: "sender" }); } catch { /* disconnected */ }
  }
  closeAll(): void {
    this.closed = true;
    for (const id of this.incoming.keys()) this.fail(id, "Connection lost", false);
    for (const pending of this.pending.values()) pending.reject(new Error("Connection lost"));
  }
}
