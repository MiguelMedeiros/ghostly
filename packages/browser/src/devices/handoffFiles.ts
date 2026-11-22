import {
  HANDOFF_ACK, HANDOFF_DATA, HANDOFF_FILE_MISSING, HANDOFF_FILE_REQUEST, HANDOFF_TIMINGS, filePartDigest, filePartName, fromBase64Url, handoffAckFrame, handoffFileKey,
  handoffFileMissingFrame, handoffFileRequestFrame, openHandoffPiece, readHandoffAck, readHandoffData, readHandoffFileFrame, type DeviceFrame,
} from "@ghostly/core";
import { PartSender, type HandoffLinks, type HandoffRecords } from "./handoff";
import type { DeviceRecord, FetchFile } from "./state";

/*
 * Files left for later (WISP 06 § What moves, Files: "fetched over the device link when both are on"). A handoff on
 * mobile data leaves the files over its limit on the device it came from; that device notes them at quiesce
 * (`leftFiles`), the device that took the profile notes them with the release (`fetchFiles`).
 *
 * - `LeftFilesServer` runs on the standby that holds them (device-link-only mode): it answers `handoff-file-request` from
 *   the device its record names active with the file's pieces, found through `leftFiles`, or `handoff-file-missing`.
 * - `LeftFilesFetcher` runs in the engine of the active device: one file at a time, from the device that holds it, while
 *   the link to it is live and the connection is not metered, or at once when the person asks (Remove offers it). A
 *   file whose bytes are written and checked points its records at them, and leaves the list.
 */

/** The file key of the link's open session, or null without one or without `D`. */
function fileKey(record: DeviceRecord | null, links: HandoffLinks, key: string): { key: Uint8Array; transcript: string } | null {
  const transcript = links.transcript(key);
  if (!record?.d || !transcript) return null;
  try { return { key: handoffFileKey(fromBase64Url(record.d), transcript), transcript }; } catch { return null; }
}

const activeKey = (record: DeviceRecord): string | undefined => (record.activeSlot === undefined ? undefined : record.deviceSet[record.activeSlot]?.key);

export interface LeftFilesServerPorts {
  links: HandoffLinks;
  records: Pick<HandoffRecords, "read">;
  /** Bytes of a file of this device's frozen copy, by its id there (`LeftFile.where`). */
  read(id: string, offset: number, length: number): Promise<Uint8Array>;
  now?(): number;
}

/** The standby's side: serves the files its record left for later, to the active device only, one at a time. */
export class LeftFilesServer {
  private sending: { peer: string; part: string; sender: PartSender } | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly ports: LeftFilesServerPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** Whether a frame is this server's: a request, or a confirmation of the file it sends to that device. */
  takes(from: string, frame: DeviceFrame): boolean {
    if (frame.t === HANDOFF_FILE_REQUEST) return true;
    return frame.t === HANDOFF_ACK && this.sending?.peer === from && readHandoffAck(frame)?.part === this.sending.part;
  }

  async receive(from: string, frame: DeviceFrame): Promise<void> {
    if (this.stopped) return;
    if (frame.t === HANDOFF_ACK) {
      const ack = readHandoffAck(frame);
      if (ack && this.sending?.peer === from && ack.part === this.sending.part) this.sending.sender.ack(ack.part, ack.offset);
      return;
    }
    const request = readHandoffFileFrame(frame);
    if (!request || request.missing) return;
    const record = await this.ports.records.read().catch(() => null);
    // Only a standby serves, and only to the device it knows active: its frozen copy is what it holds.
    if (!record || record.state !== "standby" || activeKey(record) !== from) return;
    const left = record.leftFiles?.find((file) => file.sha256 === request.sha256);
    const sealing = fileKey(record, this.ports.links, from);
    if (!sealing) return;
    const out = (f: DeviceFrame) => { try { this.ports.links.send(from, f); } catch { /* the link dropped: the active device asks again */ } };
    if (!left || request.offset > left.size) { out(handoffFileMissingFrame(request.sha256)); return; }
    // A new request replaces the file being sent: the active device asks for one at a time.
    this.sending?.sender.stop();
    const part = filePartName(left.sha256);
    const sender = new PartSender(this.now);
    this.sending = { peer: from, part, sender };
    void sender.send([{ name: part, size: left.size, read: (offset, length) => this.ports.read(left.where, offset, length) }], { [part]: request.offset }, sealing.key, out)
      // The bytes are not here any more (the copy was cleared, the file storage lost them).
      .catch(() => { sender.stop(); out(handoffFileMissingFrame(left.sha256)); })
      .finally(() => { if (this.sending?.sender === sender) this.sending = null; });
  }

  linkChanged(key: string, live: boolean): void {
    if (!live && this.sending?.peer === key) { this.sending.sender.stop(); this.sending = null; }
  }

  stop(): void {
    this.stopped = true;
    this.sending?.sender.stop();
    this.sending = null;
  }
}

/** Where the active device writes a fetched file: its live profile's file storage and records. */
export interface LeftFilesStore {
  /** Bytes stored under `id`, or null when none. */
  size(id: string): Promise<number | null>;
  /** Writes at `offset`, the stored size. */
  append(id: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** The bytes under `id` go. */
  discard(id: string): Promise<void>;
  /**
   * The bytes under `file.ids[0]` are all here: checked against `file.sha256` as stored, and each record of the file
   * pointed at them (copied for the other ids). False when they are not the file; nothing was changed then.
   */
  finish(file: FetchFile): Promise<boolean>;
}

export interface LeftFilesFetcherPorts {
  links: HandoffLinks;
  records: HandoffRecords;
  store: LeftFilesStore;
  /** On a connection that costs by the byte (mobile data): files left for later wait, unless the person asked. */
  metered(): boolean;
  now?(): number;
  /** The list changed (a file came, or is gone for good). */
  onChange?(): void;
}

/** What the active device is fetching now. */
interface Fetching { peer: string; file: FetchFile; got: number; transcript: string; key: Uint8Array; retried: boolean }

/** The active device's side: fetches the files left for later, one at a time, and goes on where a dropped link left it. */
export class LeftFilesFetcher {
  private current: Fetching | null = null;
  /** Devices the person asked to fetch from now, whatever the connection costs. */
  private asked = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly ports: LeftFilesFetcherPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** The frames this fetcher takes: a piece of a file part, and the standby saying it has no such file. */
  takes(frame: DeviceFrame): boolean {
    if (frame.t === HANDOFF_FILE_MISSING) return true;
    return frame.t === HANDOFF_DATA && typeof frame.p === "string" && filePartDigest(frame.p) !== null;
  }

  receive(from: string, frame: DeviceFrame): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped || !this.current || from !== this.current.peer) return;
      if (frame.t === HANDOFF_FILE_MISSING) {
        const missing = readHandoffFileFrame(frame);
        // Gone from that device too: nothing to wait for.
        if (missing?.missing && missing.sha256 === this.current.file.sha256) await this.done();
        return;
      }
      await this.onData(frame);
    }).then(() => this.kick());
  }

  linkChanged(key: string, live: boolean): void {
    void this.exclusive(async () => {
      // What was written stays: the request on the next session says from where.
      if (!live && this.current?.peer === key) this.drop();
    }).then(() => (live ? this.kick() : undefined));
  }

  /** "Get them now": the files on that device are fetched while its link is live, on mobile data too. */
  fetchNow(key: string): Promise<void> {
    this.asked.add(key);
    return this.kick();
  }

  /**
   * Asks for the next file when none is on its way: the first one listed on a device whose link is live, unless this
   * device is on a metered connection and the person did not ask. Called at start, at every link that opens, when
   * the connection changes, and after each file.
   */
  kick(): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped || this.current) return;
      const record = await this.ports.records.read().catch(() => null);
      if (!record || record.state !== "active" || !record.fetchFiles?.length) return;
      const listed = new Set(record.deviceSet.flatMap((slot) => (slot ? [slot.key] : [])));
      const metered = this.ports.metered();
      const file = record.fetchFiles.find((f) => listed.has(f.on) && this.ports.links.live(f.on) && (!metered || this.asked.has(f.on)));
      if (!file) return;
      const sealing = fileKey(record, this.ports.links, file.on);
      if (!sealing) return;
      let got = (await this.ports.store.size(file.ids[0]!).catch(() => null)) ?? 0;
      if (got > file.size) { await this.ports.store.discard(file.ids[0]!).catch(() => {}); got = 0; }
      this.current = { peer: file.on, file, got, transcript: sealing.transcript, key: sealing.key, retried: false };
      if (got === file.size) { await this.complete(); return; }
      this.request();
    });
  }

  stop(): void {
    this.stopped = true;
    this.drop();
  }

  private request(): void {
    const current = this.current!;
    this.out(handoffFileRequestFrame(current.file.sha256, current.got));
    this.watch();
  }

  /** Nothing from the standby for `stuckMs`: asked again, from what is written. */
  private watch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.exclusive(async () => { this.drop(); }).then(() => this.kick());
    }, HANDOFF_TIMINGS.stuckMs);
  }

  private async onData(frame: DeviceFrame): Promise<void> {
    const current = this.current!;
    const data = readHandoffData(frame);
    const part = filePartName(current.file.sha256);
    if (!data || data.part !== part || this.ports.links.transcript(current.peer) !== current.transcript) return;
    // A piece written already (sent again) is confirmed again; one past a gap waits for its turn.
    if (data.offset !== current.got) { if (data.offset < current.got) this.out(handoffAckFrame(part, current.got)); return; }
    const piece = openHandoffPiece(current.key, part, data.offset, data.sealed);
    if (!piece || current.got + piece.length > current.file.size) return;
    try { await this.ports.store.append(current.file.ids[0]!, current.got, piece); } catch { this.drop(); return; }
    current.got += piece.length;
    this.watch();
    if (current.got < current.file.size) { this.out(handoffAckFrame(part, current.got)); return; }
    await this.complete();
  }

  /** All its bytes are written: checked, its records pointed at them. A file that is not what it says is fetched once more. */
  private async complete(): Promise<void> {
    const current = this.current!;
    const good = await this.ports.store.finish(current.file).catch(() => false);
    if (good) { this.out(handoffAckFrame(filePartName(current.file.sha256), current.file.size)); await this.done(); return; }
    await this.ports.store.discard(current.file.ids[0]!).catch(() => {});
    if (current.retried) { await this.done(); return; }
    current.got = 0; current.retried = true;
    this.request();
  }

  /** The file leaves the list: fetched, or gone for good. */
  private async done(): Promise<void> {
    const current = this.current!;
    this.drop();
    const record = await this.ports.records.read().catch(() => null);
    if (record?.state !== "active") return;
    const rest = (record.fetchFiles ?? []).filter((file) => !(file.sha256 === current.file.sha256 && file.on === current.peer));
    await this.ports.records.amend({ fetchFiles: rest.length ? rest : undefined }).catch(() => {});
    try { this.ports.onChange?.(); } catch { /* a listener's own trouble */ }
  }

  private drop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.current = null;
  }

  private out(frame: DeviceFrame): void {
    const peer = this.current?.peer;
    if (!peer) return;
    try { this.ports.links.send(peer, frame); } catch { /* the link dropped: asked again when it is back */ }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(work);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** The files to fetch, by the device that holds them: what Remove of that device says is still there. */
export function filesOn(record: Pick<DeviceRecord, "fetchFiles"> | null, key: string): { count: number; bytes: number } | null {
  const files = (record?.fetchFiles ?? []).filter((file) => file.on === key);
  return files.length ? { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) } : null;
}
