import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildDataSdp, DATA_CHANNEL_ID, DATA_CHANNEL_LABEL, extractRtcParams, parseRtcSignal, type RtcSignal } from "@ghostly/core";
import { profilePaths, type ProfilePaths } from "../src/profiles";
import type { Runtime } from "../src/runtime/engine";
import { RtcThreads } from "../src/runtime/rtcThreads";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.daemon

/*
 * libdatachannel starts its threads with a process's first WebRTC connection (usrsctp's timer wakes every 10 ms) and
 * kept them for the process's life: a daemon whose WebRTC contacts all went away woke about 100 times a second for good.
 * Once the last connection the CLI made is closed and none is made for a while, they go; the next connection starts
 * them again. The runtime is the daemon's own (`startRuntime`) with node-datachannel, in this process; the contact is a
 * plain node-datachannel connection.
 */

const IDLE_MS = 300;
const root = mkdtempSync(join(tmpdir(), "ghostly-rtc-threads-"));
const env = { ...isolatedNetworkEnv(), GHOSTLY_TEST_RTC_IDLE_MS: String(IDLE_MS) };
const before: Record<string, string | undefined> = {};
const hadRtc = "RTCPeerConnection" in globalThis;
let polyfill: typeof RTCPeerConnection;
let runtime: Runtime | undefined;
const contacts: RTCPeerConnection[] = [];
/** Every connection made here (the runtimes' and the contacts'), and whether it has said it is closed. */
const made = new Map<RTCPeerConnection, boolean>();
/** Each runtime's count (`vi.resetModules` gives each its own; the later ones count through the earlier ones too). */
const counts: RtcThreads[] = [];

beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; }
  polyfill = (await import("node-datachannel/polyfill")).RTCPeerConnection as unknown as typeof RTCPeerConnection;
  // The runtimes keep a RTCPeerConnection already there (`installWebRtc`): this one notes every connection they make.
  if (!hadRtc) (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = class extends polyfill {
    constructor(config?: RTCConfiguration) { super(config); note(this); }
  };
});

afterEach(async () => {
  expect(await closeAll()).toBe(true);
  // Ended with every count's wait over and the threads gone, so node-datachannel's `cleanup()` never runs while this
  // fork is exiting.
  const waited = (count: RtcThreads) => count.idle && (count as unknown as { timer?: unknown }).timer === undefined;
  expect(await until(() => counts.every(waited), IDLE_MS + 5_000)).toBe(true);
  if (existsSync("/proc/self/task")) expect(await until(() => threads("SCTP timer") === 0, 5_000)).toBe(true);
  counts.splice(0);
});

afterAll(() => {
  if (!hadRtc) delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

function note(pc: RTCPeerConnection): void {
  made.set(pc, false);
  pc.addEventListener("connectionstatechange", () => { if (pc.connectionState === "closed" && made.has(pc)) made.set(pc, true); });
}

/**
 * Closes the contacts and the runtime, and lets the idle wait start only once every connection has said it is closed:
 * node-datachannel's `cleanup()` resets each connection's state callback without a lock, so run while libdatachannel
 * still had a close's state change queued it could crash the process (SIGSEGV on Linux ARM64). Once JS has the
 * `closed` change, node-datachannel has let go of that connection. In the daemon the wait is a minute, long after.
 * Whether every connection said so.
 */
async function closeAll(): Promise<boolean> {
  const holds = counts.map((count) => count.opened());
  try {
    for (const pc of contacts.splice(0)) pc.close();
    await runtime?.close();
    runtime = undefined;
    return await until(() => [...made.values()].every(Boolean), 5_000);
  } finally {
    made.clear();
    for (const release of holds) release();
  }
}

/** This process's threads named so (Linux names libdatachannel's). */
function threads(name: string): number {
  return readdirSync("/proc/self/task").filter((task) => {
    try { return readFileSync(`/proc/self/task/${task}/comm`, "utf8").trim() === name; } catch { return false; }
  }).length;
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) return false; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return true;
}

async function start(paths: ProfilePaths): Promise<Runtime> {
  vi.resetModules();
  runtime = await (await import("../src/runtime/engine")).startRuntime(paths);
  expect(runtime.webrtc).toBe(true);
  counts.push((await import("../src/runtime/rtcThreads")).rtcThreads);
  return runtime;
}

function profile(name: string): ProfilePaths {
  const paths = profilePaths(join(root, "home"), name);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") resolve(); });
    setTimeout(resolve, 5_000);
  });
}

type ChatLink = { dataLink: { handleSignal(json: string): Promise<void>; options: { publishSignal(json: string): void } } };

/** A contact's offer handed to a chat's data link, its answer applied on the contact's side: whether the channel opens. */
async function offerFromContact(node: Runtime["server"]["node"], linkId: string): Promise<boolean> {
  const link = (node as unknown as { links: Map<string, { link: ChatLink | null }> }).links.get(linkId)!.link!;
  const answers: RtcSignal[] = [];
  link.dataLink.options.publishSignal = json => { const signal = parseRtcSignal(json); if (signal?.t === "a") answers.push(signal); };
  const contact = new polyfill({ iceServers: [] });
  contacts.push(contact);
  note(contact);
  const channel = contact.createDataChannel(DATA_CHANNEL_LABEL, { negotiated: true, id: DATA_CHANNEL_ID, ordered: true });
  const opened = new Promise<boolean>(resolve => { channel.addEventListener("open", () => resolve(true)); setTimeout(() => resolve(false), 10_000); });
  await contact.setLocalDescription(await contact.createOffer());
  await gathered(contact);
  await link.dataLink.handleSignal(JSON.stringify({ t: "o", ts: Date.now(), ...extractRtcParams(contact.localDescription!.sdp) }));
  if (!answers[0]) return false;
  await contact.setRemoteDescription({ type: "answer", sdp: buildDataSdp(answers[0]) });
  return opened;
}

describe("libdatachannel's threads", () => {
  it.skipIf(!existsSync("/proc/self/task"))("go once the CLI's last WebRTC connection is closed, and come back with the next", async () => {
    const first = await start(profile("first"));
    const { linkId } = await first.server.node.createLink();
    expect(await offerFromContact(first.server.node, linkId)).toBe(true);
    expect(threads("SCTP timer")).toBe(1);
    expect(counts[0]!.idle).toBe(false);

    expect(await closeAll()).toBe(true);
    // Kept for 100 times a second before.
    expect(await until(() => threads("SCTP timer") === 0, IDLE_MS + 5_000)).toBe(true);

    const second = await start(profile("second"));
    const again = await second.server.node.createLink();
    expect(await offerFromContact(second.server.node, again.linkId)).toBe(true);
    expect(threads("SCTP timer")).toBe(1);
  }, 60_000);
});

describe("RtcThreads", () => {
  it("cleans up only once no connection has been open for its time", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const count = new RtcThreads(cleanup, 1_000);
      const one = count.opened(), two = count.opened();
      one();
      one();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cleanup).not.toHaveBeenCalled();
      two();
      await vi.advanceTimersByTimeAsync(500);
      // A connection made in the wait keeps them, and its close starts the wait again.
      const three = count.opened();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cleanup).not.toHaveBeenCalled();
      three();
      await vi.advanceTimersByTimeAsync(999);
      expect(cleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(count.idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
