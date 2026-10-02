import {
  ChatFiles,
  FILE_LIMITS,
  fileMessageText,
  randomBytes,
  toBase64Url,
  transferEnded,
  transferStalled,
  type FileInfo,
  type FileTransferRecord,
  type IncomingTarget,
  type OfferDecision,
  type OutgoingSource,
  type WireReply,
} from "@ghostly/core";
import { blobDigest, fileBytes, fileBytesOf } from "../shared/fileBytes";
import { fileStore, type StoredFile } from "../shared/idb";
import { FileAppender, readStored } from "../shared/storedFiles";
import type { FileTransferView, MessageFile, StoredMessage } from "../shared/types";
import { receivedPairedReply } from "../shared/replies";
import { fileWire } from "./messageDetails";

/** What the desk needs from the peer: the chat's link and bookkeeping, its messages, and the views. */
export interface FileDeskDeps {
  /** Sends a files/3 frame on the chat's open session; false when there is none. */
  send(linkId: string, frame: Record<string, unknown>): boolean;
  /** Resolves once the chat's open session can take another data frame (its send budget has room). */
  writable?(linkId: string): Promise<void> | undefined;
  /** Bytes the contact sent that are stored here without asking (files/2 included): the budget files/3 fills. */
  receivedBytes(linkId: string): number;
  /** Wire ids this chat used already, in either direction. */
  wireIds(linkId: string): Set<string> | undefined;
  /** A message the person deleted here: a transfer for it is not taken. */
  deleted(linkId: string, messageId: string): boolean;
  /** A message the chat holds already (a new file must not take the id of the contact's text, say). */
  messageExists?(linkId: string, messageId: string): Promise<boolean>;
  storeMessage(message: StoredMessage): Promise<void>;
  transfers: Map<string, FileTransferView>;
  changed(delayMs?: number): void;
  /** The state to the app now, not after `changed`'s wait: for a transfer the app must have before its message. */
  flush?(): void;
  /** A transfer ended, either way: its local file id and how (for the message's details). */
  /** `seen`: this desk saw the transfer under way before it ended (not a finished one shown again on a restart). */
  settled?(linkId: string, fileId: string, record: FileTransferRecord, seen: boolean): void;
}

interface Chat {
  files: ChatFiles;
  /** Wire id of a received file → its local id. */
  local: Map<string, string>;
  /** Writes to the database, in order. */
  saving: Promise<void>;
  lastSaved: Map<string, number>;
}

interface Speed { bytes: number; at: number; rate: number }

/** Local id of a file sent: the same shape files/2 uses. */
export const outgoingFileId = (linkId: string, wireId: string) => `${linkId}-out-${wireId}`;

/** Progress is written to the database at most this often; every change of state is written at once. */
const SAVE_EVERY_MS = 2_000;

export type FileDeskAction = "accept" | "decline" | "pause" | "resume" | "cancel" | "retry" | "resend" | "request";

/**
 * files/3 for every chat of this profile (WISP 501 rev 0.3): each chat's `ChatFiles`, the bytes in file
 * storage, the records in the files store (so a transfer resumes after a restart), the chat message a file
 * shows as, and the transfer the UI reads.
 */
export class FileDesk {
  private readonly chats = new Map<string, Chat>();
  private readonly speeds = new Map<string, Speed>();
  /** By local id: when its bytes last moved (for the stall rule). */
  private readonly moved = new Map<string, { at: number }>();
  /** Unfinished when the app started, and not moved since. */
  private readonly restored = new Set<string>();
  /** A look again when a transfer would count as stuck, by local id. */
  private readonly stallChecks = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: FileDeskDeps) {}

  /** The chat's files, made the first time they are needed. */
  private chat(linkId: string): Chat {
    let chat = this.chats.get(linkId);
    if (chat) return chat;
    const made: Chat = { local: new Map(), saving: Promise.resolve(), lastSaved: new Map(), files: undefined as unknown as ChatFiles };
    made.files = new ChatFiles({
      send: (frame) => this.deps.send(linkId, frame),
      decide: (file, again) => this.decide(linkId, file, again),
      openTarget: (record) => this.openTarget(linkId, record),
      openSource: (record) => this.openSource(linkId, record),
      changed: (record, transferred, progress) => this.changed(linkId, record, transferred, progress),
      room: async () => (await fileBytes()).room(),
      writable: () => this.deps.writable?.(linkId),
    });
    this.chats.set(linkId, made);
    chat = made;
    return chat;
  }

  /** At start: the chat's unfinished and finished files/3 transfers, as they were kept. */
  restore(linkId: string, files: StoredFile[]): void {
    const records: FileTransferRecord[] = [];
    const chat = this.chat(linkId);
    for (const file of files) {
      if (!file.wire3) continue;
      records.push(file.wire3);
      if (file.wire3.direction === "in") chat.local.set(file.wire3.id, file.id);
      if (!transferEnded(file.wire3)) this.restored.add(file.id);
      this.deps.transfers.set(file.id, this.view(chat, file.wire3, file.wire3.confirmed, transferStalled(file.wire3, Date.now(), this.restored.has(file.id), Date.now())));
    }
    chat.files.restore(records);
  }

  /** A session that agreed files/3 opened (again, after a switch), or closed. */
  session(linkId: string, open: boolean): void {
    const chat = this.chat(linkId);
    if (open) chat.files.attach(); else chat.files.detach();
    for (const record of chat.files.records()) this.show(linkId, chat, record, chat.files.transferred(record.direction, record.id));
    this.deps.changed();
  }

  handle(linkId: string, frame: Record<string, unknown>): Promise<void> {
    return this.chat(linkId).files.handle(frame);
  }

  /** Whether files/3 is live in this chat, and what the contact said it can take. */
  status(linkId: string): { live: boolean; peerRoom: number | null } {
    const files = this.chats.get(linkId)?.files;
    return { live: !!files?.live, peerRoom: files?.peerRoom ?? null };
  }

  /** A files/3 transfer of this chat's under way on its session: offered, moving, or being checked. */
  moving(linkId: string): boolean {
    const files = this.chats.get(linkId)?.files;
    return !!files?.live && files.records().some((r) => r.state === "offered" || r.state === "active" || r.state === "verifying");
  }

  /**
   * Offers a file whose record and bytes are stored under its local id (`outgoingFileId`). Offered before (Retry, a
   * restart): an unfinished transfer is taken over and offered again, a failed one sent again; never a second one.
   */
  async offer(linkId: string, file: MessageFile, wireId: string, timestamp: number, reply?: WireReply, forwarded?: number): Promise<void> {
    const chat = this.chat(linkId);
    const stored = await fileStore.get(file.id);
    if (!stored) throw new Error("The file is gone");
    const existing = chat.files.get("out", wireId);
    if (existing) {
      if (existing.state === "done") return;
      if (existing.state === "declined" || existing.state === "cancelled") throw new Error(existing.error ?? "It was cancelled");
      // Not running (a restart, a link that went) or failed: sent again, from what the contact holds.
      chat.files.resend(wireId);
      const current = chat.files.get("out", wireId);
      if (current) this.show(linkId, chat, current, chat.files.transferred("out", wireId));
      this.deps.changed();
      return;
    }
    chat.files.offer({ id: wireId, name: file.name, size: file.size, mime: file.mime, timestamp, ...(file.voice && { voice: file.voice }), ...(file.video && { video: file.video }), ...(file.image && { image: file.image }), ...(reply && { reply }), ...(forwarded && { forwarded }) }, stored.digest);
  }

  /**
   * The person answers an offer, or pauses, resumes, cancels or sends again a transfer. `resend` (sending) and
   * `request` (receiving) push one that stopped moving: false when no session is open, and it goes on the next one.
   */
  act(linkId: string, fileId: string, action: FileDeskAction): boolean {
    const chat = this.chat(linkId);
    const out = fileId.startsWith(`${linkId}-out-`);
    const wireId = out ? fileId.slice(`${linkId}-out-`.length) : [...chat.local].find(([, local]) => local === fileId)?.[0];
    const record = wireId && chat.files.get(out ? "out" : "in", wireId);
    if (!wireId || !record) throw new Error("No such file transfer");
    const direction = out ? "out" : "in";
    switch (action) {
      case "accept": if (!out) chat.files.accept(wireId); break;
      case "decline": if (!out) chat.files.decline(wireId); break;
      case "pause": chat.files.pause(direction, wireId); break;
      case "resume": chat.files.resume(direction, wireId); break;
      case "cancel": chat.files.cancel(direction, wireId); break;
      case "retry": if (out) chat.files.retry(wireId); break;
      case "resend": case "request": {
        if ((action === "resend") !== out) throw new Error(out ? "A file you sent is sent again, not asked for" : "A file you receive is asked for again, not sent");
        const now = out ? chat.files.resend(wireId) : chat.files.request(wireId);
        // Pushed: it counts as stuck again only after another quiet spell.
        this.restored.delete(fileId);
        this.moved.set(fileId, { at: Date.now() });
        const current = chat.files.get(direction, wireId);
        if (current) this.show(linkId, chat, current, chat.files.transferred(direction, wireId));
        this.deps.changed();
        return now;
      }
    }
    return chat.files.live;
  }

  /** Shows a files/3 transfer's own view again; false when this local file has none. */
  reshow(linkId: string, fileId: string): boolean {
    const chat = this.chats.get(linkId);
    if (!chat) return false;
    const out = fileId.startsWith(`${linkId}-out-`);
    const wireId = out ? fileId.slice(`${linkId}-out-`.length) : [...chat.local].find(([, local]) => local === fileId)?.[0];
    const record = wireId && chat.files.get(out ? "out" : "in", wireId);
    if (!wireId || !record) return false;
    this.show(linkId, chat, record, chat.files.transferred(record.direction, wireId));
    this.deps.changed();
    return true;
  }

  /** Whether this local file is a files/3 transfer, and not finished. */
  active(linkId: string, fileId: string): boolean {
    const chat = this.chats.get(linkId);
    if (!chat) return false;
    const out = fileId.startsWith(`${linkId}-out-`);
    const wireId = out ? fileId.slice(`${linkId}-out-`.length) : [...chat.local].find(([, local]) => local === fileId)?.[0];
    const record = wireId && chat.files.get(out ? "out" : "in", wireId);
    return !!record && !transferEnded(record);
  }

  /** The message of a file was deleted here: an unfinished transfer ends on both sides, and is forgotten. */
  forget(linkId: string, fileId: string): void {
    const chat = this.chats.get(linkId);
    if (!chat) return;
    const out = fileId.startsWith(`${linkId}-out-`);
    const wireId = out ? fileId.slice(`${linkId}-out-`.length) : [...chat.local].find(([, local]) => local === fileId)?.[0];
    if (!wireId) return;
    chat.files.forget(out ? "out" : "in", wireId);
    if (!out) chat.local.delete(wireId);
    this.speeds.delete(fileId);
    this.unwatch(fileId);
  }

  /** Offers nobody answered in a week end; the peer calls this now and then. */
  sweep(): void {
    for (const chat of this.chats.values()) chat.files.sweep();
  }

  /** The chat went away: its transfers stop here. */
  drop(linkId: string): void {
    this.chats.get(linkId)?.files.detach();
    this.chats.delete(linkId);
    for (const id of [...this.moved.keys(), ...this.restored, ...this.stallChecks.keys()]) if (id.startsWith(`${linkId}-`)) this.unwatch(id);
  }

  /** Stops tracking whether a transfer is stuck. */
  private unwatch(id: string): void {
    clearTimeout(this.stallChecks.get(id));
    this.stallChecks.delete(id);
    this.moved.delete(id);
    this.restored.delete(id);
  }

  // ─── The host of each ChatFiles ─────────────────────────────────────────

  /**
   * Small files are taken as before; above 25 MiB, or past the contact's 500 MiB taken without asking, the
   * person decides. A file larger than the room this device has left is refused, and the sender told the room.
   */
  private async decide(linkId: string, file: FileInfo, again = false): Promise<OfferDecision> {
    const used = this.deps.wireIds(linkId);
    // Offered again, the file is this chat's already (its id is in use by it); new, its id must be new.
    if (!used || (!again && used.has(file.id))) return { refuse: "invalid" };
    if (this.deps.deleted(linkId, `peer_${file.id}`)) return { refuse: "declined" };
    if (!again && await this.deps.messageExists?.(linkId, `peer_${file.id}`)) return { refuse: "invalid" };
    const room = await (await fileBytes()).room().catch(() => null);
    if (room !== null && file.size > room) return { refuse: "no-room", room };
    const taken = this.deps.receivedBytes(linkId) + this.autoTaken(linkId);
    return file.size <= FILE_LIMITS.askAboveBytes && taken + file.size <= FILE_LIMITS.autoAcceptBytesPerPeer ? "accept" : "ask";
  }

  /** files/3 files this contact sent that were taken without asking and are kept (or on their way). */
  private autoTaken(linkId: string): number {
    const chat = this.chats.get(linkId);
    if (!chat) return 0;
    return chat.files.records().filter((r) => r.direction === "in" && !r.consented && r.state !== "asking" && !["failed", "declined", "cancelled"].includes(r.state))
      .reduce((sum, r) => sum + r.file.size, 0);
  }

  /** Where a received file is written: from what is durably there, cut back to that if more was written after. */
  private async openTarget(linkId: string, record: FileTransferRecord): Promise<IncomingTarget> {
    const chat = this.chat(linkId), id = chat.local.get(record.id);
    if (!id) throw new Error("No such file");
    // Its record is written first (a new offer's is on its way).
    await chat.saving;
    const stored = await fileStore.get(id);
    const bytes = (stored?.bytes && await fileBytesOf(stored.bytes)) || await fileBytes();
    const size = await bytes.size(id), have = size ?? 0;
    const offset = Math.min(have, record.confirmed);
    if (have > offset) await bytes.truncate(id, offset);
    // A file of no bytes gets no append: it is made here, so there is a file to check and to save. Every backend
    // but IndexedDB reads a file never written as missing, and its check said "arrived damaged".
    if (size === null && record.file.size === 0) await bytes.append(id, 0, new Uint8Array());
    if (stored && stored.bytes !== bytes.kind) await fileStore.patch(id, { bytes: bytes.kind });
    const appender = new FileAppender(bytes, id, offset);
    return {
      offset,
      append: (chunk) => appender.append(chunk),
      flush: () => appender.flush(),
      verify: async (digest) => { await appender.close(); return (await bytes.digest(id)) === digest; },
      discard: async () => { await appender.close().catch(() => {}); await bytes.remove(id); },
    };
  }

  private async openSource(linkId: string, record: FileTransferRecord): Promise<OutgoingSource> {
    const id = outgoingFileId(linkId, record.id);
    const stored = await fileStore.get(id);
    if (!stored) throw new Error("The file is gone");
    return {
      read: (offset, length) => readStored(stored, offset, length),
      digest: async () => {
        if (stored.digest) return stored.digest;
        const digest = stored.blob ? await blobDigest(stored.blob) : await (await fileBytesOf(stored.bytes!))!.digest(id);
        await fileStore.patch(id, { digest });
        return digest;
      },
    };
  }

  private changed(linkId: string, record: FileTransferRecord, transferred: number, progress: boolean): void {
    const chat = this.chat(linkId);
    if (record.direction === "in" && !chat.local.has(record.id)) {
      // A new offer: its file and its message, then its record.
      const id = `${linkId}-in-${toBase64Url(randomBytes(12))}`;
      chat.local.set(record.id, id);
      this.deps.wireIds(linkId)?.add(record.id);
      const { file } = record;
      const message: MessageFile = { id, name: file.name, size: file.size, mime: file.mime, ...(file.voice && { voice: file.voice }), ...(file.video && { video: file.video }), ...(file.image && { image: file.image }) };
      chat.saving = chat.saving.then(async () => {
        await fileStore.put({ id, linkId, direction: "in", wireId: record.id, createdAt: Date.now(), bytes: (await fileBytes()).kind,
          metadata: { name: file.name, size: file.size, mime: file.mime, timestamp: file.timestamp, voice: file.voice, video: file.video, image: file.image }, wire3: record });
        await this.deps.storeMessage({ linkId, id: `peer_${record.id}`, text: fileMessageText(message), sender: "peer", timestamp: file.timestamp, via: "datalink", file: message,
          ...(file.reply && { replyTo: receivedPairedReply(file.reply) }), ...(file.forwarded && { forwarded: file.forwarded }),
          details: { wire: fileWire("files/3", file.size) } });
      }).catch(() => {});
    }
    const offered = record.direction === "in" && !this.deps.transfers.has(chat.local.get(record.id)!);
    this.show(linkId, chat, record, transferred, progress);
    // The app has a new file's transfer before its message: a file shown with neither a transfer nor its bytes reads
    // as gone, and one that arrived within `changed`'s wait (250 ms behind another's progress) said "No longer available".
    if (offered) this.deps.flush?.();
    const id = record.direction === "out" ? outgoingFileId(linkId, record.id) : chat.local.get(record.id)!;
    const now = Date.now();
    if (!progress || now - (chat.lastSaved.get(id) ?? 0) >= SAVE_EVERY_MS) {
      chat.lastSaved.set(id, now);
      const transfer = this.deps.transfers.get(id);
      chat.saving = chat.saving.then(() => fileStore.patch(id, { wire3: record, ...(transfer && { transfer: { state: transfer.state, transferred: transfer.transferred, size: transfer.size, error: transfer.error } }) })).catch(() => {});
    }
    if (record.state === "done" && record.direction === "in") this.deps.wireIds(linkId)?.add(record.id);
    this.deps.changed(progress ? 250 : 50);
  }

  private show(linkId: string, chat: Chat, record: FileTransferRecord, transferred: number, progress = false): void {
    const id = record.direction === "out" ? outgoingFileId(linkId, record.id) : chat.local.get(record.id);
    if (!id) return;
    const view = this.view(chat, record, transferred, this.stalled(linkId, id, record, progress));
    if (view.state === "transferring" && !view.stage) {
      const now = Date.now(), last = this.speeds.get(id);
      if (!last) this.speeds.set(id, { bytes: transferred, at: now, rate: 0 });
      else if (now - last.at >= 500) {
        const rate = Math.max(0, (transferred - last.bytes) * 1000 / (now - last.at));
        this.speeds.set(id, { bytes: transferred, at: now, rate: last.rate ? last.rate * 0.6 + rate * 0.4 : rate });
      }
      const rate = this.speeds.get(id)!.rate;
      if (rate) view.rate = rate;
    } else this.speeds.delete(id);
    if (view.stage === "asking" && record.direction === "in") { view.room = this.deps.transfers.get(id)?.room; void this.room(id); }
    this.deps.transfers.set(id, view);
    // Ended, then going again (sent again, taken again): its next end is reported too.
    if (!transferEnded(record)) { this.underway.add(id); this.ended.delete(id); }
    else if (!this.ended.has(id)) { this.ended.add(id); this.deps.settled?.(linkId, id, record, this.underway.delete(id)); }
  }

  /**
   * Whether a transfer is stuck (`transferStalled`): not moved for `FILE_LIMITS.stallMs`, or not since the app started.
   * Only bytes moving count (`progress`: confirmed by the receiver, stored here), not a session saying again where it
   * stands. A stall is nothing happening, so a timer looks again when it would be one.
   */
  private stalled(linkId: string, id: string, record: FileTransferRecord, progress: boolean): boolean {
    if (transferEnded(record)) { this.unwatch(id); return false; }
    const now = Date.now();
    if (progress || !this.moved.has(id)) this.moved.set(id, { at: now });
    if (progress) this.restored.delete(id);
    const movedAt = this.moved.get(id)!.at;
    const stalled = transferStalled(record, movedAt, this.restored.has(id), now);
    // Only what can be stuck is looked at again (not an offer waiting for an answer, nor a pause).
    if (!stalled && !this.stallChecks.has(id) && transferStalled(record, 0, true, now)) {
      const check = setTimeout(() => {
        this.stallChecks.delete(id);
        const chat = this.chats.get(linkId), wireId = record.id;
        const current = chat?.files.get(record.direction, wireId);
        if (!chat || !current) return;
        const before = this.deps.transfers.get(id)?.stalled;
        this.show(linkId, chat, current, chat.files.transferred(record.direction, wireId));
        if (this.deps.transfers.get(id)?.stalled !== before) this.deps.changed();
      }, Math.max(1_000, movedAt + FILE_LIMITS.stallMs - now));
      // A headless app (the CLI) is not kept running for it.
      (check as { unref?: () => void }).unref?.();
      this.stallChecks.set(id, check);
    }
    return stalled;
  }
  /** Transfers already reported as ended, by local id. */
  private readonly ended = new Set<string>();
  /** Transfers seen under way in this run, until they end. */
  private readonly underway = new Set<string>();

  /** The free space an offer is decided against, shown with it. */
  private async room(id: string): Promise<void> {
    const room = await (await fileBytes()).room().catch(() => null);
    const current = this.deps.transfers.get(id);
    if (current?.stage !== "asking" || current.room === room) return;
    this.deps.transfers.set(id, { ...current, room });
    this.deps.changed();
  }

  private view(chat: Chat, record: FileTransferRecord, transferred: number, stalled = false): FileTransferView {
    const base = { transferred, size: record.file.size, direction: record.direction, ...(stalled && { stalled: true }) };
    switch (record.state) {
      case "done": return { ...base, state: "done", transferred: record.file.size };
      case "failed": return { ...base, state: "failed", error: record.error, retry: record.direction === "out" };
      case "declined": case "cancelled": return { ...base, state: "failed", error: record.error };
    }
    const live = chat.files.live;
    if (record.state === "asking") return { ...base, state: "transferring", stage: record.waitingFor === "busy" ? "queued" : "asking" };
    if (record.state === "paused") return { ...base, state: "transferring", stage: "paused", pausedBy: record.pausedBy };
    if (!live) return { ...base, state: "transferring", stage: "waiting" };
    if (record.state === "queued" && record.direction === "in") return { ...base, state: "transferring", stage: "queued" };
    if (record.state === "verifying") return { ...base, state: "transferring", stage: "verifying" };
    return { ...base, state: "transferring" };
  }
}
