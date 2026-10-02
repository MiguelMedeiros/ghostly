import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { AudioSocket, audioSocketPath } from "../src/calls/audioSocket";
import { CallManager, MAX_REDIALS, type CallEngine } from "../src/calls/manager";
import { loadCallStack, type CallStack } from "../src/calls/media";
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

function pairOfManagers(stacks: { a?: () => Promise<CallStack | string>; now?: () => number; delay?: number; maxRedials?: number } = {}): { a: Side; b: Side } {
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
      if (signal) setTimeout(() => other().calls.onSignal(other().link.id!, signal), stacks.delay ?? 5);
    },
  });
  a.calls = new CallManager({ engine: engine(a, () => b), emit: (type, _id, fields) => a.events.push({ type, ...fields }), profileDir: tmp(), stack: stacks.a, now: stacks.now, maxRedials: stacks.maxRedials });
  b.calls = new CallManager({ engine: engine(b, () => a), emit: (type, _id, fields) => b.events.push({ type, ...fields }), profileDir: tmp(), now: stacks.now });
  return { a, b };
}

/**
 * The real media stack, but the first `refuse` answers applied on it are refused as libdatachannel 0.24.5 refuses one
 * in its race (see CallManager's `redial`): the connection closes, and adding the answer throws. With `ending:
 * "fails"`, the race's other ending: the answer goes in, and the connection fails at once. Ours are never applied, so
 * the contact's side cannot connect on one. The real race, in either ending, comes on top of ours (CI runners lose
 * about one answer in six): `refused()` counts them all, and a test that refuses answers raises the caller's
 * `maxRedials` by as many, so the app's own tries stay whole for the real ones.
 */
function refusingStack(refuse: number, ending: "throws" | "fails" = "throws"): (() => Promise<CallStack | string>) & { refused: () => number } {
  let refused = 0;
  const stack = async () => {
    const real = await loadCallStack();
    if (typeof real === "string") return real;
    const Real = real.ndc.PeerConnection;
    function PeerConnection(...args: ConstructorParameters<typeof Real>) {
      const pc = new Real(...args);
      const apply = pc.setRemoteDescription.bind(pc);
      const listen = pc.onStateChange.bind(pc);
      // Whether this connection's answer went in, and whether its refusal was counted.
      let answered = false, connected = false, counted = false;
      // A connection failed here ("fails"): what the real one says after is not heard.
      let deliver: ((state: string) => void) | null = null, faked = false;
      const refuseIt = () => { if (!counted) { counted = true; refused++; } };
      // The native methods are read-only on the prototype: the connection gets its own.
      Object.defineProperty(pc, "setRemoteDescription", {
        value: (sdp: string, type: Parameters<typeof apply>[1]) => {
          if (type !== "answer") return apply(sdp, type);
          // Set first: the connection can fail while the answer goes in.
          answered = true;
          if (refused < refuse) {
            refuseIt();
            if (ending === "fails") {
              faked = true;
              pc.close();
              setTimeout(() => deliver?.("failed"), 0);
              return;
            }
            pc.close();
            throw new Error("libdatachannel error while adding remote description: Got a remote candidate without ICE transport");
          }
          try {
            return apply(sdp, type);
          } catch (error) {
            refuseIt();
            throw error;
          }
        },
      });
      Object.defineProperty(pc, "onStateChange", {
        value: (cb: Parameters<typeof listen>[0]) => {
          deliver = (state) => {
            if (state === "connected") connected = true;
            if (state === "failed" && answered && !connected) refuseIt();
            cb(state as Parameters<typeof cb>[0]);
          };
          listen((state) => { if (!faked) deliver!(state); });
        },
      });
      return pc;
    }
    return { ...real, ndc: { ...real.ndc, PeerConnection } as unknown as CallStack["ndc"] };
  };
  return Object.assign(stack, { refused: () => refused });
}

const signalsOf = (side: Side, t: string) => side.signals.filter((s) => s && JSON.parse(s).t === t);
const diagnose = (a: Side, b: Side) => (e: Error) => { throw new Error(`${e.message}\nA: ${JSON.stringify(a.events)}\nB: ${JSON.stringify(b.events)}\nsignals A ${a.signals.length} B ${b.signals.length}`); };

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
    expect(a.calls.list()).toMatchObject([{ state: "connected", stats: { programConnected: true, ice: { state: expect.stringMatching(/^(connected|completed)$/), pair: expect.stringMatching(/:\d+ host <-> .+:\d+ (host|prflx)$/) } } }]);
    await b.calls.hangup("chat-ba");
    await Promise.all([alice.ended, bob.ended]);
    const endedA = await until(() => a.events.find((e) => e.type === "call.ended"));
    expect(endedA).toMatchObject({ reason: "remote-hangup" });
    expect(endedA.duration).toBeGreaterThan(1000);
    expect(b.events.find((e) => e.type === "call.ended")).toMatchObject({ reason: "hangup" });
    expect(a.calls.list()).toEqual([]);
    expect(existsSync(placed.audio.socket)).toBe(false);
  });

  it("does not say it restarts ICE (libdatachannel cannot), and a restart offer changes nothing: no ring, no answer, the call goes on", async () => {
    const { a, b } = pairOfManagers();
    b.calls.setAuto({ on: true, from: [], rate: 16000 });
    // With no call on, a restart offer rings nobody.
    const stray = { t: "r", ts: Date.now(), u: "strayU", p: "strayPstrayPstrayPstrayP", f: "ab".repeat(32), s: "actpass", m: ["a"], c: [], x: 1 };
    b.calls.onSignal("chat-ba", JSON.stringify(stray));
    expect(b.events).toEqual([]);
    expect(b.calls.list()).toEqual([]);

    await a.calls.start("chat-ab", {});
    await Promise.all([a, b].map((side) => until(() => side.events.find((e) => e.type === "call.connected"))));
    // Neither its offer nor its answer says `x`: an app's call with it ends on a lost path as before (WISP 601).
    const [offer] = signalsOf(a, "o").map((s) => JSON.parse(s!));
    const [answer] = signalsOf(b, "a").map((s) => JSON.parse(s!));
    expect(offer.x).toBeUndefined();
    expect(answer.x).toBeUndefined();

    // An app would not send one to a side that did not say `x`; one that comes all the same is dropped.
    const sent = b.signals.length;
    b.calls.onSignal("chat-ba", JSON.stringify({ ...offer, t: "r", ts: Date.now() + 1, u: "newU", p: "newPnewPnewPnewPnewPnewP", x: 1 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(b.signals).toHaveLength(sent);
    expect(b.calls.list()).toMatchObject([{ state: "connected" }]);
    expect(a.calls.list()).toMatchObject([{ state: "connected" }]);
    await a.calls.hangup("chat-ab");
    await until(() => b.events.find((e) => e.type === "call.ended"));
  });

  it("a hang-up saying the contact could not connect (an app whose microphone was refused) ends a ringing call as failed", async () => {
    const { a, b } = pairOfManagers();
    await a.calls.start("chat-ab", {});
    await until(() => b.events.find((e) => e.type === "call.incoming"));
    // What an app sends when its answer could not use the microphone (useWebRTC, WISP 601 "Couldn't connect").
    a.calls.onSignal("chat-ab", JSON.stringify({ t: "h", ts: Date.now() + 1, r: "u" }));
    expect(await until(() => a.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "failed" });
    expect(a.calls.list()).toEqual([]);
    await a.calls.stopAll();
    await b.calls.stopAll();
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

  /** Both sides call each other at once; the side whose offer lost is the one that ends its call as `crossed`. */
  async function glare(a: Side, b: Side) {
    await Promise.allSettled([a.calls.start("chat-ab", {}), b.calls.start("chat-ba", {})]);
    const crossed = (s: Side) => s.events.some((e) => e.type === "call.ended" && e.reason === "crossed");
    const loser = await until(() => [a, b].find(crossed)).catch(diagnose(a, b));
    const winner = loser === a ? b : a;
    await until(() => loser.events.find((e) => e.type === "call.incoming")).catch(diagnose(a, b));
    // Its own call ended first, then the contact's rang; it sent no hang-up, which would end the contact's call.
    expect(loser.events.map((e) => e.type).filter((t) => t !== "call.outgoing")).toEqual(["call.ended", "call.incoming"]);
    expect(signalsOf(loser, "h")).toEqual([]);
    expect(crossed(winner)).toBe(false);
    expect(winner.calls.list()).toMatchObject([{ direction: "out", state: "ringing" }]);
    expect(loser.calls.list()).toMatchObject([{ direction: "in", state: "ringing" }]);
    return { loser, winner };
  }

  it("both call at once: the earlier offer rings on the other side, and answering it connects", async () => {
    const { a, b } = pairOfManagers();
    const { loser } = await glare(a, b);
    await loser.calls.answer(undefined, {});
    await Promise.all([
      until(() => a.events.find((e) => e.type === "call.connected")),
      until(() => b.events.find((e) => e.type === "call.connected")),
    ]).catch(diagnose(a, b));
    await a.calls.stopAll();
    await b.calls.stopAll();
  });

  it("both call at once in the same millisecond: the lower DTLS fingerprint wins", async () => {
    const at = Date.now();
    // The session is slow enough that both offers go out before either arrives: the tie is decided by the offers alone.
    const { a, b } = pairOfManagers({ now: () => at, delay: 1500 });
    const { winner } = await glare(a, b);
    const offerOf = (s: Side) => JSON.parse(signalsOf(s, "o")[0]!) as { ts: number; f: string };
    const [mine, theirs] = [offerOf(winner), offerOf(winner === a ? b : a)];
    expect(mine.ts).toBe(theirs.ts);
    expect(mine.f < theirs.f).toBe(true);
    await a.calls.stopAll();
    await b.calls.stopAll();
  });

  // Once connected, the caller hears a hang-up as one even when it started over first (CI run 36697428485: the real
  // race made it redial, and the stop ended its call as `failed`).
  for (const refuse of [0, 1]) {
    it(`a daemon that stops hangs up its calls first${refuse ? ", after the caller started over" : ""}`, async () => {
      const stack = refusingStack(refuse);
      const { a, b } = pairOfManagers({ a: stack, maxRedials: refuse + MAX_REDIALS });
      b.calls.setAuto({ on: true });
      await a.calls.start("chat-ab", {});
      await until(() => a.events.find((e) => e.type === "call.connected")).catch(diagnose(a, b));
      expect(signalsOf(a, "o")).toHaveLength(stack.refused() + 1);
      await b.calls.stopAll();
      expect(b.events.find((e) => e.type === "call.ended")).toMatchObject({ reason: "stopped" });
      expect(await until(() => a.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "remote-hangup" });
      await expect(b.calls.start("chat-ba", {})).rejects.toMatchObject({ code: "unavailable" });
    });
  }

  it("an offer that arrives while the daemon stops rings nothing and throws nothing", async () => {
    const { a, b } = pairOfManagers();
    await b.calls.stopAll();
    await a.calls.start("chat-ab", {});
    // The chat session hands it over as the daemon stops: it was thrown out of the session's event ("The daemon is
    // stopping"), an error nobody handled.
    const offer = signalsOf(a, "o")[0]!;
    expect(() => b.calls.onSignal("chat-ba", offer)).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(b.calls.list()).toEqual([]);
    expect(b.events.filter((e) => e.type === "call.incoming")).toEqual([]);
    await a.calls.stopAll();
  });

  it("an answer refused as its connection closes: both sides start over once, on new connections and the same sockets", async () => {
    const stack = refusingStack(1);
    const { a, b } = pairOfManagers({ a: stack, maxRedials: 1 + MAX_REDIALS });
    b.calls.setAuto({ on: true, rate: 16000 });
    const placed = await a.calls.start("chat-ab", { rate: 48000 }) as { call: string; audio: { socket: string } };
    const alice = await program(placed.audio.socket);
    const [, connectedB] = await Promise.all([
      until(() => a.events.find((e) => e.type === "call.connected")),
      until(() => b.events.find((e) => e.type === "call.connected")),
    ]).catch(diagnose(a, b));
    expect(signalsOf(a, "o")).toHaveLength(stack.refused() + 1);
    expect(signalsOf(b, "a")).toHaveLength(stack.refused() + 1);
    expect(signalsOf(a, "h")).toHaveLength(0);
    expect(a.events.map((e) => e.type)).toEqual(["call.outgoing", "call.connected"]);
    expect(b.events.map((e) => e.type)).toEqual(["call.incoming", "call.connected"]);
    expect(a.calls.list()).toMatchObject([{ call: placed.call, state: "connected", audio: { socket: placed.audio.socket } }]);

    // The program that connected before the answer speaks over the new connection.
    const bob = await program((connectedB.audio as { socket: string }).socket);
    alice.socket.write(tone(440, 48000, 1500));
    await until(() => bob.heard().length >= 640 * 60, 20_000);
    expect(dominantHz(bob.heard().subarray(640 * 20, 640 * 60), 16000)).toBeCloseTo(440, -1);

    await a.calls.hangup(undefined);
    await Promise.all([alice.ended, bob.ended]);
    expect(await until(() => b.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "remote-hangup" });
  });

  // Linux arm64 runners saw the race twice in a row (CI run 36667046330): one start-over was not enough.
  for (const refuse of [2, 3]) {
    it(`an answer refused ${refuse} times in a row: the call still connects, on the same sockets`, async () => {
      const stack = refusingStack(refuse);
      const { a, b } = pairOfManagers({ a: stack, maxRedials: refuse + MAX_REDIALS });
      b.calls.setAuto({ on: true });
      const placed = await a.calls.start("chat-ab", {}) as { call: string; audio: { socket: string } };
      await Promise.all([
        until(() => a.events.find((e) => e.type === "call.connected")),
        until(() => b.events.find((e) => e.type === "call.connected")),
      ]).catch(diagnose(a, b));
      expect(signalsOf(a, "o")).toHaveLength(stack.refused() + 1);
      expect(signalsOf(b, "a")).toHaveLength(stack.refused() + 1);
      expect(signalsOf(a, "h")).toHaveLength(0);
      expect(signalsOf(b, "h")).toHaveLength(0);
      expect(a.events.map((e) => e.type)).toEqual(["call.outgoing", "call.connected"]);
      expect(b.events.map((e) => e.type)).toEqual(["call.incoming", "call.connected"]);
      expect(a.calls.list()).toMatchObject([{ call: placed.call, state: "connected", audio: { socket: placed.audio.socket } }]);
      await a.calls.stopAll();
      await b.calls.stopAll();
    });
  }

  it("an answer that goes in, its connection failing at once, 2 times in a row: the call still connects, on the same sockets", async () => {
    // The race's other ending (CI run 36695348205): the caller ended the call 3 s later as a remote hang-up, untold.
    const stack = refusingStack(2, "fails");
    const { a, b } = pairOfManagers({ a: stack, maxRedials: 2 + MAX_REDIALS });
    b.calls.setAuto({ on: true });
    const placed = await a.calls.start("chat-ab", {}) as { call: string; audio: { socket: string } };
    await Promise.all([
      until(() => a.events.find((e) => e.type === "call.connected")),
      until(() => b.events.find((e) => e.type === "call.connected")),
    ]).catch(diagnose(a, b));
    expect(stack.refused()).toBeGreaterThanOrEqual(2);
    expect(signalsOf(a, "o")).toHaveLength(stack.refused() + 1);
    expect(signalsOf(b, "a")).toHaveLength(stack.refused() + 1);
    expect(signalsOf(a, "h")).toHaveLength(0);
    expect(a.events.map((e) => e.type)).toEqual(["call.outgoing", "call.connected"]);
    expect(b.events.map((e) => e.type)).toEqual(["call.incoming", "call.connected"]);
    expect(a.calls.list()).toMatchObject([{ call: placed.call, state: "connected", audio: { socket: placed.audio.socket } }]);
    await a.calls.stopAll();
    await b.calls.stopAll();
  });

  it("answers refused past the last start-over end the call as failed, and the contact is told", async () => {
    // The first offer and MAX_REDIALS more, each answer refused.
    const { a, b } = pairOfManagers({ a: refusingStack(MAX_REDIALS + 1) });
    b.calls.setAuto({ on: true });
    await a.calls.start("chat-ab", {});
    expect(await until(() => a.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "failed" });
    expect(await until(() => b.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "remote-hangup" });
    expect(signalsOf(a, "o")).toHaveLength(MAX_REDIALS + 1);
    expect(signalsOf(b, "a")).toHaveLength(MAX_REDIALS + 1);
    expect(signalsOf(a, "h")).toHaveLength(1);
    expect(a.events.find((e) => e.type === "call.connected")).toBeUndefined();
    expect(a.calls.list()).toEqual([]);
    await a.calls.stopAll();
    await b.calls.stopAll();
  });

  it("a contact that does not answer the second offer, as the apps do, hangs up: the call failed", async () => {
    const { a, b } = pairOfManagers({ a: refusingStack(1) });
    b.calls.setAuto({ on: true });
    // The apps answer an offer only while idle (useWebRTC): their connection fails with the caller's, and they hang up.
    const onSignal = b.calls.onSignal.bind(b.calls);
    b.calls.onSignal = (chat, json) => {
      if (JSON.parse(json).t === "o" && signalsOf(b, "a").length) void b.calls.hangup(undefined);
      else onSignal(chat, json);
    };
    await a.calls.start("chat-ab", {});
    expect(await until(() => a.events.find((e) => e.type === "call.ended"))).toMatchObject({ reason: "failed" });
    expect(signalsOf(a, "o")).toHaveLength(2);
    expect(a.calls.list()).toEqual([]);
    await a.calls.stopAll();
    await b.calls.stopAll();
  });
});
