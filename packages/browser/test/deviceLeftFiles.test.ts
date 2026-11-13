import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HANDOFF_PIECE_BYTES, handoffFileRequestFrame, randomBytes, seedSigner, toBase64Url, type DeviceFrame } from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type FetchFile, type StoredDeviceState } from "../src/devices/state";
import { HandoffGiver, HandoffTaker, type HandoffFile, type HandoffLinks, type HandoffRecords, type HandoffSelf, type HandoffSource, type HandoffStaging, type HandoffStagingHost } from "../src/devices/handoff";
import { makeHandoffVerifier, type HandoffVerifier } from "../src/devices/handoffPake";
import type { TurnOutcome } from "../src/devices/turn";
// covers: devices.handoff.machine

/*
 * Files left for later (WISP 06 § What moves, Files): a move on mobile data leaves the files over its limit on the device
 * it came from, and the device that took the profile fetches them over the device link (`handoff-file-request`). The
 * two sides of a pull run against each other as in `deviceHandoff.test.ts` (a trimmed copy of its fakes); then the old
 * device, now on standby, serves (`LeftFilesServer`) and the new active one fetches (`LeftFilesFetcher`). Test values only.
 */

type FilesModule = typeof import("../src/devices/handoffFiles");
/** Loaded when a test asks: a build without it fails each test that needs it, not the file. */
const filesModule = (): Promise<FilesModule> => import("../src/devices/handoffFiles");

const PASSWORD = "a long lock password";
const giverKey = seedSigner(sha256(new TextEncoder().encode("left files giver")));
const takerKey = seedSigner(sha256(new TextEncoder().encode("left files taker")));
const A = toBase64Url(giverKey.publicKey), B = toBase64Url(takerKey.publicKey);
const D = toBase64Url(new Uint8Array(32).fill(0xd0));
const turnAddress = new Uint8Array(32).fill(0xaa);
const N = 100;
/** What the app sends on mobile data is 16 MiB; the probe's 50,000 bytes keep the test small. */
const LATER = 50_000;

let verifierPromise: Promise<HandoffVerifier> | null = null;
const verifier = () => (verifierPromise ??= makeHandoffVerifier(PASSWORD));

function bytesOf(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536) out.set(randomBytes(Math.min(65_536, length - at)), at);
  return out;
}
const digestOf = (bytes: Uint8Array) => toBase64Url(sha256(bytes));

const set = [{ key: A, name: "Desktop" }, { key: B, name: "Phone" }];
const recordFor = (profile: string, own: number, state: "active" | "standby"): DeviceRecord =>
  firstRecord(profile, state, { turn: N, d: D, deviceSet: set, ownSlot: own, activeSlot: 0, turnPacket: "AAAA" });

class Records implements HandoffRecords {
  constructor(public record: DeviceRecord) {}
  async read() { return this.record; }
  async amend(patch: DevicePatch) { return (this.record = { ...amend(this.record, patch), saved: this.record.saved + 1 }); }
  async move(to: StoredDeviceState, patch: DevicePatch = {}) { return (this.record = { ...transition(this.record, this.record.profile, to, patch), saved: this.record.saved + 1 }); }
}

type Handler = { receive(from: string, frame: DeviceFrame): unknown; linkChanged(key: string, live: boolean): void };

/** The device link between A and B: frames in order, a new transcript at every session, nothing across a drop. */
class Link {
  live = true;
  transcript = bytesToHex(randomBytes(32));
  private handlers = new Map<string, Handler>();
  private queue: { to: string; from: string; frame: DeviceFrame; session: string }[] = [];
  sent: { from: string; frame: DeviceFrame }[] = [];
  /** Drops a frame on its way (null). */
  meddle?: (from: string, frame: DeviceFrame) => DeviceFrame | null;

  attach(key: string, handler: Handler): void { this.handlers.set(key, handler); }

  end(own: string, other: string): HandoffLinks {
    return {
      live: (key) => key === other && this.live,
      transcript: (key) => (key === other && this.live ? this.transcript : undefined),
      send: (key, frame) => {
        if (key !== other || !this.live) throw new Error("This device is not connected");
        this.sent.push({ from: own, frame });
        const copy = JSON.parse(JSON.stringify(frame)) as DeviceFrame;
        const changed = this.meddle ? this.meddle(own, copy) : copy;
        if (changed) this.queue.push({ to: other, from: own, frame: changed, session: this.transcript });
        queueMicrotask(() => this.flush());
      },
    };
  }

  private flushing = false;
  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        if (item.session !== this.transcript || !this.live) continue;
        void this.handlers.get(item.to)?.receive(item.from, item.frame);
      }
    } finally { this.flushing = false; }
  }

  drop(): void {
    this.live = false;
    this.queue = [];
    for (const [key, handler] of this.handlers) handler.linkChanged(key === A ? B : A, false);
  }

  reconnect(): void {
    this.transcript = bytesToHex(randomBytes(32));
    this.live = true;
    for (const [key, handler] of this.handlers) handler.linkChanged(key === A ? B : A, true);
  }

  frames(type: string, from?: string): DeviceFrame[] {
    return this.sent.filter((s) => s.frame.t === type && (!from || s.from === from)).map((s) => s.frame);
  }
}

class Profile implements HandoffSource {
  files_ = new Map<string, Uint8Array>();
  rest = bytesOf(3_000);
  add(id: string, bytes: Uint8Array): HandoffFile {
    this.files_.set(id, bytes);
    return { id, size: bytes.length, sha256: digestOf(bytes) };
  }
  async files() { return [...this.files_].map(([id, bytes]) => ({ id, size: bytes.length, sha256: digestOf(bytes) })); }
  async read(id: string, offset: number, length: number) {
    const bytes = this.files_.get(id);
    if (!bytes) throw new Error("That file is not on this device");
    return bytes.subarray(offset, offset + length);
  }
  async bundle() { return this.rest; }
}

class Storage implements HandoffStagingHost {
  spaces = new Map<string, { files: Map<string, Uint8Array>; held: Map<string, HandoffFile> }>();
  pointer = "ghostly";
  private next = 0;
  async open(database?: string): Promise<HandoffStaging> {
    const name = database ?? `ghostly_stage${++this.next}`;
    if (!this.spaces.has(name)) this.spaces.set(name, { files: new Map(), held: new Map() });
    const space = this.spaces.get(name)!;
    return {
      database: name,
      held: async () => [...space.held.values()],
      begin: async (id) => { space.files.set(id, new Uint8Array()); space.held.delete(id); },
      append: async (id, _offset, bytes) => {
        const was = space.files.get(id) ?? new Uint8Array();
        const next = new Uint8Array(was.length + bytes.length); next.set(was); next.set(bytes, was.length);
        space.files.set(id, next);
      },
      finish: async (file) => { space.held.set(file.id, file); },
      discard: async (id) => { space.files.delete(id); space.held.delete(id); },
      copyHeld: async () => {},
      copyStaged: async (fromId, file) => { space.files.set(file.id, space.files.get(fromId)!.slice()); space.held.set(file.id, file); },
      restore: async () => {},
      dropRest: async () => {},
      room: async () => null,
    };
  }
  async install(_old: string, staged: string) { this.pointer = staged; }
  async revert(old: string) { this.pointer = old; }
  async drop(database: string) { this.spaces.delete(database); }
}

/** The new active device's live profile: its files' bytes, and which records point at them. */
class LiveFiles {
  bytes = new Map<string, Uint8Array>();
  pointed = new Map<string, string>();
  async size(id: string) { return this.bytes.get(id)?.length ?? null; }
  async append(id: string, offset: number, piece: Uint8Array) {
    const was = this.bytes.get(id) ?? new Uint8Array();
    if (offset !== was.length) throw new Error(`append at ${offset}, stored ${was.length}`);
    const next = new Uint8Array(was.length + piece.length); next.set(was); next.set(piece, was.length);
    this.bytes.set(id, next);
  }
  async discard(id: string) { this.bytes.delete(id); }
  async finish(file: FetchFile) {
    const stored = this.bytes.get(file.ids[0]!);
    if (!stored || stored.length !== file.size || digestOf(stored) !== file.sha256) return false;
    for (const id of file.ids) { if (id !== file.ids[0]) this.bytes.set(id, stored.slice()); this.pointed.set(id, file.sha256); }
    return true;
  }
}

const self = (): HandoffSelf => ({ app: "1.1.0", db: 12, pins: {}, kind: "web", room: -1, metered: false });

interface World {
  link: Link; profile: Profile; storage: Storage; live: LiveFiles;
  giverRecords: Records; takerRecords: Records;
  giver: HandoffGiver; taker: HandoffTaker;
  quiesced: number; reloads: number;
  makeGiver(phase: "active" | "gated"): HandoffGiver;
  makeTaker(): HandoffTaker;
}
const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

function world(): World {
  const w = { link: new Link(), profile: new Profile(), storage: new Storage(), live: new LiveFiles(), quiesced: 0, reloads: 0,
    giverRecords: new Records(recordFor("ghostly_a", 0, "active")), takerRecords: new Records(recordFor("ghostly", 1, "standby")) } as unknown as World;
  w.makeGiver = (phase) => {
    const giver = new HandoffGiver({
      ownKey: giverKey.publicKey, sign: async (bytes) => giverKey.sign(bytes), turnAddress, links: w.link.end(A, B), records: w.giverRecords,
      self: async () => self(), source: w.profile, verifier: async () => (phase === "gated" ? null : verifier()), busy: async () => null,
      ...(phase === "active" ? { quiesce: async (patch: DevicePatch) => { w.quiesced += 1; await w.giverRecords.move("releasing", patch); } } : {}),
      ...(phase === "gated" ? { backToActive: async () => {}, dropDatabases: async () => {} } : {}),
    });
    w.link.attach(A, giver);
    stops.push(() => giver.stop());
    return giver;
  };
  w.makeTaker = () => {
    const taker = new HandoffTaker({
      ownKey: takerKey.publicKey, sign: async (bytes) => takerKey.sign(bytes), turnAddress, links: w.link.end(B, A), records: w.takerRecords,
      self: async () => self(), staging: w.storage, reload: () => { w.reloads += 1; },
      take: async () => ({ kind: "start", read: { result: "mine", good: true, seen: 0n, invalid: [], unsigned: [], conditions: {}, record: { sequence: (N + 1) * 2 ** 20 + 1 } } }) as unknown as TurnOutcome,
      install: async (staged, patch) => { await w.takerRecords.amend(patch); w.takerRecords.record = { ...w.takerRecords.record, profile: staged }; },
      standbyUnder: async () => {}, forget: async () => {},
    });
    w.link.attach(B, taker);
    stops.push(() => taker.stop());
    return taker;
  };
  w.giver = w.makeGiver("active");
  w.taker = w.makeTaker();
  return w;
}

async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!what()) { if (Date.now() - start > ms) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 2)); }
}
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/**
 * A pull with `later` (0: none), to the end: A on standby with its frozen copy, B installed under the staged name, and,
 * as the turn keeper does at B's settle read, B `active`.
 */
async function move(w: World, later: number): Promise<void> {
  await w.taker.pull(PASSWORD, later);
  await until(() => w.quiesced === 1);
  w.giver.stop(); w.link.drop();
  w.giver = w.makeGiver("gated");
  await w.giver.resume();
  w.link.reconnect();
  await until(() => w.reloads === 1);
  w.taker.stop();
  w.taker = w.makeTaker();
  await w.taker.resume();
  await until(() => w.reloads === 2);
  await w.takerRecords.move("active");
  expect([w.giverRecords.record.state, w.takerRecords.record.state]).toEqual(["standby", "active"]);
}

/** After the move: the standby serves beside its giver, as device-link-only mode routes them; the active device fetches. */
async function afterMove(w: World, metered: { on: boolean }) {
  const { LeftFilesServer, LeftFilesFetcher } = await filesModule();
  const server = new LeftFilesServer({ links: w.link.end(A, B), records: w.giverRecords, read: (id, offset, length) => w.profile.read(id, offset, length) });
  const giver = w.giver;
  w.link.attach(A, { receive: (from, frame) => (server.takes(from, frame) ? server.receive(from, frame) : giver.receive(from, frame)), linkChanged: (key, live) => { giver.linkChanged(key, live); server.linkChanged(key, live); } });
  const fetcher = new LeftFilesFetcher({ links: w.link.end(B, A), records: w.takerRecords, store: w.live, metered: () => metered.on });
  w.link.attach(B, { receive: (from, frame) => (fetcher.takes(frame) ? fetcher.receive(from, frame) : undefined), linkChanged: (key, live) => fetcher.linkChanged(key, live) });
  stops.push(() => { server.stop(); fetcher.stop(); });
  return { server, fetcher };
}

describe("a move on mobile data: files over the limit stay on the old device", () => {
  it("the device that took the profile notes each file left behind, on which device, under which ids", async () => {
    const w = world();
    w.profile.add("small", bytesOf(1_000));
    const large = w.profile.add("large", bytesOf(70_000));
    w.profile.add("large-twin", w.profile.files_.get("large")!);
    await move(w, LATER);
    expect(w.giverRecords.record.leftFiles?.map((file) => file.sha256)).toEqual([large.sha256, large.sha256]);
    expect(w.takerRecords.record.fetchFiles).toEqual([{ sha256: large.sha256, size: large.size, ids: ["large", "large-twin"], on: A }]);
  });

  it("with nothing left for later (Wi-Fi), there is nothing to fetch", async () => {
    const w = world();
    w.profile.add("large", bytesOf(70_000));
    await move(w, 0);
    expect(w.giverRecords.record.leftFiles ?? []).toEqual([]);
    expect(w.takerRecords.record.fetchFiles).toBeUndefined();
  });

  it("off mobile data, the new active device fetches the file over the device link and its records point at it", async () => {
    const w = world();
    const large = w.profile.add("large", bytesOf(70_000));
    w.profile.add("large-twin", w.profile.files_.get("large")!);
    await move(w, LATER);
    const { fetcher } = await afterMove(w, { on: false });
    await fetcher.kick();
    await until(() => w.takerRecords.record.fetchFiles === undefined);
    expect(w.link.frames("handoff-file-request", B).map((frame) => frame.sha256)).toEqual([large.sha256]);
    expect(w.link.frames("handoff-data", A).filter((frame) => frame.p === `file/${large.sha256}`).length).toBe(Math.ceil(large.size / HANDOFF_PIECE_BYTES));
    expect(digestOf(w.live.bytes.get("large")!)).toBe(large.sha256);
    expect(digestOf(w.live.bytes.get("large-twin")!)).toBe(large.sha256);
    expect([...w.live.pointed.keys()].sort()).toEqual(["large", "large-twin"]);
  });

  it("on mobile data it waits: fetched when the connection is no longer metered, or at once when the person asks", async () => {
    for (const how of ["off mobile data", "asked"] as const) {
      const w = world();
      const large = w.profile.add("large", bytesOf(70_000));
      await move(w, LATER);
      const metered = { on: true };
      const { fetcher } = await afterMove(w, metered);
      await fetcher.kick();
      await settle();
      expect(w.link.frames("handoff-file-request", B)).toEqual([]);
      if (how === "asked") await fetcher.fetchNow(A);
      else { metered.on = false; await fetcher.kick(); }
      await until(() => w.takerRecords.record.fetchFiles === undefined);
      expect(digestOf(w.live.bytes.get("large")!)).toBe(large.sha256);
    }
  });

  it("a link that drops halfway goes on from the bytes written, on the next session", async () => {
    const w = world();
    const large = w.profile.add("large", bytesOf(HANDOFF_PIECE_BYTES * 3 + 500));
    await move(w, LATER);
    // The first piece arrives; the link goes before the rest.
    let pieces = 0;
    w.link.meddle = (from, frame) => (from === A && frame.t === "handoff-data" && ++pieces > 1 ? null : frame);
    const { fetcher } = await afterMove(w, { on: false });
    await fetcher.kick();
    await until(() => (w.live.bytes.get("large")?.length ?? 0) === HANDOFF_PIECE_BYTES);
    w.link.drop();
    w.link.meddle = undefined;
    w.link.reconnect();
    await until(() => w.takerRecords.record.fetchFiles === undefined);
    expect(w.link.frames("handoff-file-request", B).map((frame) => frame.o ?? 0)).toEqual([0, HANDOFF_PIECE_BYTES]);
    expect(digestOf(w.live.bytes.get("large")!)).toBe(large.sha256);
  });

  it("a file the standby no longer holds is answered as missing, and leaves the list", async () => {
    const w = world();
    w.profile.add("large", bytesOf(70_000));
    await move(w, LATER);
    // Gone from the frozen copy since (its storage was cleared).
    w.profile.files_.delete("large");
    const { fetcher } = await afterMove(w, { on: false });
    await fetcher.kick();
    await until(() => w.takerRecords.record.fetchFiles === undefined);
    expect(w.link.frames("handoff-file-missing", A).length).toBe(1);
    expect(w.live.bytes.size).toBe(0);
  });

  it("the standby answers only the device it knows active, and only for files it left for later", async () => {
    const w = world();
    const small = w.profile.add("small", bytesOf(1_000));
    const large = w.profile.add("large", bytesOf(70_000));
    await move(w, LATER);
    // On mobile data: the active device's own fetcher asks nothing meanwhile.
    const { server } = await afterMove(w, { on: true });
    // A file that moved with the profile is not served again: the standby says it has no such file.
    await server.receive(B, handoffFileRequestFrame(small.sha256));
    await settle();
    expect(w.link.frames("handoff-file-missing", A).map((frame) => frame.sha256)).toEqual([small.sha256]);
    // The giver's record names B active: a request from any other key gets nothing.
    await server.receive(toBase64Url(new Uint8Array(32).fill(7)), handoffFileRequestFrame(large.sha256));
    await settle();
    expect(w.link.frames("handoff-data", A).filter((frame) => frame.p === `file/${large.sha256}`)).toEqual([]);
  });

  it("Remove of the old device knows what is still only there: count and bytes, until it is fetched", async () => {
    const { filesOn } = await filesModule();
    const w = world();
    const large = w.profile.add("large", bytesOf(70_000));
    await move(w, LATER);
    expect(filesOn(w.takerRecords.record, A)).toEqual({ count: 1, bytes: large.size });
    expect(filesOn(w.takerRecords.record, B)).toBeNull();
    const { fetcher } = await afterMove(w, { on: false });
    await fetcher.kick();
    await until(() => w.takerRecords.record.fetchFiles === undefined);
    expect(filesOn(w.takerRecords.record, A)).toBeNull();
  });

  it("a take that lost keeps no list: the files were for the profile it would have run", () => {
    const fetchFiles: FetchFile[] = [{ sha256: digestOf(new Uint8Array(1)), size: 70_000, ids: ["large"], on: A }];
    const taking = transition(transition(recordFor("ghostly", 1, "standby"), "ghostly", "taking", { fetchFiles }), "ghostly", "standby");
    expect(taking.fetchFiles).toBeUndefined();
    expect(transition(transition(recordFor("ghostly", 1, "standby"), "ghostly", "taking", { fetchFiles }), "ghostly", "active").fetchFiles).toEqual(fetchFiles);
  });
});
