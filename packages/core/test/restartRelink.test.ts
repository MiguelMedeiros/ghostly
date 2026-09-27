import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PkarrTransport } from "../src/transport";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";
import { setLinkTraceSink } from "../src/linkTrace";

// covers: chat.paired.reconnect, core.liveness

/**
 * One app of a paired chat quits (or crashes) and starts again, the other stays up: how long until the chat is live
 * again on both sides (Miguel, 2026-09-27: ~30 s before the CLI noticed, ~60 s more to be live again, over Iroh
 * relayed). Two links from a paired chat, as the engine runs them (node.ts `startLink`): an in-memory Pkarr with the
 * network's delays, Iroh stood in for by named endpoints that keep their id across a restart (NativeWorld), WebRTC
 * by peer connections (pairingWorld), fake time. Both on the relays' poll pace, the chat not on screen: the slowest
 * case. Numbers go to `RESTART_REPORT` when it is set.
 */

type Kind = "iroh" | "webrtc";
interface App { name: string; side: Side; link: GhostLink; dhtState: DhtDeliveryState; requests: { at: number }[]; stopped?: Promise<void> }

/** The session the staying side holds: a new one (or none) means it let the old one go. */
const channelOf = (app: App) => (app.link as unknown as { channel: unknown }).channel;
const apps: App[] = [];
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

function counted(pkarr: MemoryPkarr, requests: App["requests"]): PkarrTransport {
  const inner = pkarr.transport();
  return {
    publish: (identity, records) => { requests.push({ at: Date.now() }); return inner.publish(identity, records); },
    resolve: (key, options) => { requests.push({ at: Date.now() }); return inner.resolve(key, options); },
    describe: inner.describe,
  };
}

function startApp(world: { pkarr: MemoryPkarr; native: NativeWorld }, name: string, side: Side, contact: { side: Side; name: string }, kind: Kind, dhtState: DhtDeliveryState, wasLive = false): App {
  const app = { name, side, dhtState, requests: [] } as unknown as App;
  const peerIroh = { id: `${contact.name}:iroh/1`, relay: "https://relay.test./", addresses: [] };
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: kind === "webrtc",
    pairing: { credentials: { seedB64: side.seedB64, peerKey: peerKeyOf(contact.side) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: dhtState, save: async state => { app.dhtState = state; } },
    native: kind === "iroh"
      ? { peerDescriptors: { "iroh/1": peerIroh }, peerTransports: ["iroh/1"], peerFallback: true, automatic: true }
      : { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    ...(wasLive ? { resume: kind === "iroh" ? "iroh/1" as const : "webrtc/1" as const } : {}),
    transport: counted(world.pkarr, app.requests),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  apps.push(app);
  app.link.start();
  app.link.setChatActive(false);
  if (kind === "iroh") app.link.registerEndpoint(world.native.endpoint("iroh/1", name));
  // node.ts startLink: a saved contact with transports known is dialled once the endpoints are up, by the lower key.
  if (app.link.myPubKeyZ32 < side.params.peerPubKeyZ32) void app.link.connect().catch(() => {});
  return app;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(100);
  }
  return Date.now() - start;
}

/**
 * The app ends: gracefully (it says goodbye and has `DEPART_FLUSH_MS` before it exits, as the Desktop's exit hook and
 * the CLI's stop give it), or not at all (a crash, a kill). Either way no close of its connections reaches anyone.
 */
async function quit(world: { native: NativeWorld }, app: App, how: "graceful" | "crash"): Promise<void> {
  if (how === "graceful") { app.link.depart(); await run(DEPART_FLUSH_MS); }
  world.native.kill(app.name);
  killRtc(app.name);
  app.stopped = app.link.stop(false);
}

const DEPART_FLUSH_MS = 300;
const RESTART_AFTER_MS = 3_000;

interface Result { kind: Kind; restarted: "lower" | "higher"; how: "graceful" | "crash"; downSeenMs: number; liveAgainMs: number; requestsPerMin: number; dialFailures: number }
function report(result: Result): void {
  const file = process.env.RESTART_REPORT;
  if (file) appendFileSync(file, JSON.stringify(result) + "\n");
}

async function restart(kind: Kind, restarted: "lower" | "higher", how: "graceful" | "crash"): Promise<Result> {
  const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
  // The inviter has the lower link key here: it is the one that dials.
  const made = invitationWhere("inviter");
  const [lowSide, highSide] = [made.inviter, made.joiner];
  const [goesSide, staysSide] = restarted === "lower" ? [lowSide, highSide] : [highSide, lowSide];
  let goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, emptyDhtDeliveryState());
  const stays = startApp(world, "stays", staysSide, { side: goesSide, name: "goes" }, kind, emptyDhtDeliveryState());
  expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
  await run(20_000);
  expect(goes.link.isDataLinkOpen && stays.link.isDataLinkOpen).toBe(true);

  const before = channelOf(stays);
  const quitAt = Date.now();
  await quit(world, goes, how);
  const failuresBefore = world.native.dialFailures;
  // When the staying side lets the old session go (it may only do so once the other app is back).
  let downSeenAt = 0;
  const watch = () => { if (!downSeenAt && channelOf(stays) !== before) downSeenAt = Date.now(); };
  for (let t = 0; t < RESTART_AFTER_MS; t += 100) { await run(100); watch(); }
  const dhtState = goes.dhtState;
  goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, dhtState, true);
  const restartedAt = Date.now();
  const liveAgainMs = await until(() => {
    watch();
    return goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== before;
  }, 5 * 60_000);
  // Requests for discovery (Pkarr reads and publishes) in the two minutes from the restart, per minute, the busier app.
  await run(Math.max(0, restartedAt + 120_000 - Date.now()));
  const inWindow = (app: App) => app.requests.filter(r => r.at >= restartedAt && r.at < restartedAt + 120_000).length / 2;
  const result: Result = { kind, restarted, how, downSeenMs: downSeenAt ? downSeenAt - quitAt : Infinity, liveAgainMs,
    requestsPerMin: Math.max(inWindow(goes), inWindow(stays)), dialFailures: world.native.dialFailures - failuresBefore };
  report(result);
  await goes.stopped;
  return result;
}

beforeEach(() => {
  useFakeWorld();
  // Every step of both links, for reading where the time went.
  const trace = process.env.RESTART_TRACE;
  if (trace) setLinkTraceSink(line => appendFileSync(trace, line + "\n"));
});
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map(app => app.stopped ?? app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

describe.each(["iroh", "webrtc"] as const)("a paired chat over %s after one app restarts", kind => {
  describe.each(["lower", "higher"] as const)("the app with the %s key restarts", restarted => {
    it.each(["graceful", "crash"] as const)("%s: live again within the target, on a small discovery budget", async how => {
      const result = await restart(kind, restarted, how);
      // Before (dev at 57bd8d2e): Iroh 61 s (lower) and 28 s (higher), noticed after 30 s; WebRTC 16-18 s.
      expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(how === "graceful" ? 5_000 : 15_000);
      if (how === "graceful") expect(result.downSeenMs, "the goodbye ends the session at once").toBeLessThanOrEqual(1_000);
      // The relays allow 30 requests a minute per client, reads and publishes together, for every chat.
      expect(result.requestsPerMin).toBeLessThanOrEqual(10);
      // Nothing dials an app that is not there: a departing app does not redial, the staying one waits for the other back.
      expect(result.dialFailures).toBe(0);
    }, 240_000);
  });
});

describe("coming back after a restart, the edges", () => {
  it("two apps that restart together both knock, and settle on the lower key's connection", async () => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const low = startApp(world, "low", made.inviter, { side: made.joiner, name: "high" }, "iroh", emptyDhtDeliveryState(), true);
    const high = startApp(world, "high", made.joiner, { side: made.inviter, name: "low" }, "iroh", emptyDhtDeliveryState(), true);
    // The lower key's knock goes before the other app is up and fails (after `dialFailMs`); the other's waits meanwhile.
    expect(await until(() => low.link.isDataLinkOpen && high.link.isDataLinkOpen, 60_000)).toBeLessThanOrEqual(5_000);
    const [lowChannel, highChannel] = [channelOf(low), channelOf(high)];
    await run(60_000);
    // One connection, kept: no side took over from the other afterwards.
    expect([channelOf(low), channelOf(high)]).toEqual([lowChannel, highChannel]);
    expect(low.link.isDataLinkOpen && high.link.isDataLinkOpen).toBe(true);
  }, 120_000);

  it("a dial in from another key than the pinned one leaves the held session as it was", async () => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "iroh", emptyDhtDeliveryState());
    const stays = startApp(world, "stays", made.joiner, { side: made.inviter, name: "goes" }, "iroh", emptyDhtDeliveryState());
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    const held = channelOf(stays);
    // Someone else holding a copy of the invite, with a key of their own, dials the endpoint the record names.
    const stranger = startApp(world, "stranger", { ...made.inviter, seedB64: createIdentity().seedB64 }, { side: made.joiner, name: "stays" }, "iroh", emptyDhtDeliveryState(), true);
    await run(20_000);
    expect(stranger.link.isDataLinkOpen).toBe(false);
    expect(channelOf(stays)).toBe(held);
    expect(goes.link.isDataLinkOpen && stays.link.isDataLinkOpen).toBe(true);
  }, 120_000);
});
