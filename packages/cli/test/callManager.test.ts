import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { AudioSocket, audioSocketPath } from "../src/calls/audioSocket";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { dominantHz, level, tone } from "./support/tone";
// covers: headless.calls

/**
 * The call manager end to end without the engine: two managers whose signals go straight to each other (as the chat
 * session would carry them), real libdatachannel media on loopback, and programs on the audio sockets.
 */
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "gc-")); dirs.push(d); return d; };
let bindBefore: string | undefined;
beforeAll(() => { bindBefore = process.env.GHOSTLY_CALL_BIND; process.env.GHOSTLY_CALL_BIND = "127.0.0.1"; });
afterAll(() => {
  if (bindBefore === undefined) delete process.env.GHOSTLY_CALL_BIND; else process.env.GHOSTLY_CALL_BIND = bindBefore;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Side { calls: CallManager; events: { type: string; [k: string]: unknown }[]; signals: (string | null)[]; link: Partial<LinkView> }

function pairOfManagers(): { a: Side; b: Side } {
  const make = (chat: string): Side => {
    const side = { events: [], signals: [], link: { id: chat, profile: "paired-chat/1", callsUnavailable: null, label: `to ${chat}` } } as unknown as Side;
    return side;
  };
  const a = make("chat-ab"), b = make("chat-ba");
  const engine = (me: Side, other: () => Side): CallEngine => ({
    getState: () => ({ links: [me.link] }) as unknown as EngineState,
    setCallSignal: async ({ signal }) => {
      me.signals.push(signal);
      // The chat session carries it to the contact, a moment later.
      if (signal) setTimeout(() => other().calls.onSignal(other().link.id!, signal), 5);
    },
  });
  a.calls = new CallManager({ engine: engine(a, () => b), emit: (type, _id, fields) => a.events.push({ type, ...fields }), profileDir: tmp() });
  b.calls = new CallManager({ engine: engine(b, () => a), emit: (type, _id, fields) => b.events.push({ type, ...fields }), profileDir: tmp() });
  return { a, b };
}

async function until<T>(check: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A program on a call's socket: what it hears, and a way to speak. */
async function program(path: string): Promise<{ socket: Socket; heard: () => Buffer; ended: Promise<void> }> {
  const socket = connect(path);
  const chunks: Buffer[] = [];
  socket.on("data", (d: Buffer) => chunks.push(d));
  const ended = new Promise<void>((resolve) => socket.on("end", () => resolve()));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, heard: () => Buffer.concat(chunks), ended };
}

describe("the audio socket", () => {
  it("serves one program at a time, owner-only, and ends it with EOF", async () => {
    const path = audioSocketPath(tmp(), "abc");
    const got: Buffer[] = [];
    const socket = await AudioSocket.open(path, 16000, { onAudio: (c) => got.push(c) });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const first = await program(path);
    await until(() => socket.connected);
    first.socket.write(Buffer.from([1, 2, 3, 4]));
    await until(() => got.length);
    socket.write(Buffer.alloc(640, 7));
    await until(() => first.heard().length === 640);
    // A second program replaces the first, which reads EOF.
    const second = await program(path);
    await first.ended;
    second.socket.write(Buffer.from([5, 6]));
    await until(() => Buffer.concat(got).length === 6);
    await socket.close();
    await second.ended;
    expect(existsSync(path)).toBe(false);
  });

  it("moves to a private folder in /tmp when the profile's path is too long for a socket, and refuses a shared one", async () => {
    const long = join(tmp(), "x".repeat(120));
    const path = audioSocketPath(long, "abc");
    expect(path).toMatch(/^\/tmp\/ghostly-calls-[0-9a-f]{24}\/abc\.sock$/);
    expect(audioSocketPath("/home/bot/.ghostly/profiles/p", "abc")).toBe("/home/bot/.ghostly/profiles/p/calls/abc.sock");
    const socket = await AudioSocket.open(path, 48000, { onAudio: () => {} });
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    await socket.close();
    chmodSync(join(path, ".."), 0o755);
    await expect(AudioSocket.open(path, 48000, { onAudio: () => {} })).rejects.toThrow(/not a folder of this user's alone/);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});

describe("two call managers", { timeout: 60_000 }, () => {
  it("call, auto-answer, a tone each way through the programs, flush, hang up", async () => {
    const { a, b } = pairOfManagers();
    b.calls.setAuto({ on: true, from: ["chat-ba"], rate: 16000 });
    expect(JSON.parse(readFileSync(join(dirs.at(-1)!, "calls.json"), "utf8"))).toEqual({ autoAnswer: { on: true, from: ["chat-ba"], rate: 16000 } });

    const placed = await a.calls.start("chat-ab", { rate: 48000 }) as { call: string; audio: { socket: string; rate: number } };
    expect(placed).toMatchObject({ direction: "out", state: "ringing", audio: { rate: 48000, channels: 1, format: "s16le", frameMs: 20 } });
    expect(a.events.map((e) => e.type)).toEqual(["call.outgoing"]);
    // The program may connect before anyone answered.
    const alice = await program(placed.audio.socket);

    const incoming = await until(() => b.events.find((e) => e.type === "call.incoming"));
    expect(incoming).toMatchObject({ chat: "chat-ba", name: "to chat-ba", video: false, auto: true });
    const [connectedA, connectedB] = await Promise.all([
      until(() => a.events.find((e) => e.type === "call.connected")),
      until(() => b.events.find((e) => e.type === "call.connected")),
    ]);
    expect(connectedB).toMatchObject({ direction: "in", audio: { rate: 16000 } });
    const bob = await program((connectedB.audio as { socket: string }).socket);
    expect(connectedA).toMatchObject({ direction: "out", audio: { socket: placed.audio.socket } });

    // Each program speaks faster than real time; the other hears it at its own rate.
    alice.socket.write(tone(440, 48000, 1500));
    bob.socket.write(tone(660, 16000, 1500));
    await until(() => bob.heard().length >= 640 * 60 && alice.heard().length >= 1920 * 60, 20_000);
    expect(dominantHz(bob.heard().subarray(640 * 20, 640 * 60), 16000)).toBeCloseTo(440, -1);
    expect(dominantHz(alice.heard().subarray(1920 * 20, 1920 * 60), 48000)).toBeCloseTo(660, -1);

    // Barge-in: a long sentence queued, then flushed; silence follows at once.
    alice.socket.write(tone(440, 48000, 10_000));
    await new Promise((r) => setTimeout(r, 300));
    const { flushedMs } = a.calls.flush(undefined) as { flushedMs: number };
    expect(flushedMs).toBeGreaterThan(8000);
    const mark = bob.heard().length;
    await until(() => bob.heard().length >= mark + 640 * 25);
    expect(level(bob.heard().subarray(mark + 640 * 10, mark + 640 * 25))).toBeLessThan(0.01);

    // Where the call runs, for a person reading `call list` when one does not connect.
    expect(a.calls.list()).toMatchObject([{ state: "connected", stats: { programConnected: true, ice: { state: expect.stringMatching(/^(connected|completed)$/), pair: expect.stringMatching(/:\d+ host <-> .+:\d+ host$/) } } }]);
    await b.calls.hangup("chat-ba");
    await Promise.all([alice.ended, bob.ended]);
    const endedA = await until(() => a.events.find((e) => e.type === "call.ended"));
    expect(endedA).toMatchObject({ reason: "remote-hangup" });
    expect(endedA.duration).toBeGreaterThan(1000);
    expect(b.events.find((e) => e.type === "call.ended")).toMatchObject({ reason: "hangup" });
    expect(a.calls.list()).toEqual([]);
    expect(existsSync(placed.audio.socket)).toBe(false);
  });

  it("an unanswered call is missed on one side, declined on the other, and busy chats refuse a second", async () => {
    const { a, b } = pairOfManagers();
    await a.calls.start("chat-ab", {});
    await expect(a.calls.start("chat-ab", {})).rejects.toMatchObject({ code: "busy" });
    await until(() => b.events.find((e) => e.type === "call.incoming"));
    expect(b.calls.list()).toMatchObject([{ direction: "in", state: "ringing", audio: null }]);
    await b.calls.hangup(undefined);
    expect(await until(() => a.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "rejected" });
    expect(b.events.find((e) => e.type === "call.ended")).toMatchObject({ reason: "hangup" });

    // The caller gives up while it rings: missed.
    await a.calls.start("chat-ab", {});
    await until(() => b.events.filter((e) => e.type === "call.incoming").length === 2);
    await a.calls.hangup(undefined);
    expect(await until(() => b.events.filter((e) => e.type === "call.ended")[1])).toMatchObject({ reason: "missed" });
    await expect(b.calls.answer(undefined, {})).rejects.toMatchObject({ code: "not_found" });
    // The hang-up signal is cleared later, as the apps do; stopping sends nothing more.
    expect(a.signals.at(-1)).toMatch(/"t":"h"/);
    await a.calls.stopAll();
    await b.calls.stopAll();
  });

  it("a daemon that stops hangs up its calls first", async () => {
    const { a, b } = pairOfManagers();
    b.calls.setAuto({ on: true });
    await a.calls.start("chat-ab", {});
    await until(() => a.events.find((e) => e.type === "call.connected"));
    await b.calls.stopAll();
    expect(b.events.find((e) => e.type === "call.ended")).toMatchObject({ reason: "stopped" });
    expect(await until(() => a.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "remote-hangup" });
    await expect(b.calls.start("chat-ba", {})).rejects.toMatchObject({ code: "unavailable" });
  });
});
