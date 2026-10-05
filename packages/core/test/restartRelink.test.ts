import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink, RACE_DIRECT_MS, UNPROVEN_AUTH_MS } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { DiscoveryBudgetError, type PkarrTransport } from "../src/transport";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, rtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
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

/**
 * `iroh`, `webrtc`: the one transport both apps run. `webrtc+hyperdht`: the CLI's, WebRTC first and HyperDHT (direct)
 * after it. `webrtc+iroh`: WebRTC first and an Iroh reached through its relay (no direct address), ranked last.
 */
type Kind = "iroh" | "webrtc" | "webrtc+hyperdht" | "webrtc+iroh";
interface App {
  name: string; side: Side; link: GhostLink; dhtState: DhtDeliveryState; requests: { at: number }[]; stopped?: Promise<void>;
  /** While set, the relays' request budget holds back every publish of this app (it throws `DiscoveryBudgetError`). */
  heldUntil?: number;
  /** While set, the relays' budget holds back every read of this app: it is answered with the last packet it read. */
  readsHeldUntil?: number;
}

/** The session the staying side holds: a new one (or none) means it let the old one go. */
const channelOf = (app: App) => (app.link as unknown as { channel: unknown }).channel;
const apps: App[] = [];
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

function counted(pkarr: MemoryPkarr, app: App): PkarrTransport {
  const inner = pkarr.transport(), requests = app.requests, lastRead = new Map<string, Awaited<ReturnType<PkarrTransport["resolve"]>>>();
  return {
    publish: async (identity, records) => {
      // Held back: nothing went out, and the caller tries again when the budget frees a request.
      if (app.heldUntil && Date.now() < app.heldUntil) throw new DiscoveryBudgetError(app.heldUntil - Date.now());
      requests.push({ at: Date.now() }); return inner.publish(identity, records);
    },
    resolve: async (key, options) => {
      // Held back: as the relay transport does, what it read last is the answer (`RelayTransport.resolve`).
      if (app.readsHeldUntil && Date.now() < app.readsHeldUntil) return lastRead.get(key) ?? null;
      requests.push({ at: Date.now() });
      const packet = await inner.resolve(key, options);
      lastRead.set(key, packet);
      return packet;
    },
    describe: inner.describe,
  };
}

/**
 * `endpointAfterMs`: the native endpoint starts this long after the link (a Desktop's Iroh can take seconds).
 * `chosen`: the person chose the native transport in the chat's Connection menu, and the chat was live on it.
 */
function startApp(world: { pkarr: MemoryPkarr; native: NativeWorld }, name: string, side: Side, contact: { side: Side; name: string }, kind: Kind, dhtState: DhtDeliveryState, wasLive = false, endpointAfterMs?: number, chosen = false): App {
  const app = { name, side, dhtState, requests: [] } as unknown as App;
  const native = kind === "webrtc" ? undefined : kind === "webrtc+hyperdht" ? "hyperdht/1" as const : "iroh/1" as const;
  const peerNative = native === "hyperdht/1" ? { publicKey: `${contact.name}:hyperdht/1` } : { id: `${contact.name}:iroh/1`, relay: "https://relay.test./", addresses: [] };
  const rtcToo = kind !== "iroh";
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: rtcToo,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: peerKeyOf(contact.side) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: dhtState, save: async state => { app.dhtState = state; } },
    native: native
      ? { peerDescriptors: { [native]: peerNative }, peerTransports: [...(rtcToo ? ["webrtc/1" as const] : []), native], peerFallback: true,
        ...(chosen ? { preferred: native, automatic: false } : { automatic: true }) }
      : { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    // What the app was live on when it quit: WebRTC wherever the app has it (it ranks first).
    ...(wasLive ? { resume: chosen && native ? native : rtcToo ? "webrtc/1" as const : "iroh/1" as const } : {}),
    transport: counted(world.pkarr, app),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  apps.push(app);
  app.link.start();
  app.link.setChatActive(false);
  if (native && endpointAfterMs) setTimeout(() => app.link.registerEndpoint(world.native.endpoint(native, name)), endpointAfterMs);
  else if (native) app.link.registerEndpoint(world.native.endpoint(native, name));
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
 * The app ends:
 * - `graceful`: it says goodbye and has `DEPART_FLUSH_MS` before it exits (a page closing, the CLI's stop, the Desktop
 *   when its exit can wait);
 * - `closed`: it only closes its connections on the way out (the Desktop quit on macOS, which nothing can hold);
 * - `crash`: nothing at all.
 */
type How = "graceful" | "closed" | "crash";
async function quit(world: { native: NativeWorld }, app: App, how: How, rtcFailsAfterMs?: number): Promise<void> {
  if (how === "graceful") { app.link.depart(); await run(DEPART_FLUSH_MS); }
  // Its connections close (each contact hears it), and nothing else of it runs.
  if (how === "closed") { app.stopped = app.link.stop(false); await run(DEPART_FLUSH_MS); }
  world.native.kill(app.name);
  killRtc(app.name, undefined, rtcFailsAfterMs);
  app.stopped ??= app.link.stop(false);
}

const DEPART_FLUSH_MS = 300;
const RESTART_AFTER_MS = 3_000;

interface Result { kind: Kind; restarted: "lower" | "higher"; how: How; downSeenMs: number; liveAgainMs: number; requestsPerMin: number;
  /** The same, each app: the one that restarted, the one that stayed. */
  requestsPerMinEach: [number, number]; dialFailures: number; transport?: string; budgetHeldMs?: number }
function report(result: Result): void {
  const file = process.env.RESTART_REPORT;
  if (file) appendFileSync(file, JSON.stringify(result) + "\n");
}

/**
 * `budgetHeldMs`: from the restart, the relays' budget holds back every publish of the app that stayed for this long.
 * `endpointAfterMs`: the restarted app's native endpoint starts this long after it.
 * `cli`: the staying side's WebRTC never says `disconnected` and goes `failed` `rtcFailsAfterMs` after the crash
 * (node-datachannel), and the restarted app's native dials do not reach it, failing after `dialFailMs`.
 */
async function restart(kind: Kind, restarted: "lower" | "higher", how: How, budgetHeldMs?: number, endpointAfterMs?: number,
  cli?: { rtcFailsAfterMs: number; dialFailMs: number },
  readsHeld?: { afterMs: number; forMs: number; restartedWrites?: { afterMs: number; forMs: number } }): Promise<Result> {
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
  await quit(world, goes, how, cli?.rtcFailsAfterMs);
  if (cli) { world.native.dialsLost.add("goes"); world.native.dialFailMs = cli.dialFailMs; }
  const failuresBefore = world.native.dialFailures;
  // When the staying side lets the old session go (it may only do so once the other app is back).
  let downSeenAt = 0;
  const watch = () => { if (!downSeenAt && channelOf(stays) !== before) downSeenAt = Date.now(); };
  for (let t = 0; t < RESTART_AFTER_MS; t += 100) { await run(100); watch(); }
  const dhtState = goes.dhtState;
  goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, dhtState, true, endpointAfterMs);
  const restartedAt = Date.now();
  if (budgetHeldMs) stays.heldUntil = restartedAt + budgetHeldMs;
  if (readsHeld) setTimeout(() => { stays.readsHeldUntil = Date.now() + readsHeld.forMs; }, readsHeld.afterMs);
  const writes = readsHeld?.restartedWrites;
  if (writes) setTimeout(() => { goes.heldUntil = Date.now() + writes.forMs; }, writes.afterMs);
  const liveAgainMs = await until(() => {
    watch();
    return goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== before;
  }, 5 * 60_000);
  // Requests for discovery (Pkarr reads and publishes) in the two minutes from the restart, per minute, the busier app.
  await run(Math.max(0, restartedAt + 120_000 - Date.now()));
  const inWindow = (app: App) => app.requests.filter(r => r.at >= restartedAt && r.at < restartedAt + 120_000).length / 2;
  const result: Result = { kind, restarted, how, downSeenMs: downSeenAt ? downSeenAt - quitAt : Infinity, liveAgainMs,
    requestsPerMin: Math.max(inWindow(goes), inWindow(stays)), requestsPerMinEach: [inWindow(goes), inWindow(stays)], dialFailures: world.native.dialFailures - failuresBefore,
    transport: (goes.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport, ...(budgetHeldMs ? { budgetHeldMs } : {}) };
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
    it.each(["graceful", "closed", "crash"] as const)("%s: live again within the target, on a small discovery budget", async how => {
      const result = await restart(kind, restarted, how);
      // Before (dev at 57bd8d2e): Iroh 61 s (lower) and 28 s (higher), noticed after 30 s; WebRTC 16-18 s.
      expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(how === "crash" ? 15_000 : 5_000);
      if (how !== "crash") expect(result.downSeenMs, "a goodbye or a close ends the session at once").toBeLessThanOrEqual(1_000);
      // The relays allow 30 requests a minute per client, reads and publishes together, for every chat.
      expect(result.requestsPerMin).toBeLessThanOrEqual(10);
      // Nothing dials an app that is not there: a departing app does not redial, the staying one waits for the other back.
      expect(result.dialFailures).toBe(0);
    }, 240_000);
  });
});

/**
 * The Linux Desktop (no WebRTC, the lower key here) and the web app, a chat live over Iroh between them; both go, the web
 * app is back first and knocks on the Desktop, which is not there yet. The Desktop is back 30 s later and knocks in turn:
 * its connection is accepted, then nothing crosses it (a relay path that died with the handshake). The web app refused
 * it after `UNPROVEN_AUTH_MS`, but the Desktop held it until QUIC's idle timeout, and dialled again only then: live
 * 34.6 s after it started (Omarchy, 2026-10-01, web first).
 */
describe("the web app back first, the Desktop's knock on a path that dies", () => {
  async function webFirst(record?: { afterMs: number }) {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    // An Iroh dial to an endpoint that is not running gives up after 20 s.
    world.native.dialFailMs = 20_000;
    const made = invitationWhere("inviter");
    let desktop = startApp(world, "desktop", made.inviter, { side: made.joiner, name: "web" }, "iroh", emptyDhtDeliveryState());
    let web = startApp(world, "web", made.joiner, { side: made.inviter, name: "desktop" }, "iroh", emptyDhtDeliveryState());
    expect(await until(() => desktop.link.isDataLinkOpen && web.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(10_000);
    await quit(world, web, "graceful");
    await quit(world, desktop, "crash");
    await run(5_000);
    web = startApp(world, "web", made.joiner, { side: made.inviter, name: "desktop" }, "iroh", web.dhtState, true);
    await run(30_000);
    world.native.deadPaths.add("desktop");
    desktop = startApp(world, "desktop", made.inviter, { side: made.joiner, name: "web" }, "iroh", desktop.dhtState, true);
    // The web app's capability record, read a few seconds after the knock went out, says how to dial it now.
    if (record) setTimeout(() => desktop.link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "web:iroh/1", relay: "https://relay2.test./", addresses: [] } }, true), record.afterMs);
    let rejected = false;
    const liveMs = await until(() => {
      rejected ||= (desktop.link as unknown as { securityRejected: boolean }).securityRejected;
      return desktop.link.isDataLinkOpen && web.link.isDataLinkOpen;
    }, 120_000);
    return { liveMs, rejected };
  }

  it("the Desktop gives the knock up as the web app does, and dials again at once", async () => {
    const { liveMs, rejected } = await webFirst();
    // Before: 31.4 s (the knock held until QUIC's idle timeout). After: 15.5 s.
    expect(liveMs, "from the Desktop's start to live on both sides").toBeLessThanOrEqual(UNPROVEN_AUTH_MS + 2_000);
    // A handshake that never finished is no rejection of the contact (which would stop the chat's DHT delivery too).
    expect(rejected).toBe(false);
  }, 240_000);

  it("a newer way to dial the web app, read while the knock still waits, is dialled at once", async () => {
    const { liveMs, rejected } = await webFirst({ afterMs: 9_000 });
    // Before: 31.4 s. After: 9.6 s, dialled as the record is read.
    expect(liveMs, "from the Desktop's start to live on both sides").toBeLessThanOrEqual(11_000);
    expect(rejected).toBe(false);
  }, 240_000);
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

  it("connections dialled in that never authenticate hold no place against the contact coming back", async () => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    let goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "iroh", emptyDhtDeliveryState());
    const stays = startApp(world, "stays", made.joiner, { side: made.inviter, name: "goes" }, "iroh", emptyDhtDeliveryState());
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(5_000);
    await quit(world, goes, "graceful");
    // Someone who reads the endpoint from the record dials it twice and never says a word: one connection takes the
    // session's place, the other the place of the one that would replace it.
    const silent = world.native.endpoint("iroh/1", "silent");
    for (let i = 0; i < 2; i++) { void silent.connect({ id: "stays:iroh/1" }); await run(1_000); }
    expect(stays.link.isDataLinkOpen).toBe(false);
    await run(RESTART_AFTER_MS);
    goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "iroh", goes.dhtState, true);
    // Back within the time a restart takes, not after the three minutes a peer has to finish authenticating.
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 170_000)).toBeLessThanOrEqual(15_000);
  }, 240_000);

  it("a connection dialled in that never authenticates closes soon, and the DHT keeps its pace meanwhile", async () => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "iroh", emptyDhtDeliveryState());
    const stays = startApp(world, "stays", made.joiner, { side: made.inviter, name: "goes" }, "iroh", emptyDhtDeliveryState());
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await quit(world, goes, "graceful");
    await run(1_000);
    const connected = () => (stays.link as unknown as { session: { connected: boolean } }).session.connected;
    expect(connected()).toBe(false);
    const dial = world.native.endpoint("iroh/1", "silent").connect({ id: "stays:iroh/1" });
    await run(1_000);
    const { channel } = await dial;
    expect(channelOf(stays)).toBeTruthy();
    expect(connected()).toBe(false);
    await run(UNPROVEN_AUTH_MS);
    expect((channel as unknown as { closed: boolean }).closed).toBe(true);
    expect(channelOf(stays)).toBeNull();
  }, 120_000);
});

/**
 * The CLI's slow restart (#398's trace, 2026-09-27): Bob is killed and back, and offers over WebRTC at once. Alice reads
 * the offer and answers, but the relays' request budget holds her answer back, and her answering connection gives up
 * (ICE, 31 s) before it goes out. Nothing answers Bob's offer, which ran to its attempt timeout (`CONNECT_TIMEOUT_MS`,
 * 90 s) before the HyperDHT ranked after it was dialled, live 0.1 s later. Measured from the restart; the budget holds
 * the staying app's publishes for 45 s of it.
 */
describe("a CLI back after a kill, whose contact never hears its WebRTC connection go", () => {
  it.each(["lower", "higher"] as const)("the app with the %s key restarts: the contact's unanswered ping reads its offer", async restarted => {
    // CI run 36741701666 (twoPeers, 34.1 s): the staying daemon held the dead session and read the relays at a live
    // chat's 30 s pace; its WebRTC went `failed` 27.1 s after the kill (node-datachannel never says `disconnected`), and
    // only then did it read the restarted daemon's offer. The race's HyperDHT dial had not reached it, and the answer
    // waited 7.5 s more for the restarted side's next look (its offer out over 10 s, looked for every 8 s).
    const result = await restart("webrtc+hyperdht", restarted, "crash", undefined, undefined, { rtcFailsAfterMs: 27_100, dialFailMs: 20_000 });
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(22_000);
    expect(result.transport).toBe("webrtc/1");
    expect(result.requestsPerMin).toBeLessThanOrEqual(10);
  }, 240_000);
});

describe("a restart whose WebRTC answer the relays' budget holds back", () => {
  const BUDGET_HELD_MS = 45_000;
  beforeEach(() => { rtc.answerFailsAfterMs = 31_000; });

  it.each(["lower", "higher"] as const)("the app with the %s key restarts: live again over a direct transport ranked after WebRTC", async restarted => {
    const result = await restart("webrtc+hyperdht", restarted, "crash", BUDGET_HELD_MS);
    // Before (dev at ac2826e3): 90.7 s (lower) and 48.4 s (higher: the staying lower key offered once the budget
    // freed), 19.5 and 18.5 requests a minute. After: 8.7 and 9.0 s, 6.5 a minute; the native dial takes no request.
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(15_000);
    expect(result.transport).toBe("hyperdht/1");
    expect(result.requestsPerMin).toBeLessThanOrEqual(10);
    expect(result.dialFailures).toBe(0);
  }, 240_000);

  it("a native endpoint still starting when the offer has waited its grace is dialled once it is up", async () => {
    const result = await restart("webrtc+hyperdht", "lower", "crash", BUDGET_HELD_MS, 12_000);
    // Before: 96.1 s; the attempt ranked only what was up when it dialled, so the offer waited out its 90 s alone. After:
    // 12.7 s, dialled as it starts. (One due in the race but not dialable yet is looked at again, never dropped.)
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(15_000);
    expect(result.transport).toBe("hyperdht/1");
    expect(result.dialFailures).toBe(0);
  }, 240_000);

  it("two apps that restart together with HyperDHT chosen are live on it soon after the contact's endpoint is up", async () => {
    // Found with two headless CLIs (bug hunt r3a): both chose HyperDHT and restarted together. The lower key knocked on
    // HyperDHT first, as its choice, while the other's endpoint was still starting (PEER_NOT_FOUND); then it offered
    // WebRTC, and the HyperDHT that failed first was never dialled again in that attempt: live after the other app read
    // the offer (30 s) or after the offer's attempt timeout (90 s).
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    // A HyperDHT lookup for an endpoint not announced yet answers PEER_NOT_FOUND in about a second and a half.
    world.native.dialFailMs = 1_500;
    const made = invitationWhere("inviter");
    const low = startApp(world, "low", made.inviter, { side: made.joiner, name: "high" }, "webrtc+hyperdht", emptyDhtDeliveryState(), true, undefined, true);
    // The app that stopped second heard the other go: it was not live when it quit, and does not knock.
    const high = startApp(world, "high", made.joiner, { side: made.inviter, name: "low" }, "webrtc+hyperdht", emptyDhtDeliveryState(), false, 6_000, true);
    high.heldUntil = Date.now() + BUDGET_HELD_MS;
    const liveMs = await until(() => low.link.isDataLinkOpen && high.link.isDataLinkOpen, 150_000);
    expect(liveMs, "from the restart to live on both sides").toBeLessThanOrEqual(15_000);
    expect((low.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport).toBe("hyperdht/1");
  }, 240_000);

  it("a relayed transport ranked after WebRTC waits for a contact reading in the background first", async () => {
    const result = await restart("webrtc+iroh", "lower", "crash", BUDGET_HELD_MS);
    // Before: 90.7 s, 19.5 requests a minute. After: 40.6 s, 15.5: an offer out reads the relays fast until it ends,
    // now at 40 s rather than 90 s.
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(45_000);
    expect(result.transport).toBe("iroh/1");
    expect(result.requestsPerMin).toBeLessThanOrEqual(16);
    expect(result.dialFailures).toBe(0);
  }, 240_000);
});

/**
 * A community's hub (the lower key here, the side that dials) offers to a member back after a restart, and the member
 * answers within a second; the hub's reads then wait for its relays' budget (a restart of the member a minute before
 * spent it) and return the packet read before. The member's ICE gives up on its answer after 31 s. The member used to
 * go idle with the hub's offer answered once and never again: the edge waited for the hub's 90 s attempt, then for a
 * background read, 110 s in all (CLI, 2026-09-30).
 */
describe("a restart whose answer the staying side cannot read for its relays' budget", () => {
  beforeEach(() => { rtc.answerFailsAfterMs = 31_000; });

  it("the restarted app answers the standing offer again, and is live once the reads are back", async () => {
    const HELD_MS = 40_000;
    const result = await restart("webrtc", "higher", "graceful", undefined, undefined, undefined, { afterMs: 2_500, forMs: HELD_MS });
    // Before: 107.1 s, 21 requests a minute (the restarted app). After: 44.3 s, 19 a minute: one answer more, and its
    // fast looks for the offerer's side.
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(2_500 + HELD_MS + 10_000);
    expect(result.requestsPerMin).toBeLessThanOrEqual(20);
  }, 240_000);

  it("the answer made again waits for the restarted app's budget too: the staying side drops the stale answer it read for the new one", async () => {
    // The staying side reads the restarted app's first answer at 47.5 s, long dead; the answer made again at 34 s goes
    // out only at 55 s. Before: that dead answer was held to the end of its 90 s attempt, and the edge redialled then
    // (107.1 s). After: 61.4 s, the stale answer dropped as the new one is read and the edge dialled again at once.
    const result = await restart("webrtc", "higher", "graceful", undefined, undefined, undefined,
      { afterMs: 2_500, forMs: 45_000, restartedWrites: { afterMs: 30_000, forMs: 25_000 } });
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(75_000);
  }, 240_000);
});

/**
 * An app back after a while away (its contact's app ran on, the chat not on its screen): the contact reads at the
 * background pace (30 s on the relays), and the WebRTC offer of the app that is back waits up to that long for its
 * answer. The headless CLI, away 5 minutes: live again 8.1 s after it started (2.4-8.5 s, n=8), on the HyperDHT that the
 * race dialled at `RACE_DIRECT_MS` and that connected in 10 ms (2026-10-05).
 */
describe("back after a while away, to a contact reading in the background", () => {
  async function awayAndBack(lost = false) {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    // The lower key goes: back, it is the side that dials anyway.
    let goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "webrtc+hyperdht", emptyDhtDeliveryState());
    const stays = startApp(world, "stays", made.joiner, { side: made.inviter, name: "goes" }, "webrtc+hyperdht", emptyDhtDeliveryState());
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    await quit(world, goes, "graceful");
    // Away 5 minutes and a bit: the contact's next read at the background pace is half a minute off.
    await run(5 * 60_000 + 3_700);
    if (lost) world.native.dialsLost.add("goes");
    goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "webrtc+hyperdht", goes.dhtState, true);
    const back = Date.now(), requests = goes.requests.length + stays.requests.length;
    const liveMs = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000);
    return { goes, liveMs, requests: goes.requests.length + stays.requests.length - requests, back,
      transport: (goes.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport };
  }

  it("knocks on the contact's direct transport as its offer goes out, and is live at once", async () => {
    const { liveMs, transport, requests } = await awayAndBack();
    // Before: 8.7 s, the race's HyperDHT dial at `RACE_DIRECT_MS` (n=8, the contact's chat in the background or not).
    // After: 0.7 s.
    expect(liveMs, "from the start of the app that is back to live on both sides").toBeLessThan(RACE_DIRECT_MS / 4);
    expect(transport).toBe("hyperdht/1");
    // No fast looks for an answer meanwhile: fewer requests to the relays, not more (before: 8).
    expect(requests).toBeLessThanOrEqual(8);
  }, 240_000);

  it("a knock that does not reach the contact counts as no failure, and the race still dials", async () => {
    const { goes } = await awayAndBack(true);
    await run(RACE_DIRECT_MS);
    // The knock as the offer went out, then the race's dial `RACE_DIRECT_MS` after: only the race's counts.
    expect((goes.link as unknown as { nativeFailures: Map<string, number> }).nativeFailures.get("hyperdht/1")).toBe(1);
  }, 240_000);
});

