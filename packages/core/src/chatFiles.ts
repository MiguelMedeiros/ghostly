import { fromBase64Url, toBase64Url } from "./bytes";
import { formatFileSize, sanitizeFileName, sanitizeMime, type FileInfo } from "./files";
import { pairedReplyAuthor, readReply, wireReply } from "./replies";
import { readForwarded } from "./forwards";
import { parseVideoMeta } from "./video";
import { parseImageMeta } from "./image";
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
 *   sender → receiver  pf-offer {id,name,mime,size,ts,voice?,video?,image?,r?,paused?}  pf-data {id,offset,data}
 *                      pf-sum {id,size,digest}  pf-abort {id}
 *   receiver → sender  pf-accept {id,offset}  pf-wait {id,why}  pf-got {id,offset}  pf-done {id}
 *                      pf-refuse {id,why,room?}
 *   both               pf-room {max}
 *
 * The offer is repeated on every session until the transfer ends, so every answer is idempotent: the
 * receiver says where it stands (accept from an offset, wait, done, refuse) and the sender goes on from
 * there. Nothing but the offset a receiver confirms moves a sender forward. A receiver may say `pf-accept`
 * again at any time (nothing arrived for a while, or its person asked again): the sender goes on from that offset.
 * What a sender sends again that way is bounded (`FILE_LIMITS.resendBytes`, and the host's `resend`): past it the
 * sender ends the transfer.
 */

export const FILE_LIMITS = {
  /** Bytes in one `pf-data` frame: a frame stays far below the 60 KiB a session carries. */
  chunkBytes: 16 * 1024,
  /** Bytes a sender has sent and not seen confirmed, at most: throughput is this per round trip. */
  windowBytes: 1024 * 1024,
  /**
   * Bytes all of a chat's files have sent and not seen confirmed, together, at most. Three files' windows at once were 3 MiB, and
   * as base64 text past what a session's receive queue holds (`SESSION_RECEIVE_PENDING`, 3.75 MiB).
   */
  chatWindowBytes: 2 * 1024 * 1024,
  /**
   * What a chat's files have in flight is sized by the path (`ChatFiles.paced`), down to this. A fixed 1 MiB on a 5 Mbit/s
   * uplink queued 1.8 s ahead of every text, ring and hang-up of the sender's in that chat, and of its voice in a call.
   */
  minWindowBytes: 64 * 1024,
  /** How much longer than the shortest round trip seen a confirm may take, by the queue the files keep on the path. */
  queueMs: 50,
  /**
   * A shortest round trip no confirm has come close to for this long is measured again, with the queue drained
   * (`ChatFiles.paced`). A path that got longer mid-session (another route, a relay) read as a queue for good before, and
   * held the window at its floor: 0.5 MiB/s where the same path from the start gave 8 MiB/s.
   */
  baseProbeMs: 10_000,
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
  /**
   * No answer while something is outstanding: the sender offers again, which puts both sides back in step. Nothing
   * arriving for a file under way: the receiver says again where it stands.
   */
  idleMs: 30_000,
  /**
   * A transfer that has not moved for this long (or not since the app started) offers its person "Send again" or
   * "Ask again". Longer than `idleMs`, so what happens on its own has its turn first.
   */
  stallMs: 60_000,
  /** A receiver makes what it stored durable, and records the point to resume from, this often. */
  checkpointBytes: 8 * 1024 * 1024,
  /** A receiver confirms at least this often while writing. */
  ackEveryBytes: 128 * 1024,
  /** A sender reads its file this much at a time. */
  readBytes: 1024 * 1024,
  /** The session refused a data frame (its send budget was full): the sender looks again after this long. */
  sendRetryMs: 250,
  /**
   * What a sender sends of one file beyond its size (parts sent again after a drop, a restart of the receiver, or a
   * `pf-accept` from an earlier offset): twice the file's size and this much. Past it the sender ends the transfer (WISP 501 § Resume).
   */
  resendBytes: 256 * 1024 * 1024,
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
  /**
   * In, `cancelled`: the sender stopped it (`pf-abort`), not this person. Offered again (the sender could not read its
   * file and sends it again), it is taken again from the start.
   */
  abortedBySender?: boolean;
  /**
   * In: taken, by the person or within the app's limits. An offer that expired unanswered never was, so offered again
   * it is refused, never taken without asking.
   */
  agreed?: boolean;
}

const FINAL: ReadonlySet<TransferState> = new Set(["done", "failed", "declined", "cancelled"]);
export const transferEnded = (record: FileTransferRecord): boolean => FINAL.has(record.state);

/**
 * Whether an unfinished transfer is stuck, so its person is offered to push it: "Send again" (sending) or "Ask again"
 * (receiving). `movedAt` is when its bytes last moved, `restored` that it has not moved since the app started. What
 * waits for a person (an answer, a pause) is not stuck, and a failed one has its own "Retry".
 */
export function transferStalled(record: FileTransferRecord, movedAt: number, restored: boolean, now: number): boolean {
  if (transferEnded(record) || record.state === "asking" || record.state === "paused") return false;
  if (record.direction === "in" && record.state === "verifying") return false;
  return restored || now - movedAt >= FILE_LIMITS.stallMs;
}

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
  /**
   * Sends a file's bytes at `offset` in the form the open session agreed (WISP 501 § files/4): a binary message, or
   * the `pf-data` frame; false when there is no session or it has no room. A host without it gets `pf-data` through `send`.
   */
  sendData?(id: string, offset: number, data: Uint8Array): boolean;
  /**
   * A new offer from the contact: take it, ask the person, or refuse it. `again`: a file taken here without asking
   * that ended (failed, or stopped by the sender) and is offered again; it counts against the same limits as a new one.
   */
  decide(file: FileInfo, again?: boolean): Promise<OfferDecision>;
  openTarget(record: FileTransferRecord): Promise<IncomingTarget>;
  openSource(record: FileTransferRecord): Promise<OutgoingSource>;
  /**
   * Something changed: keep it and show it. `transferred` is what moved so far (confirmed by the receiver when
   * sending, stored when receiving); `progress` says only that moved, so keeping it can wait.
   */
  changed(record: FileTransferRecord, transferred: number, progress: boolean): void;
  /** Bytes a file may still take here, or null when the platform does not say. */
  room?(): Promise<number | null>;
  /**
   * Resolves once the session can take another data frame without crowding out everything else on it (nothing when it
   * can now: a large file does not make a promise per frame). Channels with a
   * small send budget (native, iroh) refuse frames past it; sending into a full one again at once spun a loop of
   * promises that never let the budget drain, and froze the app.
   */
  writable?(): Promise<void> | undefined;
  /**
   * Asked before each data frame once a transfer has sent more than its file's size (`sent` is every byte of data sent
   * for it so far, parts sent again included): false ends the transfer. A host with a budget for what it sends says so here.
   */
  resend?(record: FileTransferRecord, sent: number): boolean;
  now?(): number;
}

interface Outgoing {
  source?: Promise<OutgoingSource>;
  next: number;
  /** Bytes of data sent for it since the app started (or since its person sent it again), parts sent again included. */
  sent: number;
  /** Bumped whenever sending stops or restarts: a read that finishes late sends nothing. */
  generation: number;
  /**
   * The generation a pump runs for. A pump still waiting on a session that went (a send that never drains) belongs to
   * an older generation, and does not keep the next session's pump from starting.
   */
  pumping?: number;
  block?: { start: number; bytes: Uint8Array };
  timer?: ReturnType<typeof setTimeout>;
  /** A pump that paused on a refused frame starts again. */
  wake?: ReturnType<typeof setTimeout>;
  /** Chunks sent and not confirmed yet, in order: where each ended, when it went, and the chat's bytes in flight then. */
  sends: { end: number; at: number; flight: number; generation: number }[];
}

interface Incoming {
  target?: Promise<IncomingTarget>;
  /** Nothing arrived for a while: the receiver says again where it stands. */
  timer?: ReturnType<typeof setTimeout>;
  /** When data last came (the timer is not moved for every chunk). */
  heardAt?: number;
  /** Bytes taken in order (some may still be on their way to storage). */
  written: number;
  stored: number;
  acked: number;
  checkpointed: number;
  gapAt?: number;
  writing: Promise<void>;
  verifying?: boolean;
  /** Where it is written is being opened, before it is accepted: it holds one of the turns already. */
  starting?: boolean;
  /** What was stored is being removed: nothing more is written. */
  dropped?: boolean;
}

interface Entry {
  record: FileTransferRecord;
  out?: Outgoing;
  in?: Incoming;
}

const key = (direction: "in" | "out", id: string) => `${direction}:${id}`;
const isInt = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/**
 * files/4 (WISP 501 § files/4): a chunk as one binary message of the session, in place of the base64url text of a
 * `pf-data` frame, which is a third more than the bytes it carries:
 *
 *   kind 0x04 (1) | id length (1) | id (ASCII) | offset (8, big endian) | data (1 to `FILE_LIMITS.chunkBytes`)
 */
export const FILE_DATA_KIND = 0x04;
const FILE_DATA_OFFSET_BYTES = 8;

/** The binary message for the bytes of file `id` at `offset`. Throws on what no receiver would take. */
export function encodeFileData(id: string, offset: number, data: Uint8Array): Uint8Array {
  if (!ID.test(id) || !isInt(offset) || !data.length || data.length > FILE_LIMITS.chunkBytes) throw new Error("Invalid file data");
  const head = 2 + id.length;
  const out = new Uint8Array(head + FILE_DATA_OFFSET_BYTES + data.length);
  out[0] = FILE_DATA_KIND;
  out[1] = id.length;
  for (let i = 0; i < id.length; i++) out[2 + i] = id.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(head, Math.floor(offset / 2 ** 32));
  view.setUint32(head + 4, offset % 2 ** 32);
  out.set(data, head + FILE_DATA_OFFSET_BYTES);
  return out;
}

/** What a binary message from the contact says, or null when it is not a well-formed file data message. `data` is a view of `message`. */
export function decodeFileData(message: Uint8Array): { id: string; offset: number; data: Uint8Array } | null {
  if (message.length < 2 || message[0] !== FILE_DATA_KIND) return null;
  const head = 2 + message[1], body = head + FILE_DATA_OFFSET_BYTES;
  if (message.length <= body || message.length - body > FILE_LIMITS.chunkBytes) return null;
  const id = String.fromCharCode(...message.subarray(2, head));
  if (!ID.test(id)) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const high = view.getUint32(head);
  // Past 2^53 - 1 an offset is no longer a whole number here.
  if (high > 0x1fffff) return null;
  return { id, offset: high * 2 ** 32 + view.getUint32(head + 4), data: message.subarray(body) };
}

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
  /** Files sending that may have bytes not confirmed yet: what `inFlight` adds up (the rest are left out as it goes). */
  private readonly moving = new Set<Entry>();
  /** Files that stopped sending for the chat's window alone: they go on once another's bytes are confirmed. */
  private readonly held = new Set<Entry>();
  private attached = false;
  private peerRoomValue: number | null = null;
  /** Bytes the chat's files may have in flight on this session: sized by the path, from the confirms (`paced`). */
  private window: number = FILE_LIMITS.minWindowBytes;
  /** The shortest round trip of a chunk to its confirm on this session: the path without a queue. */
  private baseRtt = Infinity;
  /** When a confirm last came close to `baseRtt`, or a probe measured it. */
  private baseAt = 0;
  /** The path's own round trip is being measured: one chunk in flight from `since`, until one sent then is confirmed. */
  private probe?: { since: number; window: number };

  constructor(private readonly host: ChatFilesHost) {}

  private now(): number { return this.host.now?.() ?? Date.now(); }

  /** Records kept from before a restart. Nothing is sent until `attach`. */
  restore(records: FileTransferRecord[]): void {
    for (const record of records) {
      const entry: Entry = { record: { ...record } };
      if (record.direction === "out") entry.out = { next: record.confirmed, sent: 0, generation: 0, sends: [] };
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
  /** Bytes of data sent for a file so far, parts sent again included: what sending it cost, whatever the receiver confirmed. */
  sent(id: string): number {
    return this.entries.get(key("out", id))?.out?.sent ?? 0;
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

  private sendData(id: string, offset: number, data: Uint8Array): boolean {
    if (!this.host.sendData) return this.send({ t: "pf-data", id, offset, data: toBase64Url(data) });
    return this.attached && this.host.sendData(id, offset, data);
  }

  /** A session that agreed files/3 is open: say what fits here, then offer again what is not finished. */
  attach(): void {
    this.attached = true;
    this.peerRoomValue = null;
    // Another session may be another path.
    this.window = FILE_LIMITS.minWindowBytes;
    this.baseRtt = Infinity;
    this.baseAt = 0;
    this.probe = undefined;
    void this.sayRoom();
    this.sweep();
    for (const entry of this.entries.values()) {
      if (transferEnded(entry.record)) continue;
      if (entry.record.direction === "out") this.announce(entry);
      else if (entry.record.state === "queued") this.startIncoming(entry);
      // The sender offers again on its own; one that does not (an older app, one stuck) is asked.
      else if (entry.record.state === "active") this.armNudge(entry);
    }
  }

  /** The session went: nothing moves until the next one. What was received is made durable. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.peerRoomValue = null;
    this.moving.clear(); this.held.clear();
    for (const entry of this.entries.values()) {
      if (entry.out) { entry.out.generation++; clearTimeout(entry.out.timer); clearTimeout(entry.out.wake); entry.out.next = entry.record.confirmed; }
      if (entry.in) clearTimeout(entry.in.timer);
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
      out: { next: 0, sent: 0, generation: 0, sends: [] },
    };
    this.entries.set(key("out", file.id), entry);
    this.changed(entry);
    if (this.attached) this.announce(entry);
    return { ...entry.record };
  }

  private offerFrame(record: FileTransferRecord, paused: boolean): Record<string, unknown> {
    const { file } = record;
    return { t: "pf-offer", id: file.id, name: file.name, mime: file.mime, size: file.size, ts: file.timestamp, ...(file.voice && { voice: file.voice }), ...(file.video && { video: file.video }), ...(file.image && { image: file.image }), ...(file.reply && { r: wireReply(file.reply) }), ...(readForwarded(file.forwarded) && { fw: file.forwarded }), ...(paused && { paused: true }) };
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

  /** Whether this file's own window lets it send more. */
  private fileMayPump(entry: Entry): boolean {
    const { record } = entry, out = entry.out!;
    return this.attached && record.state === "active" && out.next < record.file.size && out.next - record.confirmed < FILE_LIMITS.windowBytes;
  }

  private shouldPump(entry: Entry): boolean {
    return this.fileMayPump(entry) && this.inFlight() < (this.probe ? FILE_LIMITS.chunkBytes : this.window);
  }

  /**
   * A confirm came for a chunk sent at `sentAt` with `flight` bytes in flight then: the window becomes what keeps the path
   * busy with no more than `FILE_LIMITS.queueMs` of queue on it (delay-based, as LEDBAT). Throughput is about
   * flight / rtt, so flight × (base + queueMs) / rtt: it grows while confirms come about as fast as they can, and shrinks
   * when they slow down because the files queue on a slow uplink, ahead of everything else the sender says there.
   * The base is measured again once no confirm has come close to it for `FILE_LIMITS.baseProbeMs`: with one chunk in
   * flight, so the queue drains first and a slow link's own queue never passes for a longer path.
   */
  private paced(sentAt: number, flight: number): void {
    const now = this.now(), rtt = Math.max(1, now - sentAt);
    if (this.probe) {
      // Sent before the probe: it waited behind the queue the probe lets drain.
      if (sentAt < this.probe.since) return;
      this.baseRtt = rtt;
      this.baseAt = now;
      this.window = this.probe.window;
      this.probe = undefined;
      return;
    }
    if (rtt - this.baseRtt < FILE_LIMITS.queueMs / 2) this.baseAt = now;
    this.baseRtt = Math.min(this.baseRtt, rtt);
    if (now - this.baseAt > FILE_LIMITS.baseProbeMs) {
      this.probe = { since: now, window: this.window };
      return;
    }
    // No queue to speak of yet: twice as much per round trip at least, as a long fast path needs many to fill.
    const fits = Math.max((flight * (this.baseRtt + FILE_LIMITS.queueMs)) / rtt, rtt - this.baseRtt < FILE_LIMITS.queueMs / 2 ? 2 * flight : 0);
    // Little was in flight (a file starting or ending): that says nothing about a larger window being too large.
    const window = flight < this.window / 2 ? Math.max(this.window, fits) : fits;
    this.window = Math.min(FILE_LIMITS.chatWindowBytes, Math.max(FILE_LIMITS.minWindowBytes, Math.round(window)));
  }

  /** Bytes this chat's files sent and have not seen confirmed. */
  private inFlight(): number {
    let bytes = 0;
    for (const entry of this.moving) {
      const out = entry.out, { record } = entry;
      if (!out || record.state !== "active" || out.next <= record.confirmed) { this.moving.delete(entry); continue; }
      bytes += out.next - record.confirmed;
    }
    return bytes;
  }

  /** Bytes were confirmed, or a file stopped sending: the files the chat's window held go on, before the one that freed it. */
  private wakeHeld(): void {
    for (const entry of [...this.held]) { this.held.delete(entry); void this.pump(entry); }
  }

  /**
   * Whether the next `length` bytes go. Within the file's size they always do; past it the receiver is having parts
   * sent again, which nothing it says bounds, so this side does.
   */
  private mayResend(entry: Entry, length: number): boolean {
    const { record } = entry, size = record.file.size, sent = entry.out!.sent + length;
    if (sent <= size) return true;
    return sent - size <= 2 * size + FILE_LIMITS.resendBytes && this.host.resend?.({ ...record }, sent) !== false;
  }

  private async pump(entry: Entry): Promise<void> {
    const out = entry.out!;
    if (out.pumping === out.generation) return;
    const generation = out.pumping = out.generation;
    clearTimeout(out.wake);
    let refused = false;
    try {
      while (this.shouldPump(entry) && generation === out.generation) {
        const offset = out.next;
        const chunk = await this.chunkAt(entry, offset);
        const room = this.host.writable?.();
        if (room) await room;
        if (generation !== out.generation || !this.shouldPump(entry) || out.next !== offset) break;
        if (!this.mayResend(entry, chunk.length)) {
          this.send({ t: "pf-abort", id: entry.record.id });
          this.end(entry, "failed", "Your contact asked for the same part of this file too many times");
          break;
        }
        if (!this.sendData(entry.record.id, offset, chunk)) { refused = true; break; }
        out.next = offset + chunk.length;
        out.sent += chunk.length;
        this.moving.add(entry);
        if (out.sends[out.sends.length - 1]?.generation !== generation) out.sends.length = 0;
        out.sends.push({ end: out.next, at: this.now(), flight: this.inFlight(), generation });
      }
    } catch (error) {
      if (generation === out.generation) {
        this.send({ t: "pf-abort", id: entry.record.id });
        this.end(entry, "failed", `Could not read the file: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (out.pumping === generation) out.pumping = undefined;
      if (generation === out.generation && this.shouldPump(entry)) {
        // A refused frame is tried again later, never at once: at once, nothing else would run until it went.
        if (refused) out.wake = setTimeout(() => void this.pump(entry), FILE_LIMITS.sendRetryMs);
        else void this.pump(entry);
      } else if (generation === out.generation && this.fileMayPump(entry)) this.held.add(entry);
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
    return [...this.entries.values()].filter((e) => e !== except && e.record.direction === "in" && (e.record.state === "active" || e.record.state === "verifying" || e.in?.starting)).length;
  }

  /**
   * Removes what this side stored of an incoming file that ends here. Through its target, opened now if need be: after
   * a restart a transfer has none until bytes arrive again, and one cancelled before that kept its part on the disk.
   * After the write under way, and with the ones queued behind it stopped: a write landing after the removal would
   * store a part of the file again.
   */
  private discardStored(entry: Entry): Promise<void> {
    const incoming = entry.in;
    if (!incoming) return Promise.resolve();
    incoming.dropped = true;
    return incoming.writing.then(() => this.target(entry)).then((t) => t.discard()).catch(() => {});
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

  /**
   * An accepted file goes when a session is open and fewer than three others arrive at once. One whose target is still
   * being opened counts among the three: counted only once active, every file offered or queued meanwhile went too, and
   * the windows of ten files and more at once overflowed the session's receive queue.
   */
  private startIncoming(entry: Entry): void {
    if (!this.attached || transferEnded(entry.record) || entry.record.state === "asking" || (entry.record.state === "paused" && entry.record.pausedBy === "me")) return;
    const incoming = entry.in!;
    if (incoming.starting) return;
    if (this.activeIncoming(entry) >= FILE_LIMITS.maxActiveIncoming) {
      if (entry.record.state !== "queued") { entry.record.state = "queued"; this.changed(entry); }
      this.send({ t: "pf-wait", id: entry.record.id, why: "busy" });
      return;
    }
    incoming.starting = true;
    void this.target(entry).then(() => {
      incoming.starting = false;
      // Ended, paused or cut off while it opened: its turn goes to the next one.
      if (transferEnded(entry.record) || !this.attached || (entry.record.state === "paused" && entry.record.pausedBy === "me")) { this.startNext(); return; }
      entry.record.state = "active";
      entry.record.pausedBy = undefined;
      entry.in!.gapAt = undefined;
      this.changed(entry);
      this.send({ t: "pf-accept", id: entry.record.id, offset: entry.in!.written });
      entry.in!.heardAt = this.now();
      this.armNudge(entry);
    }, (error) => {
      incoming.starting = false;
      this.end(entry, "failed", `Could not store the file: ${error instanceof Error ? error.message : String(error)}`);
      this.send({ t: "pf-refuse", id: entry.record.id, why: "no-room" });
      this.startNext();
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
    const video = parseVideoMeta(frame.video, file.mime);
    if (video) file.video = video;
    const image = parseImageMeta(frame.image, file.mime);
    if (image) file.image = image;
    const reply = readReply(frame.r, pairedReplyAuthor);
    if (reply) file.reply = reply;
    const forwarded = readForwarded(frame.fw);
    if (forwarded) file.forwarded = forwarded;
    const paused = frame.paused === true;
    const existing = this.entries.get(key("in", id));
    if (existing) {
      const { record } = existing;
      if (record.file.size !== file.size || record.file.name !== file.name) { this.send({ t: "pf-refuse", id, why: "invalid" }); return; }
      switch (record.state) {
        case "done": this.send({ t: "pf-done", id }); return;
        case "declined": this.send({ t: "pf-refuse", id, why: "declined" }); return;
        case "cancelled":
          // Cancelled here stays cancelled; stopped by the sender (it could not read its file), it is taken again.
          if (!record.abortedBySender || (!record.agreed && !record.consented)) { this.send({ t: "pf-refuse", id, why: "cancelled" }); return; }
          if (!(await this.retakeAgreed(existing))) return;
          break;
        case "failed":
          // Expired here before anyone answered: nothing was agreed, and offered again it would skip the question.
          if (!record.agreed && !record.consented) { this.send({ t: "pf-refuse", id, why: "expired" }); return; }
          // Sent again after it failed here (damaged, not stored): taken again from the start, as it was agreed.
          if (!(await this.retakeAgreed(existing))) return;
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
      record: { id, direction: "in", file, state: decision === "ask" ? "asking" : paused ? "paused" : "queued", confirmed: 0, since: this.now(),
        ...(decision !== "ask" && { agreed: true }), ...(paused && decision !== "ask" && { pausedBy: "peer" as const }) },
      in: { written: 0, stored: 0, acked: 0, checkpointed: 0, writing: Promise.resolve() },
    };
    this.entries.set(key("in", id), entry);
    this.changed(entry);
    if (decision === "ask") this.send({ t: "pf-wait", id, why: "consent" });
    else if (!paused) this.startIncoming(entry);
  }

  /**
   * An agreed file that ended here, offered again. One the person consented to is taken again from the start; one taken
   * without asking is decided again, as a new offer would be (the contact's limit for files taken without asking, and
   * the room here): taken again, asked about, or refused. True when it is taken again.
   */
  private async retakeAgreed(entry: Entry): Promise<boolean> {
    const { record } = entry;
    if (!record.consented) {
      let decision: OfferDecision;
      try { decision = await this.host.decide(record.file, true); } catch { decision = { refuse: "invalid" }; }
      if (typeof decision === "object") { this.send({ t: "pf-refuse", id: record.id, why: decision.refuse, ...(decision.room !== undefined && { room: decision.room }) }); return false; }
      if (decision === "ask") {
        if (this.waitingOffers() >= FILE_LIMITS.maxWaitingOffers) { this.send({ t: "pf-refuse", id: record.id, why: "too-many" }); return false; }
        await this.retake(entry);
        record.state = "asking";
        record.agreed = undefined;
        this.changed(entry);
        this.send({ t: "pf-wait", id: record.id, why: "consent" });
        return false;
      }
    }
    await this.retake(entry);
    return true;
  }

  /** An agreed file that ended here, offered again: taken again from the start. */
  private async retake(entry: Entry): Promise<void> {
    await entry.in?.target?.then((t) => t.discard()).catch(() => {});
    entry.in = { written: 0, stored: 0, acked: 0, checkpointed: 0, writing: Promise.resolve() };
    Object.assign(entry.record, { state: "queued", confirmed: 0, error: undefined, digest: undefined, abortedBySender: undefined, since: this.now() });
    this.changed(entry);
  }

  private onData(entry: Entry, frame: Record<string, unknown>): void {
    const { record } = entry, incoming = entry.in!;
    if (record.state !== "active" || !incoming.target) return;
    incoming.heardAt = this.now();
    const { offset, data } = frame;
    // The bytes themselves when they came as a binary message (files/4), base64url text in a `pf-data` frame.
    const binary = data instanceof Uint8Array;
    if (!isInt(offset) || !(binary || typeof data === "string") || !data.length) return;
    if (!binary && (data.length > Math.ceil(FILE_LIMITS.chunkBytes * 4 / 3) || !DATA.test(data))) return;
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
    const bytes = binary ? data : fromBase64Url(data);
    if (!bytes.length || bytes.length > FILE_LIMITS.chunkBytes || offset + bytes.length > record.file.size) return;
    incoming.written += bytes.length;
    const target = incoming.target;
    incoming.writing = incoming.writing.then(async () => {
      if (transferEnded(record) || incoming.dropped) return;
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

  /** Nothing arrives for a file under way: after a quiet spell the receiver says again where it stands. */
  private armNudge(entry: Entry, delay: number = FILE_LIMITS.idleMs): void {
    const incoming = entry.in!;
    clearTimeout(incoming.timer);
    if (!this.attached || entry.record.state !== "active") return;
    incoming.heardAt ??= this.now();
    incoming.timer = setTimeout(() => {
      const quiet = this.now() - (incoming.heardAt ?? 0);
      if (quiet < FILE_LIMITS.idleMs) this.armNudge(entry, FILE_LIMITS.idleMs - quiet);
      else void this.askAgain(entry);
    }, delay);
  }

  /** `pf-accept` from what is taken here: the sender goes on from there (it ignores it for a transfer that ended). */
  private async askAgain(entry: Entry): Promise<void> {
    const { record } = entry, incoming = entry.in!;
    // Kept from before a restart, not opened yet: opening it says where it stands.
    if (!incoming.target) { this.startIncoming(entry); return; }
    await incoming.writing;
    if (!this.attached || record.state !== "active" || incoming.verifying) return;
    incoming.gapAt = undefined;
    this.send({ t: "pf-accept", id: record.id, offset: incoming.written });
    incoming.heardAt = this.now();
    this.armNudge(entry);
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
        await this.discardStored(incoming);
        incoming.record.abortedBySender = true;
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
        // Paused here before the person there answered: it stays so, and their side hears it is paused.
        if (record.state === "paused" && record.pausedBy === "me") { this.send(this.offerFrame(record, true)); return; }
        out.generation++;
        record.confirmed = frame.offset;
        out.next = frame.offset;
        record.state = "active";
        record.pausedBy = record.waitingFor = undefined;
        this.changed(outgoing);
        this.wakeHeld();
        if (record.confirmed === record.file.size) void this.sendSum(outgoing);
        else { this.armStall(outgoing); void this.pump(outgoing); }
        return;
      }
      case "pf-wait": {
        // The answer to the paused offer said while the person there still decides: the pause here holds.
        if (record.state === "paused" && record.pausedBy === "me") return;
        out.generation++;
        out.next = record.confirmed;
        clearTimeout(out.timer);
        if (frame.why === "paused") { record.state = "paused"; record.pausedBy = "peer"; }
        else { record.state = "asking"; record.waitingFor = frame.why === "busy" ? "busy" : "consent"; }
        this.changed(outgoing);
        this.wakeHeld();
        return;
      }
      case "pf-got": {
        if (!isInt(frame.offset) || frame.offset <= record.confirmed || frame.offset > out.next) return;
        record.confirmed = frame.offset;
        // The last chunk this confirms says how long the path took (one sent before a resync says nothing).
        let sample: Outgoing["sends"][number] | undefined;
        while (out.sends.length && out.sends[0].end <= frame.offset) sample = out.sends.shift();
        if (sample?.generation === out.generation) this.paced(sample.at, sample.flight);
        this.changed(outgoing, true);
        this.wakeHeld();
        if (record.confirmed === record.file.size) void this.sendSum(outgoing);
        else { this.armStall(outgoing); void this.pump(outgoing); }
        return;
      }
      case "pf-done": {
        // Checked out there. Said again to the offer of a new session too, after which this side is no longer verifying.
        if (record.state !== "verifying" && record.confirmed !== record.file.size) return;
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
    if (entry.out) {
      entry.out.generation++; clearTimeout(entry.out.timer); clearTimeout(entry.out.wake); entry.out.block = undefined; entry.out.source = undefined; entry.out.sends.length = 0;
      this.moving.delete(entry); this.held.delete(entry);
    }
    if (entry.in) {
      const incoming = entry.in;
      clearTimeout(incoming.timer);
      // Its writer goes once the writes under way are done (a host's holds a 256 KiB buffer): every file received kept
      // one until the app quit. One taken again opens a new target.
      void incoming.writing.finally(() => { if (transferEnded(record)) incoming.target = undefined; });
    }
    this.changed(entry);
    if (entry.out) this.wakeHeld();
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
    entry.record.consented = entry.record.agreed = true;
    this.changed(entry);
    this.startIncoming(entry);
  }

  decline(id: string): void {
    const entry = this.entry("in", id);
    if (transferEnded(entry.record)) return;
    void this.discardStored(entry);
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
    if (entry.out) this.wakeHeld();
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
      void this.discardStored(entry);
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
    clearTimeout(entry.out!.timer); clearTimeout(entry.out!.wake);
    entry.out = { next: 0, sent: 0, generation: entry.out!.generation + 1, sends: [] };
    this.changed(entry);
    if (this.attached) this.announce(entry);
  }

  /**
   * "Send again": a sent file that failed, or stopped moving, is offered again now (or on the next session). The
   * receiver answers from what it holds, so it goes on from there, never twice in the chat: same id, same message.
   * True when it went now.
   */
  resend(id: string): boolean {
    const entry = this.entry("out", id), { record } = entry;
    if (record.state === "failed") { this.retry(id); return this.attached; }
    if (transferEnded(record)) return false;
    if (record.state === "paused" && record.pausedBy === "me") { this.resume("out", id); return this.attached; }
    if (!this.attached) return false;
    this.announce(entry);
    return true;
  }

  /**
   * "Ask again": a file that stopped arriving is asked for again from where it stands here. No new frame: a receiver's
   * `pf-accept` already moves any files/3 sender to its offset.
   * True when it went now.
   */
  request(id: string): boolean {
    const entry = this.entry("in", id), { record } = entry;
    if (transferEnded(record) || record.state === "asking" || record.state === "verifying") return false;
    if (record.state === "paused") {
      if (record.pausedBy !== "me") return false;
      this.resume("in", id);
      return this.attached;
    }
    if (!this.attached) return false;
    if (record.state === "queued") this.startIncoming(entry);
    else void this.askAgain(entry);
    return true;
  }

  /** Forgets a transfer (its message was deleted): an unfinished one is cancelled on both sides first. */
  forget(direction: "in" | "out", id: string): void {
    const entry = this.entries.get(key(direction, id));
    if (!entry) return;
    if (!transferEnded(entry.record)) this.cancel(direction, id);
    this.entries.delete(key(direction, id));
  }
}
