import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  enrollCancelFrame, fromBase64Url, randomBytes, readTurnPacket, signTurnPacket, toBase64Url, turnKeys,
  type DeviceFrame, type LinkParams, type Signer, type TurnRecord,
} from "@ghostly/core";
import {
  EnrollCodeError, EnrollCrash, EnrollInviter, EnrollJoiner, EnrollRefusal, enrollmentUnfinished, finishEnrollment,
  type EnrollChannel, type EnrollChannelEvents, type EnrollCrashPoint, type OpenEnrollChannel,
} from "../src/devices/enroll";
import { viewOf } from "../src/devices/gate";
import { deviceSetView } from "../src/devices/links";
import { openTurnKeeper } from "../src/devices/setup";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, loadDeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord } from "../src/devices/state";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase } from "./helpers/deviceRecord";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.enroll, devices.enroll.session

/*
 * Adding a device (WISP 06 § Adding a device), as the two state machines run it over a one-time session: here a pair
 * of pipes that authenticates as a paired session does (the inviter takes the first joiner's key and refuses any
 * other; the joiner reaches only the key its code names), on the real device state store and a fake turn network.
 * Each "device" is a profile name of its own in this one process. Every key and secret is made in the test.
 *
 * The crash matrix stops either side at each step, as a crash would, starts it again (what the next start of the
 * app does: the active device reads its turn and puts what it stored; a standby finishes its enrollment), and checks
 * that the result is no enrollment or a complete one, never a half device in the set.
 */

const A = "ghostly_a", B = "ghostly_b", C = "ghostly_c";
const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
const quick = { doneMs: 300, proofMs: 300, finishRounds: 100, finishEveryMs: 5 };
const shortSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));
const noSleep = async () => {};

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface End { setup: { params: LinkParams; signer: Signer; peerKey: Uint8Array | null }; events: EnrollChannelEvents; peer: End | null; stopped: boolean }

/**
 * A one-time session between the inviter and whoever opens the joiner's end with the code's key. The inviter takes
 * the first joiner that authenticates and refuses every other one, as the paired session's trust on first use does.
 */
class Pipe {
  inviter: End | null = null;
  readonly joiners: End[] = [];
  taken: string | null = null;
  /** Frames as they cross, for tests that look. */
  readonly frames: { from: "inviter" | "joiner"; frame: DeviceFrame }[] = [];
  /** A frame the joiner sends is changed before the inviter reads it (an impostor's), or dropped (null). */
  tamper?: (frame: DeviceFrame, from: "inviter" | "joiner") => DeviceFrame | null;

  readonly openInviter: OpenEnrollChannel = (setup, events) => {
    const end: End = { setup, events, peer: null, stopped: false };
    this.inviter = end;
    this.connect();
    return this.channel(end, "inviter");
  };

  readonly openJoiner: OpenEnrollChannel = (setup, events) => {
    const end: End = { setup, events, peer: null, stopped: false };
    this.joiners.push(end);
    this.connect();
    return this.channel(end, "joiner");
  };

  private channel(end: End, side: "inviter" | "joiner"): EnrollChannel {
    return {
      send: (frame) => {
        const peer = end.peer;
        if (!peer || peer.stopped || end.stopped) throw new Error("not connected");
        const sent = this.tamper ? this.tamper(frame, side) : frame;
        if (!sent) return;
        this.frames.push({ from: side, frame: sent });
        setTimeout(() => { if (!peer.stopped) peer.events.onFrame(sent); }, 0);
      },
      stop: async () => { end.stopped = true; },
    };
  }

  private connect(): void {
    const inviter = this.inviter;
    if (!inviter) return;
    for (const joiner of this.joiners) {
      if (joiner.peer || joiner.stopped) continue;
      // The joiner reaches only the inviter whose key its code names.
      if (!joiner.setup.peerKey || toBase64Url(joiner.setup.peerKey) !== toBase64Url(inviter.setup.signer.publicKey)) continue;
      const key = toBase64Url(joiner.setup.signer.publicKey);
      if (this.taken && this.taken !== key) { setTimeout(() => inviter.events.onPeerRefused(), 0); continue; }
      this.taken = key;
      joiner.peer = inviter; inviter.peer = joiner;
      const hash = bytesToHex(randomBytes(32));
      setTimeout(() => {
        inviter.events.onOpen(joiner.setup.signer.publicKey, hash);
        joiner.events.onOpen(inviter.setup.signer.publicKey, hash);
      }, 0);
    }
  }

  /** The connection drops. */
  drop(): void {
    const inviter = this.inviter, joiner = inviter?.peer;
    if (inviter) inviter.peer = null;
    if (joiner) joiner.peer = null;
    inviter?.events.onClose(); joiner?.events.onClose();
  }
}

let network: FakeTurnNetwork;
let pipe: Pipe;
const didSeed = randomBytes(32);

function inviter(options: { crash?: EnrollCrashPoint; name?: string; profile?: string } = {}): EnrollInviter {
  return new EnrollInviter({
    profile: options.profile ?? A, network, open: pipe.openInviter, didSeed: async () => didSeed, name: options.name ?? "MacBook", sleep: noSleep, timing: quick, forceSeed: true,
    ...(options.crash ? { crash: (at) => { if (at === options.crash) throw new EnrollCrash(at); } } : {}),
  });
}
function joiner(options: { crash?: EnrollCrashPoint; name?: string; profile?: string; userAgent?: string } = {}): EnrollJoiner {
  return new EnrollJoiner({
    profile: options.profile ?? B, network, open: pipe.openJoiner, about: { name: options.name ?? "Phone", kind: "web", app: "1.1.0" }, sleep: shortSleep, timing: quick, forceSeed: true,
    install: options.userAgent ? { userAgent: options.userAgent } : { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    ...(options.crash ? { crash: (at) => { if (at === options.crash) throw new EnrollCrash(at); } } : {}),
  });
}

/** Both sides to the digits: the code goes from the inviter's screen to the joiner. */
async function toDigits(a: EnrollInviter, b: EnrollJoiner): Promise<{ inviterDigits: string; joinerDigits: string }> {
  const waiting = await a.start();
  if (waiting.step !== "waiting") throw new Error("no code");
  await b.start(waiting.code);
  await until(() => a.current().step === "confirm" && b.current().step === "confirm");
  const av = a.current(), bv = b.current();
  return { inviterDigits: av.step === "confirm" ? av.digits : "", joinerDigits: bv.step === "confirm" ? bv.digits : "" };
}

/** The record on the network, opened under `D`. */
function published(d: string): TurnRecord | null {
  const held = network.sources[0].held;
  if (!held) return null;
  const read = readTurnPacket(turnKeys(fromBase64Url(d)), held);
  return read.kind === "valid" ? read.record : null;
}
const lists = (record: TurnRecord | null, key: string) => !!record?.slots.some((slot) => slot && toBase64Url(slot.key) === key);
const keyOf = async (profile: string) => toBase64Url((await loadDeviceSigningKey(profile))!.publicKey);

/** What the app does at its next start, after a crash: connections to the databases are new. */
async function restart(): Promise<void> {
  await closeDevicesDb(); await closeDeviceKeysDb();
}
/** The active device's start: it reads its turn and puts the record it stored (what `GhostlyNode` does at start). */
async function activeStarts(profile: string): Promise<void> {
  const record = await readDeviceRecord(profile);
  if (record?.state !== "active") return;
  await (await openTurnKeeper(profile, network))!.check(false);
}

beforeEach(async () => {
  setDeviceMirror(null);
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
  network = new FakeTurnNetwork();
  pipe = new Pipe();
});
afterEach(async () => { await closeDevicesDb(); await closeDeviceKeysDb(); });

describe("adding a device", () => {
  it("a single profile and a new device: the same digits, a standby that finished, and a turn record that lists both", async () => {
    const a = inviter(), b = joiner();
    const { inviterDigits, joinerDigits } = await toDigits(a, b);
    expect(inviterDigits).toMatch(/^\d{6}$/);
    expect(joinerDigits).toBe(inviterDigits);
    expect(a.current()).toMatchObject({ step: "confirm", device: "Phone", kind: "web" });
    // Nothing is written before the person confirms.
    expect(await readDeviceRecord(A)).toBeNull();
    expect(await readDeviceRecord(B)).toBeNull();
    await a.confirm(true);
    await until(() => a.ended && b.ended);
    expect(a.current()).toEqual({ role: "inviter", step: "done", device: "Phone", published: true });
    expect(b.current()).toEqual({ role: "joiner", step: "done", device: "MacBook" });

    const ra = (await readDeviceRecord(A))!, rb = (await readDeviceRecord(B))!;
    expect(ra).toMatchObject({ state: "active", ownSlot: 0, activeSlot: 0, rev: 0, signingKey: "seed" });
    expect(rb).toMatchObject({ state: "standby", ownSlot: 1, activeSlot: 0, signingKey: "seed" });
    expect(rb.d).toBe(ra.d);
    expect(ra.deviceSet).toEqual([{ key: await keyOf(A), name: "MacBook" }, { key: await keyOf(B), name: "Phone" }, null, null]);
    expect(rb.deviceSet).toEqual(ra.deviceSet);
    // The joiner keeps the record it accepted: the one the inviter stored and put, byte for byte.
    expect(rb.turnPacket).toBe(ra.turnPacket);
    expect(toBase64Url(network.sources[0].held!)).toBe(ra.turnPacket);
    const record = published(ra.d!)!;
    expect(record).toMatchObject({ turn: ra.turn, rev: 0, author: 0, active: 0 });
    expect(record.turn).toBeLessThan(2 ** 29);
    expect(viewOf(rb)).toEqual({ state: "standby", activeDevice: "MacBook" });
    expect(deviceSetView(ra, [])).toMatchObject({ state: "active", devices: [{ name: "MacBook", self: true, active: true }, { name: "Phone", self: false, active: false }] });
  });

  it("an active device adds a third: the next free slot, in its own turn at the next rev", async () => {
    await (async () => { const a = inviter(), b = joiner(); await toDigits(a, b); await a.confirm(true); await until(() => a.ended && b.ended); })();
    const before = (await readDeviceRecord(A))!;
    pipe = new Pipe();
    const a = inviter(), c = joiner({ profile: C, name: "Firefox" });
    await toDigits(a, c);
    await a.confirm(true);
    await until(() => a.ended && c.ended);
    expect(a.current()).toMatchObject({ step: "done", device: "Firefox", published: true });
    expect(c.current()).toMatchObject({ step: "done", device: "MacBook" });
    const ra = (await readDeviceRecord(A))!, rc = (await readDeviceRecord(C))!;
    expect(ra.turn).toBe(before.turn);
    expect(ra.rev).toBe(1);
    expect(ra.deviceSet.map((slot) => slot?.name ?? null)).toEqual(["MacBook", "Phone", "Firefox", null]);
    expect(rc).toMatchObject({ state: "standby", ownSlot: 2, activeSlot: 0, d: ra.d, turnPacket: ra.turnPacket });
    expect(published(ra.d!)?.rev).toBe(1);
    // The phone's record is the older one it accepted; it reads the new one at its next look.
    expect((await readDeviceRecord(B))!.turnPacket).toBe(before.turnPacket);
  });

  it("the joiner calls itself as the person named it, cut to 16 bytes at a whole character", async () => {
    const a = inviter(), b = joiner({ name: "Miguel's phone 📱📱" });
    await toDigits(a, b);
    expect(a.current()).toMatchObject({ device: "Miguel's phone " });
  });
});

describe("refusals", () => {
  it("a second joiner with the same code gets nothing, and the inviter says so", async () => {
    const a = inviter(), b = joiner();
    const waiting = await a.start();
    if (waiting.step !== "waiting") throw new Error("no code");
    await b.start(waiting.code);
    await until(() => a.current().step === "confirm" && b.current().step === "confirm");
    // An onlooker photographed the code and tries it now.
    const intruder = joiner({ profile: C, name: "Intruder" });
    await intruder.start(waiting.code);
    await until(() => (a.current() as { refused?: number }).refused === 1 && intruder.ended);
    expect(intruder.current()).toEqual({ role: "joiner", step: "failed", reason: "unanswered" });
    // The person's own device still confirms, and the intruder is listed nowhere.
    await a.confirm(true);
    await until(() => a.ended && b.ended);
    expect(a.current()).toMatchObject({ step: "done", device: "Phone" });
    expect((await readDeviceRecord(A))!.deviceSet.filter(Boolean)).toHaveLength(2);
    expect(await readDeviceRecord(C)).toBeNull();
  });

  it("an intruder that joined first holds the only session: the person's device gets no digits, and nothing is written", async () => {
    const a = inviter();
    const waiting = await a.start();
    if (waiting.step !== "waiting") throw new Error("no code");
    const intruder = joiner({ profile: C, name: "Intruder" });
    await intruder.start(waiting.code);
    await until(() => a.current().step === "confirm");
    const b = joiner();
    await b.start(waiting.code);
    await until(() => b.ended);
    expect(b.current()).toEqual({ role: "joiner", step: "failed", reason: "unanswered" });
    expect((a.current() as { refused?: number }).refused).toBe(1);
    // The digits on the active device are the intruder's: the person sees no match on the phone, and says so.
    await a.confirm(false);
    await until(() => intruder.ended);
    expect(intruder.current()).toMatchObject({ step: "failed", reason: "digits" });
    for (const profile of [A, B, C]) expect(await readDeviceRecord(profile)).toBeNull();
    expect(network.puts()).toHaveLength(0);
  });

  it("digits that do not match: both stop, nothing is written", async () => {
    const a = inviter(), b = joiner();
    await toDigits(a, b);
    await a.confirm(false);
    await until(() => b.ended);
    expect(a.current()).toMatchObject({ step: "failed", reason: "digits" });
    expect(b.current()).toMatchObject({ step: "failed", reason: "digits" });
    expect(await readDeviceRecord(A)).toBeNull();
    expect(await readDeviceRecord(B)).toBeNull();
  });

  it("the joiner shows no digits when the proof is not the key's in the code", async () => {
    const a = inviter(), b = joiner();
    pipe.tamper = (frame, from) => (from === "inviter" && frame.t === "enroll-proof" ? { ...frame, s: toBase64Url(randomBytes(64)) } : frame);
    const waiting = await a.start();
    if (waiting.step !== "waiting") throw new Error("no code");
    await b.start(waiting.code);
    await until(() => b.ended);
    expect(b.current()).toMatchObject({ step: "failed", reason: "proof" });
    expect(pipe.frames.some((f) => f.from === "joiner" && f.frame.t === "enroll-cancel")).toBe(true);
  });

  it("the inviter refuses a hello that is not signed by the key the session authenticated", async () => {
    const a = inviter(), b = joiner();
    pipe.tamper = (frame, from) => (from === "joiner" && frame.t === "enroll-hello" ? { ...frame, s: toBase64Url(randomBytes(64)) } : frame);
    const waiting = await a.start();
    if (waiting.step !== "waiting") throw new Error("no code");
    await b.start(waiting.code);
    await until(() => a.ended);
    expect(a.current()).toMatchObject({ step: "failed", reason: "proof" });
  });

  it("a code past its ten minutes, a chat invite, and a device that already has a set are refused before anything is made", async () => {
    let now = Date.now();
    const a = new EnrollInviter({ profile: A, network, open: pipe.openInviter, didSeed: async () => didSeed, name: "MacBook", now: () => now, sleep: noSleep, forceSeed: true });
    const waiting = await a.start();
    if (waiting.step !== "waiting") throw new Error("no code");
    now += 601_000;
    const late = new EnrollJoiner({ profile: B, network, open: pipe.openJoiner, about: { name: "Phone", kind: "web", app: "1" }, now: () => now, forceSeed: true, install: null });
    await expect(late.start(waiting.code)).rejects.toMatchObject({ reason: "expired" });
    const chat = (await import("@ghostly/core")).createChatInvite().inviteCode;
    await expect(joiner().start(chat)).rejects.toMatchObject({ reason: "chat" });
    await a.cancel();
  });

  it("a tab of a browser on iPhone or iPad is told to add Ghostly to the Home Screen first; the app there may join", async () => {
    const a = inviter();
    const waiting = await a.start();
    if (waiting.step !== "waiting") throw new Error("no code");
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const tab = joiner({ userAgent: iphone });
    await expect(tab.start(waiting.code)).rejects.toBeInstanceOf(EnrollCodeError);
    await expect(tab.start(waiting.code)).rejects.toMatchObject({ reason: "home-screen" });
    // An iPad that asks for desktop pages, in a tab: the same.
    const ipad = new EnrollJoiner({ profile: B, network, open: pipe.openJoiner, about: { name: "iPad", kind: "web", app: "1" }, forceSeed: true, install: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 } });
    await expect(ipad.start(waiting.code)).rejects.toMatchObject({ reason: "home-screen" });
    expect(await readDeviceRecord(B)).toBeNull();
    const installed = new EnrollJoiner({ profile: B, network, open: pipe.openJoiner, about: { name: "iPhone", kind: "web", app: "1" }, forceSeed: true, sleep: noSleep, timing: quick, install: { userAgent: iphone, standalone: true } });
    await installed.start(waiting.code);
    await until(() => a.current().step === "confirm");
    await a.cancel();
  });

  it("a profile whose turn address already holds a record (another copy has devices) adds none; with no source answering, none either", async () => {
    // Another copy of this profile made a device set first, under the same first `D`.
    const other = inviter();
    const b = joiner();
    await toDigits(other, b); await other.confirm(true); await until(() => other.ended && b.ended);
    const kept = network.sources.map((source) => source.held);
    await restart(); await dropDevicesDatabase(); await dropKeys();
    network.sources.forEach((source, i) => { source.held = kept[i]; });
    await expect(inviter().start()).rejects.toMatchObject({ reason: "elsewhere" });
    for (const source of network.sources) source.down = true;
    await expect(inviter().start()).rejects.toBeInstanceOf(EnrollRefusal);
    expect(await readDeviceRecord(A)).toBeNull();
  });

  it("a cancel from the other side ends this one with its reason", async () => {
    const a = inviter(), b = joiner();
    await toDigits(a, b);
    pipe.inviter!.peer!.events.onFrame(enrollCancelFrame("cancelled"));
    await until(() => b.ended);
    expect(b.current()).toMatchObject({ step: "failed", reason: "cancelled" });
    await a.cancel();
  });
});

describe("crash matrix", () => {
  type Outcome = "none" | "complete";
  /**
   * Runs one enrollment with a crash at `at`, starts the crashed side again, lets both do what their next start
   * does, and returns what holds then. The rule: the inviter's record lists the joiner only if the joiner stored the
   * grant, and the network lists it only if the inviter's record does.
   */
  async function crashAt(at: EnrollCrashPoint): Promise<{ outcome: Outcome; a: DeviceRecord | null; b: DeviceRecord | null }> {
    const crashInviter = at.startsWith("inviter:"), crashJoiner = at.startsWith("joiner:");
    const a = inviter(crashInviter ? { crash: at } : {}), b = joiner(crashJoiner ? { crash: at } : {});
    await toDigits(a, b);
    await a.confirm(true).catch((error: unknown) => { if (!(error instanceof EnrollCrash)) throw error; });
    // Each side ends, by finishing, failing, timing out, or by its crash.
    await until(() => a.ended && b.ended, 5_000);
    // The next start of both apps.
    await restart();
    await activeStarts(A);
    if (enrollmentUnfinished(await readDeviceRecord(B))) await finishEnrollment(B, network, { sleep: noSleep, rounds: 2 });

    const ra = await readDeviceRecord(A), rb = await readDeviceRecord(B);
    const bKey = await keyOf(B).catch(() => "");
    const aLists = !!ra?.deviceSet.some((slot) => slot?.key === bKey);
    const netLists = ra?.d ? lists(published(ra.d), bKey) : false;
    // Never a half device: listed by the inviter, or on the network, only with the grant stored on the joiner.
    if (aLists || netLists) expect(rb).toMatchObject({ state: "standby", d: ra!.d });
    if (netLists) expect(aLists).toBe(true);
    const complete = aLists && netLists && !!rb?.turnPacket;
    if (!complete) {
      // No enrollment: the inviter lists nobody new and nothing is published; the joiner holds nothing, or a record
      // that is "Not finished" (its Remove takes it away).
      expect(aLists).toBe(false);
      expect(netLists).toBe(false);
      expect(rb === null || enrollmentUnfinished(rb)).toBe(true);
    }
    return { outcome: complete ? "complete" : "none", a: ra, b: rb };
  }

  const matrix: [EnrollCrashPoint, Outcome, "nothing" | "unfinished" | "standby"][] = [
    ["inviter:granted", "none", "unfinished"],
    ["inviter:done-received", "none", "unfinished"],
    ["inviter:before-write", "none", "unfinished"],
    ["inviter:after-write", "complete", "standby"],
    ["inviter:after-put", "complete", "standby"],
    ["joiner:grant-received", "none", "nothing"],
    ["joiner:after-write", "none", "unfinished"],
    ["joiner:after-done", "complete", "standby"],
  ];

  it.each(matrix)("a crash at %s ends with %s enrollment (the new device: %s)", async (at, outcome, joinerHolds) => {
    const result = await crashAt(at);
    expect(result.outcome).toBe(outcome);
    const holds = result.b === null ? "nothing" : enrollmentUnfinished(result.b) ? "unfinished" : "standby";
    expect(holds).toBe(joinerHolds);
    // The inviter is `single` again (no set at all) or `active` with both devices: never a set it half wrote.
    if (outcome === "none") expect(result.a).toBeNull();
    else expect(result.a?.deviceSet.filter(Boolean)).toHaveLength(2);
  });

  it("an active device that crashes between storing the record with the new slot and its put: its next start puts it", async () => {
    // A first device set, finished.
    await (async () => { const a = inviter(), b = joiner(); await toDigits(a, b); await a.confirm(true); await until(() => a.ended && b.ended); })();
    const before = (await readDeviceRecord(A))!;
    pipe = new Pipe();
    // The crash comes as the record with the third slot is on its way out: stored, not put.
    let crashed = false;
    network.onPut = () => { if (!crashed) { crashed = true; throw new EnrollCrash("inviter:after-write"); } };
    const a = inviter(), c = joiner({ profile: C, name: "Firefox" });
    await toDigits(a, c);
    await a.confirm(true);
    await until(() => a.ended && c.ended, 5_000);
    expect(enrollmentUnfinished(await readDeviceRecord(C))).toBe(true);
    expect(published(before.d!)?.rev).toBe(0);
    network.onPut = undefined;
    await restart();
    await activeStarts(A);
    expect(await finishEnrollment(C, network, { sleep: noSleep, rounds: 2 })).toBe(true);
    const ra = (await readDeviceRecord(A))!;
    expect(ra.deviceSet.filter(Boolean)).toHaveLength(3);
    expect(lists(published(ra.d!), await keyOf(C))).toBe(true);
  });

  it("a standby that does not list itself keeps its own slot: the keeper takes no record that leaves it out", async () => {
    // The joiner stored the grant; the inviter crashed before it wrote.
    const a = inviter({ crash: "inviter:before-write" }), b = joiner();
    await toDigits(a, b); await a.confirm(true);
    await until(() => a.ended && b.ended, 5_000);
    const rb = (await readDeviceRecord(B))!;
    expect(enrollmentUnfinished(rb)).toBe(true);
    await restart();
    // A valid record of the set that does not list the joiner (what a lagging source shows of a set the joiner was
    // never added to): signed by the inviter, which lists itself alone.
    const inviterKey = (await loadDeviceSigningKey(A))!;
    const packet = await signTurnPacket(turnKeys(fromBase64Url(rb.d!)), {
      turn: 77, rev: 0, author: 0, active: 0, instance: randomBytes(8), slots: [{ key: inviterKey.publicKey, name: "MacBook" }, null, null, null],
    }, (bytes) => inviterKey.sign(bytes));
    network.seed(packet);
    const keeper = (await openTurnKeeper(B, network))!;
    const outcome = await keeper.check(false);
    expect(outcome.kind).toBe("show");
    // Nothing was there to accept: its record still holds its own slot and its key, and it is still not finished.
    const after = (await readDeviceRecord(B))!;
    expect(after.deviceSet[after.ownSlot!]?.key).toBe(await keyOf(B));
    expect(enrollmentUnfinished(after)).toBe(true);
    expect(await finishEnrollment(B, network, { sleep: noSleep, rounds: 2 })).toBe(false);
  });
});
