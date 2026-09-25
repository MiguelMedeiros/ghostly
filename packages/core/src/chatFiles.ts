import { fromBase64Url, toBase64Url } from "./bytes";
import { formatFileSize, sanitizeFileName, sanitizeMime, type FileInfo } from "./files";
import { parseVoiceMeta } from "./voice";

/**
 * files/3 (WISP 501, revision 0.3): files of any size in a chat, offered before they are sent, sent with
 * many chunks in flight, resumed from the last confirmed byte after a drop, a transport switch or a
 * restart, and checked against the sender's SHA-256 once stored.
 *
 * One `ChatFiles` per chat lives as long as the app does, across sessions: `attach` when a session that
 * agreed `files/3` is open, `detach` when it goes. Records (`FileTransferRecord`) are the state that
 * survives a restart; the host keeps them and hands them back with `restore`.
 *
 * Frames (authenticated JSON on the paired session):
 *
 *   sender → receiver  pf-offer {id,name,mime,size,ts,voice?,paused?}  pf-data {id,offset,data}
 *                      pf-sum {id,size,digest}  pf-abort {id}
 *   receiver → sender  pf-accept {id,offset}  pf-wait {id,why}  pf-got {id,offset}  pf-done {id}
 *                      pf-refuse {id,why,room?}
 *   both               pf-room {max}
 *
 * The offer is repeated on every session until the transfer ends, so every answer is idempotent: the
 * receiver says where it stands (accept from an offset, wait, done, refuse) and the sender goes on from
 * there. Nothing but the offset a receiver confirms moves a sender forward.
 */

export const FILE_LIMITS = {
  /** Bytes in one `pf-data` frame: a frame stays far below the 60 KiB a session carries. */
  chunkBytes: 16 * 1024,
  /** Bytes a sender has sent and not seen confirmed: throughput is this per round trip. */
  windowBytes: 1024 * 1024,
  /** A receiver asks its person before taking a file larger than this. */
  askAboveBytes: 25 * 1024 * 1024,
  /** Files taken without asking, per contact, while stored. Past it, every file is asked about. */
  autoAcceptBytesPerPeer: 500 * 1024 * 1024,
  /** Offers from one contact waiting for an answer here. */
  maxWaitingOffers: 16,
  /** Files one contact sends at once; accepted ones beyond wait their turn. */
  maxActiveIncoming: 3,
  /** An offer nobody answered ends after this long. */
  offerTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** No answer while something is outstanding: the sender offers again, which puts both sides back in step. */
  idleMs: 30_000,
  /** A receiver makes what it stored durable, and records the point to resume from, this often. */
  checkpointBytes: 8 * 1024 * 1024,
  /** A receiver confirms at least this often while writing. */
  ackEveryBytes: 128 * 1024,
  /** A sender reads its file this much at a time. */
  readBytes: 1024 * 1024,
} as const;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const DATA = /^[A-Za-z0-9_-]+$/;

export const FILE_FRAMES = new Set(["pf-offer", "pf-accept", "pf-wait", "pf-data", "pf-got", "pf-sum", "pf-done", "pf-refuse", "pf-abort", "pf-room"]);

export type TransferState =
  /** Out: waiting for a session to offer it on. In: accepted, waiting for its turn or for the sender. */
  | "queued"
  /** Out: offered on this session, no answer yet. */
  | "offered"
  /** Out: the receiver's person has not decided (or it waits its turn there, `waitingFor: "busy"`). In: this person has not decided. */
  | "asking"
  | "active"
  | "paused"
  /** Every byte confirmed; the receiver is checking the digest. */
  | "verifying"
  | "done"
  | "failed"
  | "declined"
  | "cancelled";

export interface FileTransferRecord {
  /** The sender's id, on the wire. */
  id: string;
  direction: "in" | "out";
  file: FileInfo;
  state: TransferState;
  /** Out: bytes the receiver confirmed. In: bytes stored durably, where a restart resumes. */
  confirmed: number;
  /** SHA-256 of the file, base64url: the sender's own, or the one it announced. */
  digest?: string;
  pausedBy?: "me" | "peer";
  /** Out, `asking`: why the receiver waits. */
  waitingFor?: "consent" | "busy";
  error?: string;
  /** When the transfer began (the offer), for its time to live. */
  since: number;
  /** In: the person accepted it (not taken on its own). */
  consented?: boolean;
}

const FINAL: ReadonlySet<TransferState> = new Set(["done", "failed", "declined", "cancelled"]);
export const transferEnded = (record: FileTransferRecord): boolean => FINAL.has(record.state);

/** A file being sent, read in ranges. */
export interface OutgoingSource {
  read(offset: number, length: number): Promise<Uint8Array>;
  /** SHA-256 of the whole file, base64url. */
  digest(): Promise<string>;
}

/** Where a file being received is written, in order, from `offset`. */
export interface IncomingTarget {
  /** Bytes already stored when it was opened: where this transfer resumes. */
  readonly offset: number;
  append(bytes: Uint8Array): Promise<void>;
  /** What was appended is durable. */
  flush(): Promise<void>;
  /** Checks what was stored against the sender's digest, and keeps the file when it matches. */
  verify(digest: string): Promise<boolean>;
  /** Removes what was stored. */
  discard(): Promise<void>;
}

export type OfferDecision = "accept" | "ask" | { refuse: RefuseReason; room?: number };
export type RefuseReason = "declined" | "no-room" | "too-many" | "damaged" | "cancelled" | "expired" | "invalid";

export interface ChatFilesHost {
  /** Sends a frame on the open session; false when there is none. */
  send(frame: Record<string, unknown>): boolean;
  /** A new offer from the contact: take it, ask the person, or refuse it. */
  decide(file: FileInfo): Promise<OfferDecision>;
  openTarget(record: FileTransferRecord): Promise<IncomingTarget>;
  openSource(record: FileTransferRecord): Promise<OutgoingSource>;
  /**
   * Something changed: keep it and show it. `transferred` is what moved so far (confirmed by the receiver when
   * sending, stored when receiving); `progress` says only that moved, so keeping it can wait.
   */
  changed(record: FileTransferRecord, transferred: number, progress: boolean): void;
  /** Bytes a file may still take here, or null when the platform does not say. */
  room?(): Promise<number | null>;
  now?(): number;
}

interface Outgoing {
  source?: Promise<OutgoingSource>;
  next: number;
  /** Bumped whenever sending stops or restarts: a read that finishes late sends nothing. */
  generation: number;
  pumping: boolean;
  block?: { start: number; bytes: Uint8Array };
  timer?: ReturnType<typeof setTimeout>;
}

interface Incoming {
  target?: Promise<IncomingTarget>;
  /** Bytes taken in order (some may still be on their way to storage). */
  written: number;
  stored: number;
  acked: number;
  checkpointed: number;
  gapAt?: number;
  writing: Promise<void>;
  verifying?: boolean;
}

interface Entry {
  record: FileTransferRecord;
  out?: Outgoing;
  in?: Incoming;
}

const key = (direction: "in" | "out", id: string) => `${direction}:${id}`;
const isInt = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** What a refusal means to the sender's person. */
export function refusalText(why: string, room?: number): { state: TransferState; error: string } {
  switch (why) {
    case "declined": return { state: "declined", error: "Declined by your contact" };
    case "cancelled": return { state: "cancelled", error: "Cancelled by your contact" };
    case "no-room": return { state: "failed", error: room !== undefined ? `Not enough space on your contact's device (${formatFileSize(room)} free)` : "Not enough space on your contact's device" };
    case "too-many": return { state: "failed", error: "Your contact has too many files waiting. Try again later." };
    case "damaged": return { state: "failed", error: "The file arrived damaged and was deleted. Send it again." };
    case "expired": return { state: "failed", error: "Not accepted in time" };
    default: return { state: "failed", error: "Your contact could not take this file" };
  }
}

export class ChatFiles {
  private readonly entries = new Map<string, Entry>();
  private attached = false;
  private peerRoomValue: number | null = null;

  constructor(private readonly host: ChatFilesHost) {}

  private now(): number { return this.host.now?.() ?? Date.now(); }

  /** Records kept from before a restart. Nothing is sent until `attach`. */
  restore(records: FileTransferRecord[]): void {
    for (const record of records) {
      const entry: Entry = { record: { ...record } };
      if (record.direction === "out") entry.out = { next: record.confirmed, generation: 0, pumping: false };
      else entry.in = { written: record.confirmed, stored: record.confirmed, acked: record.confirmed, checkpointed: record.confirmed, writing: Promise.resolve() };
      this.entries.set(key(record.direction, record.id), entry);
    }
  }

  get live(): boolean { return this.attached; }
  /** What the contact said it can take, on this session. */
  get peerRoom(): number | null { return this.attached ? this.peerRoomValue : null; }

  records(): FileTransferRecord[] { return [...this.entries.values()].map((e) => ({ ...e.record })); }
  get(direction: "in" | "out", id: string): FileTransferRecord | undefined {
    const record = this.entries.get(key(direction, id))?.record;
    return record && { ...record };
  }
  /** Bytes moved so far: confirmed by the receiver (sending), stored (receiving). */
  transferred(direction: "in" | "out", id: string): number {
    const entry = this.entries.get(key(direction, id));
    return entry ? this.moved(entry) : 0;
  }
  private moved(entry: Entry): number {
    return entry.in && !transferEnded(entry.record) ? Math.max(entry.in.stored, entry.record.confirmed) : entry.record.confirmed;
  }

  private changed(entry: Entry, progress = false): void {
    this.host.changed({ ...entry.record }, this.moved(entry), progress);
  }

  private send(frame: Record<string, unknown>): boolean {
    return this.attached && this.host.send(frame);
  }

  /** A session that agreed files/3 is open: say what fits here, then offer again what is not finished. */
  attach(): void {
    this.attached = true;
    this.peerRoomValue = null;
    void this.sayRoom();
    this.sweep();
    for (const entry of this.entries.values()) {
      if (transferEnded(entry.record)) continue;
      if (entry.record.direction === "out") this.announce(entry);
      else if (entry.record.state === "queued") this.startIncoming(entry);
    }
  }

  /** The session went: nothing moves until the next one. What was received is made durable. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.peerRoomValue = null;
    for (const entry of this.entries.values()) {
      if (entry.out) { entry.out.generation++; clearTimeout(entry.out.timer); entry.out.next = entry.record.confirmed; }
      if (entry.in && !transferEnded(entry.record)) void this.checkpoint(entry);
    }
  }

  /** Offers ended by their time to live. The host calls it now and then; `attach` does too. */
  sweep(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      const { record } = entry;
      if (!["queued", "offered", "asking"].includes(record.state) || record.since + FILE_LIMITS.offerTtlMs > now) continue;
      if (record.direction === "in" && record.state === "queued") continue;
      this.end(entry, "failed", record.direction === "in" ? "The offer expired" : record.state === "queued" ? "Not delivered in time" : "Not accepted in time");
      if (record.direction === "in") this.send({ t: "pf-refuse", id: record.id, why: "expired" });
    }
  }

  private async sayRoom(): Promise<void> {
    const room = await this.host.room?.().catch(() => null);
    if (typeof room === "number" && Number.isSafeInteger(room)) this.send({ t: "pf-room", max: room });
  }

  // ─── Sending ────────────────────────────────────────────────────────────

  /** A new file to send: offered now if a session is open, or on the next one. */
  offer(file: FileInfo, digest?: string): FileTransferRecord {
    if (!ID.test(file.id) || !isInt(file.size)) throw new Error("Invalid file");
    if (this.entries.has(key("out", file.id))) throw new Error("File transfer already active");
    const entry: Entry = {
      record: { id: file.id, direction: "out", file, state: "queued", confirmed: 0, since: this.now(), ...(digest && { digest }) },
      out: { next: 0, generation: 0, pumping: false },
    };
    this.entries.set(key("out", file.id), entry);
    this.changed(entry);
    if (this.attached) this.announce(entry);
    return { ...entry.record };
  }

  private offerFrame(record: FileTransferRecord, paused: boolean): Record<string, unknown> {
    const { file } = record;
    return { t: "pf-offer", id: file.id, name: file.name, mime: file.mime, size: file.size, ts: file.timestamp, ...(file.voice && { voice: file.voice }), ...(paused && { paused: true }) };
  }

  private announce(entry: Entry): void {
    const { record } = entry, out = entry.out!;
    out.generation++;
    out.next = record.confirmed;
    const paused = record.state === "paused" && record.pausedBy === "me";
    if (!this.send(this.offerFrame(record, paused))) return;
    if (!paused && record.state !== "offered") { record.state = "offered"; record.pausedBy = undefined; this.changed(entry); }
    this.armStall(entry);
  }

  private armStall(entry: Entry): void {
    const out = entry.out!;
    clearTimeout(out.timer);
    if (!this.attached || transferEnded(entry.record) || entry.record.state === "paused" || entry.record.state === "asking") return;
    out.timer = setTimeout(() => {
      // Nothing came back: what is on its way was lost (a switch, a drop not seen yet). Offering again resyncs.
      if (this.attached && !transferEnded(entry.record) && entry.record.state !== "paused" && entry.record.state !== "asking") this.announce(entry);
    }, FILE_LIMITS.idleMs);
  }

  private source(entry: Entry): Promise<OutgoingSource> {
    const out = entry.out!;
    out.source ??= this.host.openSource(entry.record);
    out.source.catch(() => { out.source = undefined; });
    return out.source;
  }

  private async chunkAt(entry: Entry, offset: number): Promise<Uint8Array> {
    const out = entry.out!, size = entry.record.file.size;
    const length = Math.min(FILE_LIMITS.chunkBytes, size - offset);
    const block = out.block;
    if (!block || offset < block.start || offset + length > block.start + block.bytes.length) {
      const bytes = await (await this.source(entry)).read(offset, Math.min(FILE_LIMITS.readBytes, size - offset));
      if (!bytes.length) throw new Error("The file is shorter than it says");
      out.block = { start: offset, bytes };
    }
    const at = offset - out.block!.start;
    return out.block!.bytes.subarray(at, at + length);
  }

  private shouldPump(entry: Entry): boolean {
    const { record } = entry, out = entry.out!;
    return this.attached && record.state === "active" && out.next < record.file.size && out.next - record.confirmed < FILE_LIMITS.windowBytes;
  }

  private async pump(entry: Entry): Promise<void> {
    const out = entry.out!;
    if (out.pumping) return;
    out.pumping = true;
    const generation = out.generation;
    try {
      while (this.shouldPump(entry) && generation === out.generation) {
        const offset = out.next;
        const chunk = await this.chunkAt(entry, offset);
        if (generation !== out.generation || !this.shouldPump(entry) || out.next !== offset) break;
        if (!this.send({ t: "pf-data", id: entry.record.id, offset, data: toBase64Url(chunk) })) break;
        out.next = offset + chunk.length;
      }
    } catch (error) {
      this.send({ t: "pf-abort", id: entry.record.id });
      this.end(entry, "failed", `Could not read the file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      out.pumping = false;
      if (this.shouldPump(entry)) void this.pump(entry);
    }
  }

  private async sendSum(entry: Entry): Promise<void> {
    const { record } = entry;
    if (record.state !== "verifying") { record.state = "verifying"; this.changed(entry); }
    try {
      record.digest ??= await (await this.source(entry)).digest();
    } catch (error) {
      this.send({ t: "pf-abort", id: record.id });
      this.end(entry, "failed", `Could not read the file: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (record.state !== "verifying") return;
    this.send({ t: "pf-sum", id: record.id, size: record.file.size, digest: record.digest });
    this.armStall(entry);
  }

  // ─── Receiving ──────────────────────────────────────────────────────────

  private waitingOffers(): number {
    return [...this.entries.values()].filter((e) => e.record.direction === "in" && e.record.state === "asking").length;
  }

  private activeIncoming(except: Entry): number {
    return [...this.entries.values()].filter((e) => e !== except && e.record.direction === "in" && (e.record.state === "active" || e.record.state === "verifying")).length;
  }

  private target(entry: Entry): Promise<IncomingTarget> {
    const incoming = entry.in!;
    if (!incoming.target) {
      incoming.target = this.host.openTarget(entry.record).then((target) => {
        incoming.written = incoming.stored = incoming.acked = incoming.checkpointed = target.offset;
        return target;
      });
      incoming.target.catch(() => { incoming.target = undefined; });
    }
    return incoming.target;
  }

  /** An accepted file goes when a session is open and fewer than three others arrive at once. */
  private startIncoming(entry: Entry): void {
    if (!this.attached || transferEnded(entry.record) || entry.record.state === "asking" || (entry.record.state === "paused" && entry.record.pausedBy === "me")) return;
    if (this.activeIncoming(entry) >= FILE_LIMITS.maxActiveIncoming) {
      if (entry.record.state !== "queued") { entry.record.state = "queued"; this.changed(entry); }
      this.send({ t: "pf-wait", id: entry.record.id, why: "busy" });
      return;
    }
    void this.target(entry).then(() => {
      if (transferEnded(entry.record) || !this.attached) return;
      if (entry.record.state === "paused" && entry.record.pausedBy === "me") return;
      entry.record.state = "active";
      entry.record.pausedBy = undefined;
      entry.in!.gapAt = undefined;
      this.changed(entry);
      this.send({ t: "pf-accept", id: entry.record.id, offset: entry.in!.written });
    }, (error) => {
      this.end(entry, "failed", `Could not store the file: ${error instanceof Error ? error.message : String(error)}`);
      this.send({ t: "pf-refuse", id: entry.record.id, why: "no-room" });
    });
  }

  /** The next file waiting its turn, once one ends. */
  private startNext(): void {
    for (const entry of this.entries.values()) if (entry.record.direction === "in" && entry.record.state === "queued") this.startIncoming(entry);
  }

  private async onOffer(frame: Record<string, unknown>): Promise<void> {
    const id = frame.id as string;
    if (typeof frame.name !== "string" || frame.name.length > 1000 || typeof frame.mime !== "string" || frame.mime.length > 130 ||
      !isInt(frame.size) || !isInt(frame.ts) || frame.ts === 0) { this.send({ t: "pf-refuse", id, why: "invalid" }); return; }
    const file: FileInfo = { id, name: sanitizeFileName(frame.name), mime: sanitizeMime(frame.mime), size: frame.size, timestamp: frame.ts };
    const voice = parseVoiceMeta(frame.voice, file.mime);
    if (voice) file.voice = voice;
    const paused = frame.paused === true;
    const existing = this.entries.get(key("in", id));
    if (existing) {
      const { record } = existing;
      if (record.file.size !== file.size || record.file.name !== file.name) { this.send({ t: "pf-refuse", id, why: "invalid" }); return; }
      switch (record.state) {
        case "done": this.send({ t: "pf-done", id }); return;
        case "declined": this.send({ t: "pf-refuse", id, why: "declined" }); return;
        case "cancelled": this.send({ t: "pf-refuse", id, why: "cancelled" }); return;
        case "failed":
          // Sent again after it failed here (damaged, expired): taken again from the start, as it was agreed.
          await existing.in?.target?.then((t) => t.discard()).catch(() => {});
          existing.in = { written: 0, stored: 0, acked: 0, checkpointed: 0, writing: Promise.resolve() };
          Object.assign(record, { state: "queued", confirmed: 0, error: undefined, digest: undefined, since: this.now() });
          this.changed(existing);
          break;
        case "asking": this.send({ t: "pf-wait", id, why: "consent" }); return;
      }
      if (record.state === "paused" && record.pausedBy === "me") { this.send({ t: "pf-wait", id, why: "paused" }); return; }
      if (paused) {
        if (record.state !== "paused") { record.state = "paused"; record.pausedBy = "peer"; this.changed(existing); void this.checkpoint(existing); }
        return;
      }
      if (record.state === "paused") { record.state = "queued"; record.pausedBy = undefined; this.changed(existing); }
      this.startIncoming(existing);
      return;
    }
    if (this.waitingOffers() >= FILE_LIMITS.maxWaitingOffers) { this.send({ t: "pf-refuse", id, why: "too-many" }); return; }
    let decision: OfferDecision;
    try { decision = await this.host.decide(file); } catch { decision = { refuse: "invalid" }; }
    if (this.entries.has(key("in", id))) return;
    if (typeof decision === "object") { this.send({ t: "pf-refuse", id, why: decision.refuse, ...(decision.room !== undefined && { room: decision.room }) }); return; }
    const entry: Entry = {
      record: { id, direction: "in", file, state: decision === "ask" ? "asking" : paused ? "paused" : "queued", confirmed: 0, since: this.now(), ...(paused && decision !== "ask" && { pausedBy: "peer" as const }) },
      in: { written: 0, stored: 0, acked: 0, checkpointed: 0, writing: Promise.resolve() },
    };
    this.entries.set(key("in", id), entry);
    this.changed(entry);
    if (decision === "ask") this.send({ t: "pf-wait", id, why: "consent" });
    else if (!paused) this.startIncoming(entry);
  }

  private onData(entry: Entry, frame: Record<string, unknown>): void {
    const { record } = entry, incoming = entry.in!;
    if (record.state !== "active" || !incoming.target) return;
    const { offset, data } = frame;
    if (!isInt(offset) || typeof data !== "string" || !data.length || data.length > Math.ceil(FILE_LIMITS.chunkBytes * 4 / 3) || !DATA.test(data)) return;
    if (offset < incoming.written) {
      // Sent again (a resync): already taken. Said again only once everything is stored.
      if (incoming.stored === incoming.written) this.send({ t: "pf-got", id: record.id, offset: incoming.stored });
      return;
    }
    if (offset > incoming.written) {
      // Something before this was lost: once per gap, the sender is told where to go on from.
      if (incoming.gapAt !== incoming.written) { incoming.gapAt = incoming.written; this.send({ t: "pf-accept", id: record.id, offset: incoming.written }); }
      return;
    }
    const bytes = fromBase64Url(data);
    if (!bytes.length || bytes.length > FILE_LIMITS.chunkBytes || offset + bytes.length > record.file.size) return;
    incoming.written += bytes.length;
    const target = incoming.target;
    incoming.writing = incoming.writing.then(async () => {
      if (transferEnded(record)) return;
      await (await target).append(bytes);
      incoming.stored = offset + bytes.length;
      const drained = incoming.stored === incoming.written;
      if (drained || incoming.stored - incoming.acked >= FILE_LIMITS.ackEveryBytes) {
        incoming.acked = incoming.stored;
        this.send({ t: "pf-got", id: record.id, offset: incoming.stored });
        this.changed(entry, true);
      }
      // Inside the chain of writes: waiting for the chain here would wait for itself.
      if (incoming.stored - incoming.checkpointed >= FILE_LIMITS.checkpointBytes) await this.checkpointNow(entry);
    }).catch((error) => {
      if (transferEnded(record)) return;
      this.end(entry, "failed", `Could not store the file: ${error instanceof Error ? error.message : String(error)}`);
      void target.then((t) => t.discard()).catch(() => {});
      this.send({ t: "pf-refuse", id: record.id, why: "no-room" });
      this.startNext();
    });
  }

  /** What was stored is durable, and a restart resumes from there. */
  private async checkpoint(entry: Entry): Promise<void> {
    if (!entry.in?.target) return;
    await entry.in.writing;
    await this.checkpointNow(entry);
  }

  private async checkpointNow(entry: Entry): Promise<void> {
    const incoming = entry.in!;
    if (!incoming.target) return;
    const stored = incoming.stored;
    if (stored === incoming.checkpointed && entry.record.confirmed === stored) return;
    try { await (await incoming.target).flush(); } catch { return; }
    incoming.checkpointed = Math.max(incoming.checkpointed, stored);
    // Kept at once (not as progress): a restart resumes from here.
    if (!transferEnded(entry.record)) { entry.record.confirmed = incoming.checkpointed; this.changed(entry); }
  }

  private async onSum(entry: Entry, frame: Record<string, unknown>): Promise<void> {
    const { record } = entry, incoming = entry.in!;
    if (record.state === "done") { this.send({ t: "pf-done", id: record.id }); return; }
    if (record.state !== "active" || incoming.verifying || !incoming.target) return;
    if (frame.size !== record.file.size || typeof frame.digest !== "string" || !DIGEST.test(frame.digest)) return;
    const digest = frame.digest;
    await incoming.writing;
    if (transferEnded(record) || record.state !== "active") return;
    if (incoming.stored < record.file.size) { this.send({ t: "pf-accept", id: record.id, offset: incoming.stored }); return; }
    incoming.verifying = true;
    record.state = "verifying";
    this.changed(entry);
    let ok: boolean;
    try { const target = await incoming.target; await target.flush(); ok = await target.verify(digest); } catch { ok = false; }
    incoming.verifying = false;
    if (transferEnded(record)) return;
    if (ok) {
      record.digest = digest;
      record.confirmed = record.file.size;
      this.end(entry, "done");
      this.send({ t: "pf-done", id: record.id });
    } else {
      await incoming.target.then((t) => t.discard()).catch(() => {});
      this.end(entry, "failed", "The file arrived damaged and was deleted. Ask for it again.");
      this.send({ t: "pf-refuse", id: record.id, why: "damaged" });
    }
    this.startNext();
  }

  // ─── Frames ─────────────────────────────────────────────────────────────

  /** A frame from the contact (one of `FILE_FRAMES`). Returns quickly: writing goes on in the background. */
  async handle(frame: Record<string, unknown>): Promise<void> {
    if (!this.attached) return;
    if (frame.t === "pf-room") { if (isInt(frame.max)) this.peerRoomValue = frame.max; return; }
    if (typeof frame.id !== "string" || !ID.test(frame.id)) return;
    const id = frame.id;
    if (frame.t === "pf-offer") return this.onOffer(frame);
    const incoming = this.entries.get(key("in", id)), outgoing = this.entries.get(key("out", id));
    if (frame.t === "pf-data") { if (incoming) this.onData(incoming, frame); return; }
    if (frame.t === "pf-sum") { if (incoming) await this.onSum(incoming, frame); return; }
    if (frame.t === "pf-abort") {
      if (incoming && !transferEnded(incoming.record)) {
        await incoming.in?.target?.then((t) => t.discard()).catch(() => {});
        this.end(incoming, "cancelled", "Cancelled by the sender");
        this.startNext();
      }
      return;
    }
    if (!outgoing || transferEnded(outgoing.record)) {
      if (outgoing?.record.state === "cancelled" && frame.t !== "pf-refuse") this.send({ t: "pf-abort", id });
      return;
    }
    const { record } = outgoing, out = outgoing.out!;
    switch (frame.t) {
      case "pf-accept": {
        if (!isInt(frame.offset, record.file.size)) return;
        if (record.state === "paused" && record.pausedBy === "me") return;
        out.generation++;
        record.confirmed = frame.offset;
        out.next = frame.offset;
        record.state = "active";
        record.pausedBy = record.waitingFor = undefined;
        this.changed(outgoing);
        if (record.confirmed === record.file.size) void this.sendSum(outgoing);
        else { this.armStall(outgoing); void this.pump(outgoing); }
        return;
      }
      case "pf-wait": {
        out.generation++;
        out.next = record.confirmed;
        clearTimeout(out.timer);
        if (frame.why === "paused") { record.state = "paused"; record.pausedBy = "peer"; }
        else { record.state = "asking"; record.waitingFor = frame.why === "busy" ? "busy" : "consent"; }
        this.changed(outgoing);
        return;
      }
      case "pf-got": {
        if (!isInt(frame.offset) || frame.offset <= record.confirmed || frame.offset > out.next) return;
        record.confirmed = frame.offset;
        this.changed(outgoing, true);
        if (record.confirmed === record.file.size) void this.sendSum(outgoing);
        else { this.armStall(outgoing); void this.pump(outgoing); }
        return;
      }
      case "pf-done": {
        if (record.state !== "verifying") return;
        record.confirmed = record.file.size;
        this.end(outgoing, "done");
        return;
      }
      case "pf-refuse": {
        const { state, error } = refusalText(String(frame.why), isInt(frame.room) ? frame.room : undefined);
        this.end(outgoing, state, error);
        return;
      }
    }
  }

  private end(entry: Entry, state: TransferState, error?: string): void {
    const { record } = entry;
    record.state = state;
    record.error = error;
    record.pausedBy = record.waitingFor = undefined;
    if (entry.out) { entry.out.generation++; clearTimeout(entry.out.timer); entry.out.block = undefined; entry.out.source = undefined; }
    this.changed(entry);
  }

  // ─── What the person does ───────────────────────────────────────────────

  private entry(direction: "in" | "out", id: string): Entry {
    const entry = this.entries.get(key(direction, id));
    if (!entry) throw new Error("No such file transfer");
    return entry;
  }

  /** Takes an offered file. */
  accept(id: string): void {
    const entry = this.entry("in", id);
    if (entry.record.state !== "asking") return;
    entry.record.state = "queued";
    entry.record.consented = true;
    this.changed(entry);
    this.startIncoming(entry);
  }

  decline(id: string): void {
    const entry = this.entry("in", id);
    if (transferEnded(entry.record)) return;
    void entry.in?.target?.then((t) => t.discard()).catch(() => {});
    this.end(entry, "declined", "You declined it");
    this.send({ t: "pf-refuse", id, why: "declined" });
    this.startNext();
  }

  pause(direction: "in" | "out", id: string): void {
    const entry = this.entry(direction, id), { record } = entry;
    if (transferEnded(record) || record.state === "verifying" || (record.state === "paused" && record.pausedBy === "me")) return;
    if (direction === "in" && record.state === "asking") return;
    record.state = "paused";
    record.pausedBy = "me";
    if (entry.out) { entry.out.generation++; entry.out.next = record.confirmed; clearTimeout(entry.out.timer); this.send(this.offerFrame(record, true)); }
    else { this.send({ t: "pf-wait", id, why: "paused" }); void this.checkpoint(entry); this.startNext(); }
    this.changed(entry);
  }

  resume(direction: "in" | "out", id: string): void {
    const entry = this.entry(direction, id), { record } = entry;
    if (record.state !== "paused" || record.pausedBy !== "me") return;
    record.pausedBy = undefined;
    record.state = "queued";
    this.changed(entry);
    if (direction === "out") { if (this.attached) this.announce(entry); }
    else this.startIncoming(entry);
  }

  cancel(direction: "in" | "out", id: string): void {
    const entry = this.entry(direction, id);
    if (transferEnded(entry.record)) return;
    if (direction === "out") {
      this.send({ t: "pf-abort", id });
      this.end(entry, "cancelled", "You cancelled it");
    } else {
      void entry.in?.target?.then((t) => t.discard()).catch(() => {});
      this.end(entry, "cancelled", "You cancelled it");
      this.send({ t: "pf-refuse", id, why: "cancelled" });
      this.startNext();
    }
  }

  /** A sent file that failed, offered again from the start under its id. */
  retry(id: string): void {
    const entry = this.entry("out", id), { record } = entry;
    if (record.state !== "failed") return;
    // The digest is taken again from the source: the one sent last time may be what was wrong.
    Object.assign(record, { state: "queued", confirmed: 0, error: undefined, digest: undefined, since: this.now() });
    entry.out = { next: 0, generation: entry.out!.generation + 1, pumping: false };
    this.changed(entry);
    if (this.attached) this.announce(entry);
  }

  /** Forgets a transfer (its message was deleted): an unfinished one is cancelled on both sides first. */
  forget(direction: "in" | "out", id: string): void {
    const entry = this.entries.get(key(direction, id));
    if (!entry) return;
    if (!transferEnded(entry.record)) this.cancel(direction, id);
    this.entries.delete(key(direction, id));
  }
}
