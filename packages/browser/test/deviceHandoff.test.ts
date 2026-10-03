import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  HANDOFF_ATTEMPTS, HANDOFF_PIECE_BYTES, HANDOFF_TIMINGS, fromBase64Url, handoffDigest, randomBytes, readHandoffManifest, readTurnPacket, seedSigner,
  toBase64Url, turnReleaseMessage, verify, type DeviceFrame, type HandoffPart, type TurnRelease,
} from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type StoredDeviceState } from "../src/devices/state";
import {
  HandoffGiver, HandoffTaker, WOKEN_CONNECT_MS, type GiverPorts, type HandoffFile, type HandoffLinks, type HandoffRecords, type HandoffSelf, type HandoffSource,
  type BusyReport, type HandoffStaging, type HandoffStagingHost, type HandoffStay, type HandoffView, type LocalBusy, type TakerPorts,
} from "../src/devices/handoff";
import { makeHandoffVerifier, type HandoffVerifier } from "../src/devices/handoffPake";
import type { TurnOutcome } from "../src/devices/turn";
import type { HandoffTakerFacts } from "../src/devices/handoffWallets";
// covers: devices.handoff.machine, devices.push.wake

/*
 * The handoff's two sides (WISP 06 § The handoff, § States and events, § Installing the staged state), run against each
 * other through fakes of their ports: a device link that can drop and come back as a new session, device records with
 * the real rules for a change (`state.ts`), a profile in memory and a staging namespace in memory. A reload is a new
 * giver or taker made from the same record, as device-link-only mode makes one. Every key and password is a test value.
 */

const PASSWORD = "a long lock password";
const giverKey = seedSigner(sha256(new TextEncoder().encode("handoff test giver")));
const takerKey = seedSigner(sha256(new TextEncoder().encode("handoff test taker")));
const thirdKey = seedSigner(sha256(new TextEncoder().encode("handoff test third")));
const A = toBase64Url(giverKey.publicKey), B = toBase64Url(takerKey.publicKey), C = toBase64Url(thirdKey.publicKey);
const D = toBase64Url(new Uint8Array(32).fill(0xd0));
const turnAddress = new Uint8Array(32).fill(0xaa);
const N = 100;

let verifierPromise: Promise<HandoffVerifier> | null = null;
const verifier = () => (verifierPromise ??= makeHandoffVerifier(PASSWORD));

/** Random bytes of any length (the browser's source gives 64 KiB at a time). */
function bytesOf(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536) out.set(randomBytes(Math.min(65_536, length - at)), at);
  return out;
}

const set = [{ key: A, name: "Desktop" }, { key: B, name: "Phone" }, { key: C, name: "Laptop" }];
const recordFor = (profile: string, own: number, state: "active" | "standby"): DeviceRecord =>
  firstRecord(profile, state, { turn: N, d: D, deviceSet: set, ownSlot: own, activeSlot: 0, turnPacket: "AAAA" });

/** A device record in memory, with the real rules for a change. */
class Records implements HandoffRecords {
  writes: { to?: StoredDeviceState; patch: DevicePatch }[] = [];
  constructor(public record: DeviceRecord) {}
  async read() { return this.record; }
  async amend(patch: DevicePatch) { this.writes.push({ patch }); return (this.record = { ...amend(this.record, patch), saved: this.record.saved + 1 }); }
  async move(to: StoredDeviceState, patch: DevicePatch = {}) { this.writes.push({ to, patch }); return (this.record = { ...transition(this.record, this.record.profile, to, patch), saved: this.record.saved + 1 }); }
}

/** The device link between two devices: frames in order, a new transcript at every session, nothing across a drop. */
class Link {
  live = true;
  transcript = bytesToHex(randomBytes(32));
  private handlers = new Map<string, { receive(from: string, frame: DeviceFrame): unknown; linkChanged(key: string, live: boolean): void }>();
  private queue: { to: string; from: string; frame: DeviceFrame; session: string }[] = [];
  sent: { from: string; frame: DeviceFrame }[] = [];
  /** Changes a frame on its way (a test's tampering), or drops it (null). */
  meddle?: (from: string, frame: DeviceFrame) => DeviceFrame | null;

  attach(key: string, handler: { receive(from: string, frame: DeviceFrame): unknown; linkChanged(key: string, live: boolean): void }): void {
    this.handlers.set(key, handler);
  }

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

  count(type: string, from?: string): number {
    return this.sent.filter((s) => s.frame.t === type && (!from || s.from === from)).length;
  }
}

/** A profile in memory: files by id, and the rest as one part. */
class Profile implements HandoffSource {
  files_ = new Map<string, Uint8Array>();
  rest = bytesOf(3_000);
  reads = 0;
  add(id: string, bytes: Uint8Array): HandoffFile {
    this.files_.set(id, bytes);
    return { id, size: bytes.length, sha256: toBase64Url(sha256(bytes)) };
  }
  async files() { return [...this.files_].map(([id, bytes]) => ({ id, size: bytes.length, sha256: toBase64Url(sha256(bytes)) })); }
  async read(id: string, offset: number, length: number) { this.reads += 1; return this.files_.get(id)!.subarray(offset, offset + length); }
  async bundle() { return this.rest; }
}

/** The taker's storage: staging namespaces in memory, the frozen copy's files, and the registry pointer. */
class Storage implements HandoffStagingHost {
  frozen = new Map<string, Uint8Array>();
  spaces = new Map<string, { files: Map<string, Uint8Array>; held: Map<string, HandoffFile>; restored: { bundle: Uint8Array; files: HandoffFile[] } | null }>();
  pointer = "ghostly";
  dropped: string[] = [];
  room: number | null = null;
  private next = 0;
  async open(database?: string): Promise<HandoffStaging> {
    const name = database ?? `ghostly_stage${++this.next}`;
    if (!this.spaces.has(name)) this.spaces.set(name, { files: new Map(), held: new Map(), restored: null });
    const space = this.spaces.get(name)!;
    return {
      database: name,
      held: async () => [...space.held.values()],
      begin: async (id) => { space.files.set(id, new Uint8Array()); space.held.delete(id); },
      append: async (id, offset, bytes) => {
        const was = space.files.get(id) ?? new Uint8Array();
        if (offset !== was.length) throw new Error(`append at ${offset}, stored ${was.length}`);
        const next = new Uint8Array(was.length + bytes.length); next.set(was); next.set(bytes, was.length);
        space.files.set(id, next);
      },
      finish: async (file) => { space.held.set(file.id, file); },
      discard: async (id) => { space.files.delete(id); space.held.delete(id); },
      copyHeld: async (fromId, file) => { space.files.set(file.id, this.frozen.get(fromId)!.slice()); space.held.set(file.id, file); },
      copyStaged: async (fromId, file) => { space.files.set(file.id, space.files.get(fromId)!.slice()); space.held.set(file.id, file); },
      restore: async (bundle, files) => { space.restored = { bundle: bundle.slice(), files }; },
      dropRest: async () => { space.restored = null; },
      room: async () => this.room,
    };
  }
  async install(old: string, staged: string) { expect(this.pointer).toBe(old); this.pointer = staged; }
  async revert(old: string, staged: string) { expect(this.pointer).toBe(staged); this.pointer = old; }
  async drop(database: string) { this.dropped.push(database); this.spaces.delete(database); }
}

const self = (extra: Partial<HandoffSelf> = {}): HandoffSelf => ({ app: "1.1.0", db: 12, pins: { ark: "0.4.76" }, kind: "web", room: -1, metered: false, ...extra });

interface World {
  link: Link; profile: Profile; storage: Storage;
  giverRecords: Records; takerRecords: Records;
  giver: HandoffGiver; taker: HandoffTaker;
  busy: { why: LocalBusy | BusyReport | null };
  /** Who the giver said would take, at each check of its wallets, and at quiesce. */
  asked: (HandoffTakerFacts | undefined)[]; quiescedFor: (HandoffTakerFacts | undefined)[];
  /** What the engine adds to the record at quiesce (the Breez databases of wallets that move), and what stays here. */
  quiesceExtra: DevicePatch; stays: HandoffStay[];
  /** The databases the giver deleted once on standby. */
  droppedDatabases: string[][];
  quiesced: DevicePatch[]; reloads: number; activeAgain: number;
  takes: { release: TurnRelease; turn: number }[];
  takeOutcome: () => TurnOutcome | null;
  giverSelf: Partial<HandoffSelf>; takerSelf: Partial<HandoffSelf>;
  makeGiver(phase: "active" | "gated"): HandoffGiver;
  makeTaker(): HandoffTaker;
}
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) { w.giver.stop(); w.taker.stop(); } vi.useRealTimers(); });

function world(options: { verifier?: boolean } = {}): World {
  const w = {
    link: new Link(), profile: new Profile(), storage: new Storage(),
    giverRecords: new Records(recordFor("ghostly_a", 0, "active")), takerRecords: new Records(recordFor("ghostly", 1, "standby")),
    busy: { why: null }, asked: [], quiescedFor: [], quiesceExtra: {}, stays: [], droppedDatabases: [], quiesced: [], reloads: 0, activeAgain: 0, takes: [], giverSelf: {}, takerSelf: {},
    takeOutcome: () => ({ kind: "start", read: { result: "mine", good: true, seen: 0n, invalid: [], unsigned: [], conditions: {}, record: { sequence: (N + 1) * 2 ** 20 + 1 } } }) as unknown as TurnOutcome,
  } as unknown as World;
  w.makeGiver = (phase) => {
    const ports: GiverPorts = {
      ownKey: giverKey.publicKey, sign: async (bytes) => giverKey.sign(bytes), turnAddress, links: w.link.end(A, B), records: w.giverRecords,
      self: async () => self(w.giverSelf), source: w.profile,
      verifier: async () => (options.verifier === false || phase === "gated" ? null : verifier()),
      busy: async (taker) => { w.asked.push(taker); return w.busy.why; },
      staying: async () => w.stays,
      ...(phase === "active" ? { quiesce: async (patch: DevicePatch, taker?: HandoffTakerFacts) => { w.quiesced.push(patch); w.quiescedFor.push(taker); await w.giverRecords.move("releasing", { ...patch, ...w.quiesceExtra }); } } : {}),
      ...(phase === "gated" ? {
        backToActive: async () => { w.activeAgain += 1; if (w.giverRecords.record.state === "releasing") await w.giverRecords.move("active", { handoff: undefined }); },
        dropDatabases: async (names: string[]) => { w.droppedDatabases.push(names); },
      } : {}),
    };
    const giver = new HandoffGiver(ports);
    w.link.attach(A, giver);
    return giver;
  };
  w.makeTaker = () => {
    const ports: TakerPorts = {
      ownKey: takerKey.publicKey, sign: async (bytes) => takerKey.sign(bytes), turnAddress, links: w.link.end(B, A), records: w.takerRecords,
      self: async () => self(w.takerSelf), staging: w.storage,
      reload: () => { w.reloads += 1; },
      take: async (release, turn) => { w.takes.push({ release, turn }); return w.takeOutcome(); },
      install: async (staged, patch) => { await w.takerRecords.amend(patch); w.takerRecords.record = { ...w.takerRecords.record, profile: staged }; },
      standbyUnder: async () => {},
      forget: async () => {},
    };
    const taker = new HandoffTaker(ports);
    w.link.attach(B, taker);
    return taker;
  };
  w.giver = w.makeGiver("active");
  w.taker = w.makeTaker();
  worlds.push(w);
  return w;
}

const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!what()) { if (Date.now() - start > ms) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 2)); }
}

/** The giver froze and reloaded into the gate: a new giver from its record, and a new session on the link. */
async function reloadGiver(w: World): Promise<void> {
  w.giver.stop();
  w.link.drop();
  w.giver = w.makeGiver("gated");
  await w.giver.resume();
  w.link.reconnect();
}

/** The taker installed and reloaded under the staged name: a new taker from its record. */
async function reloadTaker(w: World): Promise<void> {
  w.taker.stop();
  w.taker = w.makeTaker();
  await w.taker.resume();
}

async function fullPull(w: World, later = 0): Promise<void> {
  await w.taker.pull(PASSWORD, later);
  await until(() => w.quiesced.length === 1);
  await reloadGiver(w);
  await until(() => w.reloads === 1);
  await reloadTaker(w);
  await until(() => w.reloads === 2);
}

describe("a pull with the right password", () => {
  it("moves every file and the rest, releases, installs and takes: A ends on standby, B active, H the same on both", async () => {
    const w = world();
    const small = w.profile.add("chat-in-small", bytesOf(1_000));
    const big = w.profile.add("chat-in-big", bytesOf(HANDOFF_PIECE_BYTES * 5 + 123));
    const empty = w.profile.add("chat-out-empty", new Uint8Array());
    // Two records of one file: its bytes go once.
    const twin = w.profile.add("chat-out-twin", w.profile.files_.get("chat-in-small")!);
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    // Pass 1 is done while A is live; A wrote `releasing` with the handoff's note and its first stream key.
    expect(w.giverRecords.record.state).toBe("releasing");
    expect(w.giverRecords.record.handoff).toMatchObject({ role: "releasing", step: "pass2", peer: B, from: N });
    expect(w.giverRecords.record.handoff!.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.takerRecords.record.handoff).toMatchObject({ role: "taking", step: "receiving", peer: A, from: N });
    const pass1 = w.link.sent.filter((s) => s.frame.t === "handoff-manifest").map((s) => readHandoffManifest(s.frame)!);
    expect(pass1.flatMap((m) => m.parts.map((p) => p[0])).sort()).toEqual([small, big, empty].map((f) => `file/${f.sha256}`).sort());

    await reloadGiver(w);
    await until(() => w.reloads === 1);
    // A wrote standby before it sent the release, and released turn N + 1 to B with H.
    expect(w.giverRecords.record).toMatchObject({ state: "standby", releasedTurn: N + 1 });
    const release = w.giverRecords.record.handoff!.release!;
    expect(release).toMatchObject({ turn: N + 1, to: B });
    const standbyWrite = w.giverRecords.writes.findIndex((write) => write.to === "standby");
    expect(standbyWrite).toBeGreaterThan(-1);
    expect(verify(fromBase64Url(release.s), turnReleaseMessage(turnAddress, N + 1, takerKey.publicKey, fromBase64Url(release.h)), giverKey.publicKey)).toBe(true);
    // B: `taking` with the release, installed (record under the staged name), the pointer moved.
    expect(w.takerRecords.record.state).toBe("taking");
    const staged = w.takerRecords.record.handoff!.staging!;
    expect(w.storage.pointer).toBe(staged);
    expect(w.takerRecords.record.profile).toBe(staged);
    const space = w.storage.spaces.get(staged)!;
    for (const file of [small, big, empty, twin]) expect(toBase64Url(sha256(space.files.get(file.id)!))).toBe(file.sha256);
    expect(space.restored!.bundle).toEqual(w.profile.rest);
    // H over every file part and the rest, the same on both sides.
    const parts: HandoffPart[] = [...new Map([small, big, empty].map((f) => [f.sha256, [`file/${f.sha256}`, f.size, f.sha256] as HandoffPart])).values(), ["db/peer", w.profile.rest.length, toBase64Url(sha256(w.profile.rest))]];
    expect(release.h).toBe(toBase64Url(handoffDigest(N + 1, giverKey.publicKey, takerKey.publicKey, parts)));

    await reloadTaker(w);
    await until(() => w.reloads === 2);
    expect(w.takes).toHaveLength(1);
    expect(w.takes[0].turn).toBe(N + 1);
    expect(w.takes[0].release).toMatchObject({ from: 0, to: 1 });
    expect(toBase64Url(w.takes[0].release.signature)).toBe(release.s);
    // The old namespace is dropped once the turn is this device's.
    expect(w.storage.dropped).toEqual(["ghostly"]);
    await until(() => w.link.count("handoff-done", B) === 1);
    await settle();
    expect(w.giverRecords.record.handoff).toBeUndefined();
  });

  it("the giver's count of wrong passwords goes with the release, so a device gets no fresh tries on the new active one", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(100));
    await w.giverRecords.amend({ handoffAttempts: { [C]: { recent: [], total: 9 } } });
    await fullPull(w);
    expect(w.takerRecords.record.handoffAttempts?.[C]?.total).toBe(9);
    // The giver keeps no stream key once it released.
    expect(w.giverRecords.record.handoff?.secret).toBeUndefined();
  });

  it("asks for the password once per handoff: the session after A's reload derives its key from the first one", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(5_000));
    await fullPull(w);
    expect(w.link.count("handoff-pake", B)).toBe(2);
    expect(w.link.count("handoff-pake", A)).toBe(1);
  });
});

describe("the password proof and its limits", () => {
  it("a wrong password: the taker says so, the giver counts it, nothing moves", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(5_000));
    await w.taker.pull("not the password");
    await until(() => w.taker.view()?.step === "failed");
    expect(w.taker.view()).toMatchObject({ step: "failed", failure: "password" });
    expect(w.giverRecords.record.handoffAttempts?.[B]?.total).toBe(1);
    expect(w.link.count("handoff-manifest")).toBe(0);
    expect(w.giverRecords.record.state).toBe("active");
    await until(() => w.giver.view()?.failure === "password");
  });

  it("five wrong in an hour lock the device out with a retry time; a right one after the hour starts the count again", { timeout: 30_000 }, async () => {
    const w = world();
    for (let i = 0; i < HANDOFF_ATTEMPTS.perHour; i++) {
      await w.taker.pull("wrong password !!");
      await until(() => w.taker.view()?.failure === "password");
    }
    expect(w.giverRecords.record.handoffAttempts?.[B]?.until).toBeGreaterThan(Date.now());
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.failure === "locked-out");
    expect(w.taker.view()!.retry).toBeGreaterThan(3_500);
    // An hour later (the count kept by the giver says when).
    await w.giverRecords.amend({ handoffAttempts: { [B]: { ...w.giverRecords.record.handoffAttempts![B], until: Date.now() - 1 } } });
    w.profile.add("f1", bytesOf(100));
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    expect(w.giverRecords.record.handoffAttempts?.[B]).toEqual({ recent: [], total: 0 });
  });

  it("fifteen with no success: refused until the person lets that device try again", { timeout: 30_000 }, async () => {
    const w = world();
    await w.giverRecords.amend({ handoffAttempts: { [B]: { recent: [], total: HANDOFF_ATTEMPTS.total } } });
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.failure === "refused");
    await w.giver.allowAgain(B);
    expect(w.giverRecords.record.handoffAttempts?.[B]).toBeUndefined();
    w.profile.add("f1", bytesOf(100));
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
  });

  it("an attempt is counted before the second message goes out: a taker that stops there has used a try", async () => {
    const w = world();
    w.link.meddle = (from, frame) => (from === B && frame.t === "handoff-pake" && frame.n === 3 ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => w.link.count("handoff-pake", A) === 1);
    await settle();
    expect(w.giverRecords.record.handoffAttempts?.[B]?.total).toBe(1);
  });

  it("a profile with no verifier refuses a pull; a push still works", { timeout: 30_000 }, async () => {
    const w = world({ verifier: false });
    w.profile.add("f1", bytesOf(100));
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.failure === "refused");
    await w.giver.push(B);
    await until(() => w.taker.view()?.step === "offer");
    await w.taker.accept();
    await until(() => w.quiesced.length === 1);
  });

  it("a third device's frames are not this handoff's: a request from it while one runs is told the giver is busy", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(HANDOFF_PIECE_BYTES * 3));
    const thirdLink = new Link();
    await w.taker.pull(PASSWORD);
    await until(() => w.link.count("handoff-manifest") > 0);
    // C asks over its own link: the giver has one handoff at a time.
    const sentToC: DeviceFrame[] = [];
    const giverPorts = (w.giver as unknown as { ports: GiverPorts }).ports;
    giverPorts.links = { ...giverPorts.links, live: (key) => key === C || w.link.live, send: (key, frame) => (key === C ? sentToC.push(frame) : w.link.end(A, B).send(key, frame)), transcript: (key) => (key === C ? thirdLink.transcript : w.link.transcript) };
    await w.giver.receive(C, { t: "handoff-hello", v: 1, e: toBase64Url(randomBytes(32)), app: "1.1.0", db: 12, pins: {}, kind: "web", room: -1, metered: false });
    await w.giver.receive(C, { t: "handoff-request", turn: N, id: "c".repeat(22) });
    expect(sentToC.find((frame) => frame.t === "handoff-busy")).toMatchObject({ why: "handoff" });
  });
});

describe("a device that asks and never proves", () => {
  it("each request is a try: five requests that send no first message lock that device out", async () => {
    const w = world();
    for (let i = 0; i < HANDOFF_ATTEMPTS.perHour; i++) {
      await w.giver.receive(B, { t: "handoff-hello", v: 1, e: toBase64Url(randomBytes(32)), app: "1.1.0", db: 12, pins: {}, kind: "web", room: -1, metered: false });
      await w.giver.receive(B, { t: "handoff-request", turn: N, id: `${"r".repeat(21)}${i}` });
      await w.giver.cancel();
    }
    expect(w.giverRecords.record.handoffAttempts?.[B]?.total).toBe(HANDOFF_ATTEMPTS.perHour);
    expect(w.giverRecords.record.handoffAttempts?.[B]?.until).toBeGreaterThan(Date.now());
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.failure === "locked-out");
  });

  it("the person's push on the active device takes over from a pull waiting for its proof", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(100));
    w.link.meddle = (from, frame) => (from === B && frame.t === "handoff-pake" ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => w.giver.view()?.step === "authorizing");
    w.link.meddle = undefined;
    await w.giver.push(B);
    await until(() => w.taker.view()?.step === "offer");
    await w.taker.accept();
    await until(() => w.quiesced.length === 1);
  });
});

describe("a giver that went back to active", () => {
  it("answers what a taker holds, for a handoff it no longer runs, with a cancel: the taker stops", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(100));
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    // The giver found money after its stop and starts again as active: a fresh giver, no handoff noted.
    await w.giverRecords.move("active", { handoff: undefined });
    w.giver.stop();
    w.link.drop();
    w.giver = w.makeGiver("active");
    w.link.reconnect();
    await until(() => w.taker.view()?.step === "failed");
    expect(w.taker.view()!.failure).toBe("cancelled");
    expect(w.takerRecords.record.state).toBe("standby");
  });
});

describe("storage that refuses a write", () => {
  it("a full disk on the taker ends the handoff at once on both devices as no room, and nothing changed", async () => {
    const w = world();
    w.profile.add("big", bytesOf(HANDOFF_PIECE_BYTES * 4));
    const open = w.storage.open.bind(w.storage);
    w.storage.open = async (database) => {
      const staging = await open(database);
      let writes = 0;
      return { ...staging, append: async (id, offset, bytes) => { if (++writes > 2) throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); await staging.append(id, offset, bytes); } };
    };
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.failure === "room");
    await until(() => w.giver.view()?.failure === "cancelled");
    expect(w.link.sent.find((s) => s.from === B && s.frame.t === "handoff-cancel")?.frame).toMatchObject({ why: "room" });
    expect(w.giverRecords.record.state).toBe("active");
    expect(w.quiesced).toHaveLength(0);
  });

  it("a copy that stopped (pieces lost, no confirmation) goes on: the taker says what it holds again, and the file arrives whole", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const w = world();
    const file = w.profile.add("big", bytesOf(HANDOFF_PIECE_BYTES * 30));
    let pieces = 0;
    // Pieces 4 to 30 are lost on the way, once: the giver waits for confirmations that never come.
    w.link.meddle = (from, frame) => (frame.t === "handoff-data" && ++pieces > 3 && pieces <= 30 ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => pieces > 30 || w.link.count("handoff-data") >= 18);
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.idleMs * 2);
    await until(() => w.quiesced.length === 1, 10_000);
    const staged = w.takerRecords.record.handoff!.staging!;
    expect(toBase64Url(sha256(w.storage.spaces.get(staged)!.files.get("big")!))).toBe(file.sha256);
    expect(w.link.count("handoff-have", B)).toBeGreaterThanOrEqual(2);
  });
});

describe("a push", () => {
  it("offers, and the taker's Use here moves the profile with no password", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(10_000));
    await w.giver.push(B);
    await until(() => w.taker.view()?.step === "offer");
    expect(w.taker.view()).toMatchObject({ step: "offer", offer: 10_000, device: "Desktop" });
    await w.taker.accept();
    await until(() => w.quiesced.length === 1);
    expect(w.link.count("handoff-pake")).toBe(0);
    await reloadGiver(w);
    await until(() => w.reloads === 1);
    expect(w.giverRecords.record.state).toBe("standby");
  });

  it("Not now: the offer goes, and nothing moved", async () => {
    const w = world();
    await w.giver.push(B);
    await until(() => w.taker.view()?.step === "offer");
    await w.taker.cancel();
    await until(() => w.giver.view()?.failure === "cancelled");
    expect(w.giverRecords.record.state).toBe("active");
  });

  it("a request with the offer's id from another device is no answer to the offer", async () => {
    const w = world();
    await w.giver.push(B);
    const offer = w.link.sent.find((s) => s.frame.t === "handoff-offer")!.frame;
    const sentToC: DeviceFrame[] = [];
    const giverPorts = (w.giver as unknown as { ports: GiverPorts }).ports;
    giverPorts.links = { ...giverPorts.links, live: () => true, send: (key, frame) => { if (key === C) sentToC.push(frame); }, transcript: () => w.link.transcript };
    await w.giver.receive(C, { t: "handoff-hello", v: 1, e: toBase64Url(randomBytes(32)), app: "1.1.0", db: 12, pins: {}, kind: "web", room: -1, metered: false });
    await w.giver.receive(C, { t: "handoff-request", turn: N, id: offer.id });
    expect(sentToC.find((frame) => frame.t === "handoff-busy")).toBeTruthy();
    expect(w.link.count("handoff-manifest")).toBe(0);
  });
});

describe("refusals before a byte is copied", () => {
  it.each(["wallet", "payment", "call", "loading"] as const)("the giver is busy (%s): the taker is told only that it is busy, and no try is used", async (why) => {
    const w = world();
    w.busy.why = why;
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.step === "failed");
    expect(w.taker.view()!.failure).toBe("busy");
    expect(w.link.sent.filter((s) => s.frame.t === "handoff-busy").map((s) => s.frame.why)).toEqual(["handoff"]);
    // The taker sends the first message with its request; the giver answers none.
    expect(w.link.count("handoff-pake", A)).toBe(0);
    expect(w.giverRecords.record.handoffAttempts).toBeUndefined();
  });

  it("a push from the active device that its wallets keep here is refused on the device itself, with the reason and the wallet", async () => {
    const w = world();
    w.busy.why = "wallet";
    await expect(w.giver.push(B)).rejects.toThrow(/^handoff-wallet:/);
    w.busy.why = "loading";
    await expect(w.giver.push(B)).rejects.toThrow(/^handoff-loading:/);
    w.busy.why = { why: "mainnet", wallet: "cashu" };
    await expect(w.giver.push(B)).rejects.toThrow(/^handoff-mainnet:cashu:/);
    w.busy.why = { why: "expiry", wallet: "bark", expiresAt: 1_800_000_000_000 };
    await expect(w.giver.push(B)).rejects.toThrow(/^handoff-expiry:bark:/);
    expect(w.link.count("handoff-offer")).toBe(0);
    // Each check named the device it would give the profile to.
    expect(w.asked.every((taker) => taker?.key === B)).toBe(true);
  });

  it("a pull its wallets keep here: the taker is told only that the giver is busy; the giver's own screen says why", async () => {
    const w = world();
    w.busy.why = { why: "expiry", wallet: "bark", expiresAt: 1_800_000_000_000 };
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.step === "failed");
    expect(w.taker.view()).toMatchObject({ failure: "busy" });
    expect(w.taker.view()!.wallet).toBeUndefined();
    expect(w.giver.view()).toMatchObject({ role: "giver", key: B, step: "failed", failure: "expiry", wallet: "bark", expiresAt: 1_800_000_000_000 });
    // The check knew the taker from its hello: its key, its kind and its wallet SDK pins.
    expect(w.asked.at(-1)).toEqual({ key: B, kind: "web", pins: { ark: "0.4.76" } });
  });

  it("a taker with an older database: Update Ghostly on this device first", async () => {
    const w = world();
    w.takerSelf = { db: 11 };
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.step === "failed");
    expect(w.taker.view()!.failure).toBe("older");
    expect(w.link.count("handoff-request")).toBe(0);
  });

  it("a newer taker moves, and the giver notes that it must update before it takes the profile back", async () => {
    const w = world();
    w.takerSelf = { db: 13 };
    w.profile.add("f1", bytesOf(100));
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    expect(w.quiesced[0].handoff).toMatchObject({ newer: true });
  });

  it("no room for what is to come: refused, and nothing is written past the check", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(50_000));
    w.storage.room = 10_000;
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.step === "failed");
    expect(w.taker.view()!.failure).toBe("room");
    // Pieces already on their way are not written.
    for (const space of w.storage.spaces.values()) expect([...space.files.values()].every((bytes) => bytes.length === 0)).toBe(true);
  });

  it("the giver does not answer within 30 seconds: Can't reach", async () => {
    vi.useFakeTimers();
    const w = world();
    w.link.live = false;
    await w.taker.pull(PASSWORD);
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.connectMs + 1);
    expect(w.taker.view()).toMatchObject({ step: "failed", failure: "unreachable" });
  });

  it("a giver whose link is down (a phone that suspended the app) is woken by a push, and waited for long enough to open Ghostly", async () => {
    vi.useFakeTimers();
    const w = world();
    w.link.live = false;
    const woken: string[] = [];
    const links = w.link.end(B, A);
    w.taker.stop();
    w.taker = new HandoffTaker({ ...(w.taker as unknown as { ports: TakerPorts }).ports, links: { ...links, wake: async (key) => { woken.push(key); return "sent"; } } });
    w.link.attach(B, w.taker);
    await w.taker.pull(PASSWORD);
    await vi.advanceTimersByTimeAsync(10);
    expect(woken).toEqual([A]);
    expect(w.taker.view()).toMatchObject({ step: "connecting", woken: true });
    // Past the usual 30 seconds it still waits: the person has to see the notice and open the app.
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.connectMs + 1);
    expect(w.taker.view()).toMatchObject({ step: "connecting", woken: true });
    await vi.advanceTimersByTimeAsync(WOKEN_CONNECT_MS);
    expect(w.taker.view()).toMatchObject({ step: "failed", failure: "unreachable", woken: true });
  });

  it("nothing to wake the giver with: the usual 30 seconds, and no word of a push", async () => {
    vi.useFakeTimers();
    const w = world();
    w.link.live = false;
    w.taker.stop();
    w.taker = new HandoffTaker({ ...(w.taker as unknown as { ports: TakerPorts }).ports, links: { ...w.link.end(B, A), wake: async () => "none" } });
    w.link.attach(B, w.taker);
    await w.taker.pull(PASSWORD);
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.connectMs + 1);
    expect(w.taker.view()).toMatchObject({ step: "failed", failure: "unreachable" });
    expect(w.taker.view()!.woken).toBeUndefined();
  });

  it("Move to a device whose link is down wakes it and says to open Ghostly there; with nothing to wake it with, Can't reach", async () => {
    const w = world();
    w.link.live = false;
    const woken: string[] = [];
    let answer: "sent" | "none" = "sent";
    w.giver.stop();
    w.giver = new HandoffGiver({ ...(w.giver as unknown as { ports: GiverPorts }).ports, links: { ...w.link.end(A, B), wake: async (key) => { woken.push(key); return answer; } } });
    await expect(w.giver.push(B)).rejects.toThrow(/^handoff-woken:/);
    expect(woken).toEqual([B]);
    answer = "none";
    await expect(w.giver.push(B)).rejects.toThrow(/^handoff-unreachable:/);
  });
});

describe("pass 1 and its resumption", () => {
  it("a link that drops mid-file resumes from the confirmed bytes, and the file arrives whole", async () => {
    const w = world();
    const file = w.profile.add("big", bytesOf(HANDOFF_PIECE_BYTES * 40 + 7));
    let dataFrames = 0;
    w.link.meddle = (from, frame) => {
      if (frame.t === "handoff-data" && ++dataFrames === 12) queueMicrotask(() => { w.link.drop(); queueMicrotask(() => w.link.reconnect()); });
      return frame;
    };
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1, 10_000);
    const staged = w.takerRecords.record.handoff!.staging!;
    expect(toBase64Url(sha256(w.storage.spaces.get(staged)!.files.get("big")!))).toBe(file.sha256);
    // It resumed rather than starting over: fewer reads than twice the file.
    expect(w.profile.reads).toBeLessThan(80);
    // The second session said what it held in part.
    const haves = w.link.sent.filter((s) => s.frame.t === "handoff-have" && s.from === B);
    expect(haves.some((s) => Object.keys((s.frame as { p?: object }).p ?? {}).length > 0)).toBe(true);
  });

  it("a piece that is not the part (it opens, its digest fails) is asked for again once, then the handoff fails as damaged", { timeout: 30_000 }, async () => {
    const w = world();
    w.profile.add("f1", bytesOf(HANDOFF_PIECE_BYTES + 10));
    // The giver's own bytes change under it: every copy fails its digest.
    const original = w.profile.read.bind(w.profile);
    w.profile.read = async (id, offset, length) => { const bytes = (await original(id, offset, length)).slice(); bytes[0] ^= 0xff; return bytes; };
    await w.taker.pull(PASSWORD);
    await until(() => w.taker.view()?.step === "failed", 10_000);
    expect(w.taker.view()!.failure).toBe("damaged");
    expect(w.link.count("handoff-have", B)).toBeGreaterThanOrEqual(2);
    expect(w.giverRecords.record.state).toBe("active");
  });

  it("files the frozen copy holds are copied here, not sent; their digest is what the taker says it has", async () => {
    const w = world();
    const kept = w.profile.add("old-file", bytesOf(20_000));
    const fresh = w.profile.add("new-file", bytesOf(2_000));
    w.storage.frozen.set("frozen-id", w.profile.files_.get("old-file")!);
    await w.takerRecords.amend({ heldFiles: [{ sha256: kept.sha256, size: kept.size, id: "frozen-id" }] });
    await fullPull(w);
    const parts = w.link.sent.filter((s) => s.frame.t === "handoff-manifest").flatMap((s) => readHandoffManifest(s.frame)!.parts.map((p) => p[0]));
    expect(parts).toContain(`file/${fresh.sha256}`);
    expect(parts).not.toContain(`file/${kept.sha256}`);
    const space = w.storage.spaces.get(w.takerRecords.record.handoff?.staging ?? w.storage.pointer)!;
    expect(toBase64Url(sha256(space.files.get("old-file")!))).toBe(kept.sha256);
  });

  it("on mobile data, files over the limit stay behind: not sent, not in H, noted by the giver for later", async () => {
    const w = world();
    const small = w.profile.add("small", bytesOf(1_000));
    const large = w.profile.add("large", bytesOf(70_000));
    await fullPull(w, 50_000);
    const parts = w.link.sent.filter((s) => s.frame.t === "handoff-manifest").flatMap((s) => readHandoffManifest(s.frame)!.parts.map((p) => p[0]));
    expect(parts).not.toContain(`file/${large.sha256}`);
    expect(w.giverRecords.record.leftFiles).toEqual([{ sha256: large.sha256, size: large.size, where: "large" }]);
    expect(w.giverRecords.record.heldFiles?.map((f) => f.id).sort()).toEqual(["large", "small"]);
    const release = w.giverRecords.record.handoff?.release ?? null;
    const h = release ? release.h : toBase64Url(handoffDigest(N + 1, giverKey.publicKey, takerKey.publicKey, [[`file/${small.sha256}`, small.size, small.sha256], ["db/peer", w.profile.rest.length, toBase64Url(sha256(w.profile.rest))]]));
    expect(h).toBe(toBase64Url(handoffDigest(N + 1, giverKey.publicKey, takerKey.publicKey, [[`file/${small.sha256}`, small.size, small.sha256], ["db/peer", w.profile.rest.length, toBase64Url(sha256(w.profile.rest))]])));
  });
});

describe("pass 2 and the release", () => {
  it("files that arrived during pass 1 go in pass 2", async () => {
    const w = world();
    w.profile.add("first", bytesOf(1_000));
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    const late = w.profile.add("arrived-later", bytesOf(3_000));
    await reloadGiver(w);
    await until(() => w.reloads === 1);
    const pass2 = w.link.sent.filter((s) => s.frame.t === "handoff-manifest" && s.frame.pass === 2).flatMap((s) => readHandoffManifest(s.frame)!.parts.map((p) => p[0]));
    expect(pass2.sort()).toEqual(["db/peer", `file/${late.sha256}`].sort());
  });

  it("a taker that heard no release asks again, and the giver on standby sends the same release", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(100));
    let held: DeviceFrame | null = null;
    w.link.meddle = (from, frame) => { if (frame.t === "handoff-release" && !held) { held = frame; return null; } return frame; };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    await reloadGiver(w);
    await until(() => w.giverRecords.record.state === "standby");
    expect(w.takerRecords.record.state).toBe("standby");
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.releaseMs + 10);
    await until(() => w.reloads === 1);
    const releases = w.link.sent.filter((s) => s.frame.t === "handoff-release").map((s) => JSON.stringify(s.frame));
    expect(releases).toHaveLength(2);
    expect(releases[0]).toBe(releases[1]);
  });

  it("the giver cancels before the release: the taker drops the rest of pass 2, keeps its staged files and stays on standby", async () => {
    const w = world();
    const file = w.profile.add("f1", bytesOf(5_000));
    w.link.meddle = (from, frame) => (frame.t === "handoff-verified" ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    await reloadGiver(w);
    await until(() => w.takerRecords.record.handoff?.step === "verified");
    await w.giver.cancel();
    await until(() => w.taker.view()?.step === "failed");
    expect(w.activeAgain).toBe(1);
    expect(w.giverRecords.record.state).toBe("active");
    const space = w.storage.spaces.get(w.takerRecords.record.handoff!.staging!)!;
    expect(space.restored).toBeNull();
    expect([...space.held.values()].map((f) => f.sha256)).toEqual([file.sha256]);
    expect(w.takerRecords.record.state).toBe("standby");
  });

  it("no verified within ten minutes of the last part: the giver is the active device again", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(100));
    w.link.meddle = (from, frame) => (frame.t === "handoff-verified" ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await reloadGiver(w);
    await until(() => w.takerRecords.record.handoff?.step === "verified");
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.verifiedMs + 10);
    await until(() => w.activeAgain === 1);
    expect(w.giverRecords.record.state).toBe("active");
  });

  it("a verified frame whose H is not the giver's: no release, and the giver is active again", { timeout: 30_000 }, async () => {
    const w = world();
    const file = w.profile.add("f1", bytesOf(100));
    // Pass 2's manifest reaches the taker without one file's ids: the taker leaves that file out of its H.
    w.link.meddle = (from, frame) => {
      if (frame.t === "handoff-manifest" && frame.pass === 2) { const { [file.sha256]: _, ...ids } = frame.ids as Record<string, string[]>; return { ...frame, ids }; }
      return frame;
    };
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    await reloadGiver(w);
    await until(() => w.activeAgain === 1);
    expect(w.link.count("handoff-release")).toBe(0);
    expect(w.giverRecords.record.state).toBe("active");
    expect(w.link.sent.find((s) => s.frame.t === "handoff-cancel" && s.from === A)?.frame).toMatchObject({ why: "damaged" });
  });
});

describe("crash recovery (WISP 06 § Installing the staged state)", () => {
  it("A finds `releasing` with a handoff note too old to go on: it writes `active`", async () => {
    const w = world();
    await w.giverRecords.move("releasing", { handoff: { role: "releasing", step: "pass2", id: "x".repeat(22), peer: B, from: N, secret: toBase64Url(randomBytes(32)), at: Date.now() - HANDOFF_TIMINGS.verifiedMs - 1 } });
    w.giver = w.makeGiver("gated");
    await w.giver.resume();
    expect(w.activeAgain).toBe(1);
    expect(w.giverRecords.record.state).toBe("active");
  });

  it("A finds `releasing` and the taker never comes back: active again after the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const w = world();
    w.link.live = false;
    await w.giverRecords.move("releasing", { handoff: { role: "releasing", step: "pass2", id: "x".repeat(22), peer: B, from: N, secret: toBase64Url(randomBytes(32)), at: Date.now() } });
    w.giver = w.makeGiver("gated");
    await w.giver.resume();
    expect(w.giverRecords.record.state).toBe("releasing");
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMINGS.idleMs * 2 + 10);
    await until(() => w.activeAgain === 1);
  });

  it("B, `standby` with a staging namespace, after its own reload: keeps the files, drops pass 2, goes on when A is back", async () => {
    const w = world();
    const a = w.profile.add("a", bytesOf(HANDOFF_PIECE_BYTES * 2));
    const b = w.profile.add("b", bytesOf(HANDOFF_PIECE_BYTES * 2));
    let pieces = 0;
    // B stops after the first file: no more frames reach it, and it reloads.
    w.link.meddle = (from, frame) => (frame.t === "handoff-data" && ++pieces > 2 ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => [...(w.storage.spaces.values())].some((s) => s.held.size === 1));
    w.link.meddle = undefined;
    w.link.drop();
    w.taker.stop();
    w.taker = w.makeTaker();
    await w.taker.resume();
    w.link.reconnect();
    await until(() => w.quiesced.length === 1);
    const staged = w.storage.spaces.get(w.takerRecords.record.handoff!.staging!)!;
    expect([...staged.held.values()].map((f) => f.sha256).sort()).toEqual([a.sha256, b.sha256].sort());
    // The file staged before the reload was not sent again.
    const sentParts = w.link.sent.filter((s) => s.frame.t === "handoff-manifest").map((s) => readHandoffManifest(s.frame)!.parts.map((p) => p[0]));
    expect(sentParts.at(-1)).toHaveLength(1);
  });

  it("B, `taking` with the pointer not moved yet (a crash between the two writes): the install again, then the reload", async () => {
    const w = world();
    const release = { turn: N + 1, to: B, h: toBase64Url(randomBytes(32)), s: toBase64Url(randomBytes(64)) };
    await w.takerRecords.move("taking", { handoff: { role: "taking", step: "install", id: "x".repeat(22), peer: A, from: N, staging: "ghostly_stage9", old: "ghostly", release, at: Date.now() } });
    await w.storage.open("ghostly_stage9");
    await reloadTaker(w);
    await until(() => w.reloads === 1);
    expect(w.storage.pointer).toBe("ghostly_stage9");
    expect(w.takes).toHaveLength(0);
  });

  it("B, `taking` under the staged name, settling when it stopped: the take again; when it loses, the staged namespace goes", async () => {
    const w = world();
    const release = { turn: N + 1, to: B, h: toBase64Url(randomBytes(32)), s: toBase64Url(randomBytes(64)) };
    w.storage.pointer = "ghostly_stage9";
    w.takerRecords.record = { ...w.takerRecords.record, profile: "ghostly_stage9" };
    await w.takerRecords.move("taking", { handoff: { role: "taking", step: "installed", id: "x".repeat(22), peer: A, from: N, staging: "ghostly_stage9", old: "ghostly", release, at: Date.now() } });
    await w.storage.open("ghostly_stage9");
    w.takeOutcome = () => ({ kind: "gated", state: "standby", reload: false, read: {} }) as unknown as TurnOutcome;
    await reloadTaker(w);
    await until(() => w.reloads === 1);
    expect(w.takes).toHaveLength(1);
    expect(w.storage.dropped).toEqual(["ghostly_stage9"]);
    expect(w.taker.view()).toMatchObject({ step: "failed", failure: "turn" });
  });

  it("B, `taking` while no source answers: it waits and takes again; it never starts without a `mine`", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const w = world();
    const release = { turn: N + 1, to: B, h: toBase64Url(randomBytes(32)), s: toBase64Url(randomBytes(64)) };
    w.storage.pointer = "ghostly_stage9";
    w.takerRecords.record = { ...w.takerRecords.record, profile: "ghostly_stage9" };
    await w.takerRecords.move("taking", { handoff: { role: "taking", step: "installed", id: "x".repeat(22), peer: A, from: N, staging: "ghostly_stage9", old: "ghostly", release, at: Date.now() } });
    let n = 0;
    const start = w.takeOutcome;
    w.takeOutcome = () => (++n < 3 ? ({ kind: "wait", read: {} } as unknown as TurnOutcome) : start());
    void reloadTaker(w);
    await vi.advanceTimersByTimeAsync(11_000);
    await until(() => w.reloads === 1);
    expect(w.takes).toHaveLength(3);
    expect(w.storage.dropped).toEqual(["ghostly"]);
  });

  it("B verified and reloaded before any release reached it: the staged state is kept, it asks again, A sends the same release, B installs", async () => {
    const w = world();
    const file = w.profile.add("f1", bytesOf(5_000));
    w.link.meddle = (from, frame) => (frame.t === "handoff-release" ? null : frame);
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    await reloadGiver(w);
    await until(() => w.giverRecords.record.state === "standby");
    expect(w.takerRecords.record.handoff).toMatchObject({ step: "verified" });
    expect(w.takerRecords.record.handoff!.h).toBe(w.giverRecords.record.handoff!.release!.h);
    // B reloads; the release gets through from now on.
    w.link.meddle = undefined;
    w.link.drop();
    await reloadTaker(w);
    w.link.reconnect();
    await until(() => w.reloads === 1);
    const staged = w.takerRecords.record.handoff!.staging!;
    expect(w.storage.pointer).toBe(staged);
    expect(w.storage.spaces.get(staged)!.restored).not.toBeNull();
    expect(toBase64Url(sha256(w.storage.spaces.get(staged)!.files.get("f1")!))).toBe(file.sha256);
  });

  it("a standby whose last pull stopped: a reload shows nothing more about it", async () => {
    const w = world();
    await w.taker.pull("not the password");
    await until(() => w.taker.view()?.failure === "password");
    expect(w.takerRecords.record.handoff?.step).toBe("stopped");
    await reloadTaker(w);
    expect(w.taker.view()).toBeNull();
  });

  it("A, `standby` after its release: a taker that asks again with the same handoff gets the same release, another device nothing", async () => {
    const w = world();
    const release = { turn: N + 1, to: B, h: toBase64Url(randomBytes(32)), s: toBase64Url(randomBytes(64)) };
    await w.giverRecords.move("releasing", { handoff: { role: "releasing", step: "pass2", id: "y".repeat(22), peer: B, from: N, secret: toBase64Url(randomBytes(32)), at: Date.now() } });
    await w.giverRecords.move("standby", { releasedTurn: N + 1, handoff: { ...w.giverRecords.record.handoff!, step: "released", release } });
    w.giver = w.makeGiver("gated");
    await w.giver.resume();
    await w.giver.receive(B, { t: "handoff-request", turn: N, id: "y".repeat(22) });
    await settle();
    expect(w.link.sent.filter((s) => s.frame.t === "handoff-release").map((s) => s.frame)).toEqual([{ t: "handoff-release", ...release }]);
    await w.giver.receive(B, { t: "handoff-request", turn: N, id: "z".repeat(22) });
    await settle();
    expect(w.link.count("handoff-release")).toBe(1);
  });

  it("a release that does not verify, or names another device or turn, is not taken", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(100));
    w.link.meddle = (from, frame) => (frame.t === "handoff-release" ? { ...frame, s: toBase64Url(randomBytes(64)) } : frame);
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    await reloadGiver(w);
    await until(() => w.giverRecords.record.state === "standby");
    await settle();
    expect(w.takerRecords.record.state).toBe("standby");
    expect(w.storage.pointer).toBe("ghostly");
  });
});

describe("views", () => {
  it("the taker's view goes through the WISP's steps, and never shows a secret", async () => {
    const w = world();
    w.profile.add("f1", bytesOf(HANDOFF_PIECE_BYTES * 3));
    const steps = new Set<HandoffView["step"]>();
    const timer = setInterval(() => { const v = w.taker.view(); if (v) steps.add(v.step); }, 1);
    await fullPull(w);
    clearInterval(timer);
    expect(steps.has("connecting") || steps.has("authorizing") || steps.has("copying")).toBe(true);
    expect(JSON.stringify(w.taker.view())).not.toMatch(/secret|password/i);
    expect(readTurnPacket).toBeDefined();
  });
});

describe("wallets in a handoff (WISP 06 § Wallets)", () => {
  it("the plan is made for the taker that said hello: at the pull, and again at quiesce", async () => {
    const w = world();
    w.takerSelf = { kind: "desktop", pins: { ark: "0.4.75" } };
    await fullPull(w);
    expect(w.quiescedFor).toEqual([{ key: B, kind: "desktop", pins: { ark: "0.4.75" } }]);
    expect(w.asked.filter((taker) => taker?.kind === "desktop").length).toBeGreaterThanOrEqual(2);
  });

  it("the wallets that stay on the giver show on its screen while the profile moves", async () => {
    const w = world();
    w.stays = [{ type: "bark", network: "testnet", expiresAt: 1_800_000_000_000 }];
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    expect(w.giver.view()?.stays).toEqual(w.stays);
  });

  it("the Breez databases of the wallets that moved are deleted once the giver is on standby, and the note goes", async () => {
    const w = world();
    const names = ["ghostly-breez-regtest-0123456789abcdef", "ghostly-breez-mainnet-fedcba9876543210"];
    w.quiesceExtra = { breezDatabases: names };
    await fullPull(w);
    expect(w.giverRecords.record.state).toBe("standby");
    expect(w.droppedDatabases).toEqual([names]);
    expect(w.giverRecords.record.breezDatabases).toBeUndefined();
  });

  it("a giver that went back to active deletes nothing: its wallets are its own again", async () => {
    const w = world();
    w.quiesceExtra = { breezDatabases: ["ghostly-breez-regtest-0123456789abcdef"] };
    await w.taker.pull(PASSWORD);
    await until(() => w.quiesced.length === 1);
    await reloadGiver(w);
    await w.giver.cancel();
    await until(() => w.activeAgain === 1);
    expect(w.droppedDatabases).toEqual([]);
  });

  it("a released standby that could not delete them tries again when it starts", async () => {
    const w = world();
    const names = ["ghostly-breez-regtest-0123456789abcdef"];
    w.quiesceExtra = { breezDatabases: names };
    await fullPull(w);
    // As if the delete had failed: the note is still there at the next start.
    await w.giverRecords.amend({ breezDatabases: names });
    w.droppedDatabases.length = 0;
    w.giver.stop();
    w.giver = w.makeGiver("gated");
    await w.giver.resume();
    expect(w.droppedDatabases).toEqual([names]);
    expect(w.giverRecords.record.breezDatabases).toBeUndefined();
  });
});
