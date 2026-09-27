import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PkarrTransport } from "../src/transport";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

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
    ...(wasLive ? { resume: true } : {}),
    transport: counted(world.pkarr, app.requests),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  } as ConstructorParameters<typeof GhostLink>[0]);
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

/** The app ends: gracefully (whatever it says on its way out), or not at all (a crash, a kill). */
function quit(world: { native: NativeWorld }, app: App, how: "graceful" | "crash"): void {
  if (how === "graceful") (app.link as unknown as { depart?(): void }).depart?.();
  world.native.kill(app.name);
  killRtc(app.name);
  app.stopped = app.link.stop(false);
}

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
  quit(world, goes, how);
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

beforeEach(useFakeWorld);
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map(app => app.stopped ?? app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

describe.each(["iroh", "webrtc"] as const)("a paired chat over %s after one app restarts", kind => {
  describe.each(["lower", "higher"] as const)("the app with the %s key restarts", restarted => {
    it.each(["graceful", "crash"] as const)("%s", async how => {
      const result = await restart(kind, restarted, how);
      expect(result.liveAgainMs).toBeLessThan(Infinity);
    }, 240_000);
  });
});
