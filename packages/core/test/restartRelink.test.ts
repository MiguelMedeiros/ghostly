import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatFiles, type FileTransferRecord } from "../src/chatFiles";
import { CROSSED_WAIT_MS, GhostLink, RACE_DIRECT_MS, UNPROVEN_AUTH_MS } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { DAEMON_WATCH_PEER_IDLE_MS, RELAY_POLL_INTERVALS } from "../src/link";
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
 * after it. `webrtc+iroh`: WebRTC first and an Iroh reached through its relay (no direct address), ranked last, as
 * Automatic ranked them before WISP 100 revision 2026-11-08 and as a chat whose person chose WebRTC still does.
 * `auto+iroh`: the same transports on Automatic, which puts Iroh first, through its relay too.
 */
type Kind = "iroh" | "webrtc" | "webrtc+hyperdht" | "webrtc+iroh" | "auto+iroh";
interface App {
  name: string; side: Side; link: GhostLink; dhtState: DhtDeliveryState; requests: { at: number; read?: string }[]; stopped?: Promise<void>;
  /** While set, the relays' request budget holds back every publish of this app (it throws `DiscoveryBudgetError`). */
  heldUntil?: number;
  /** While set, the relays' budget holds back every read of this app: it is answered with the last packet it read. */
  readsHeldUntil?: number;
  /** While set, this app has no network: every publish and read fails. */
  offline?: boolean;
}

/** The session the staying side holds: a new one (or none) means it let the old one go. */
const channelOf = (app: App) => (app.link as unknown as { channel: unknown }).channel;
const apps: App[] = [];
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

function counted(pkarr: MemoryPkarr, app: App): PkarrTransport {
  const inner = pkarr.transport(), requests = app.requests, lastRead = new Map<string, Awaited<ReturnType<PkarrTransport["resolve"]>>>();
  return {
    publish: async (identity, records) => {
      if (app.offline) throw new Error("offline");
      // Held back: nothing went out, and the caller tries again when the budget frees a request.
      if (app.heldUntil && Date.now() < app.heldUntil) throw new DiscoveryBudgetError(app.heldUntil - Date.now());
      requests.push({ at: Date.now() }); return inner.publish(identity, records);
    },
    resolve: async (key, options) => {
      if (app.offline) throw new Error("offline");
      // Held back: as the relay transport does, what it read last is the answer (`RelayTransport.resolve`).
      if (app.readsHeldUntil && Date.now() < app.readsHeldUntil) return lastRead.get(key) ?? null;
      requests.push({ at: Date.now(), read: key });
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
function startApp(world: { pkarr: MemoryPkarr; native: NativeWorld }, name: string, side: Side, contact: { side: Side; name: string }, kind: Kind, dhtState: DhtDeliveryState, wasLive = false, endpointAfterMs?: number, chosen = false,
  /** `upgrade/1`: this app's, and the contact's as its capability record says. */
  upgrade: { mine?: boolean; contact?: boolean } = {},
  /** More of the link's options (a CLI daemon's `watchPeerIdleMs`). */
  more: Partial<ConstructorParameters<typeof GhostLink>[0]> = {}): App {
  const app = { name, side, dhtState, requests: [] } as unknown as App;
  const native = kind === "webrtc" ? undefined : kind === "webrtc+hyperdht" ? "hyperdht/1" as const : "iroh/1" as const;
  const peerNative = native === "hyperdht/1" ? { publicKey: world.native.key("hyperdht/1", contact.name) } : { id: world.native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] };
  const rtcToo = kind !== "iroh";
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: rtcToo,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: peerKeyOf(contact.side) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: dhtState, save: async state => { app.dhtState = state; } },
    native: native
      ? { peerDescriptors: { [native]: peerNative }, peerTransports: [...(rtcToo ? ["webrtc/1" as const] : []), native], peerFallback: true,
        ...(chosen ? { preferred: native, automatic: false } : kind === "webrtc+iroh" ? { preferred: "webrtc/1" as const, automatic: false } : { automatic: true }) }
      : { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    // What the app was live on when it quit: WebRTC wherever the app has it (it ranked first; on `auto+iroh`, a chat
    // live on WebRTC from before Automatic put Iroh first).
    ...(wasLive ? { resume: chosen && native ? native : rtcToo ? "webrtc/1" as const : "iroh/1" as const } : {}),
    transport: counted(world.pkarr, app),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    ...(upgrade.mine ? { upgradeSupport: true, peerUpgrades: () => !!upgrade.contact } : {}),
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    ...more,
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
 * (node-datachannel), and the restarted app's native dials do not reach it, failing after `dialFailMs` (when given).
 * `restartAfterMs`: how long the app is gone.
 */
async function restart(kind: Kind, restarted: "lower" | "higher", how: How, budgetHeldMs?: number, endpointAfterMs?: number,
  cli?: { rtcFailsAfterMs: number; dialFailMs?: number },
  readsHeld?: { afterMs: number; forMs: number; restartedWrites?: { afterMs: number; forMs: number } }, restartAfterMs = RESTART_AFTER_MS): Promise<Result> {
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
  if (cli?.dialFailMs !== undefined) { world.native.dialsLost.add("goes"); world.native.dialFailMs = cli.dialFailMs; }
  const failuresBefore = world.native.dialFailures;
  // When the staying side lets the old session go (it may only do so once the other app is back).
  let downSeenAt = 0;
  const watch = () => { if (!downSeenAt && channelOf(stays) !== before) downSeenAt = Date.now(); };
  for (let t = 0; t < restartAfterMs; t += 100) { await run(100); watch(); }
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
 * Automatic puts Iroh first, through its relay too (WISP 100, revision 2026-11-08). A chat on it that was live on
 * WebRTC when the app quit (from before the rule) resumes on Iroh. (These apps do not list `upgrade/1`, so nothing then
 * moves the session to WebRTC; the wake tests below have it.)
 */
describe("a chat on Automatic, both apps with WebRTC and an Iroh through its relay, after one app restarts", () => {
  it.each([
    { restarted: "lower", how: "graceful" }, { restarted: "higher", how: "graceful" },
    { restarted: "lower", how: "crash" }, { restarted: "higher", how: "crash" },
  ] as const)("the app with the $restarted key, $how: live again on Iroh within the target", async ({ restarted, how }) => {
    const result = await restart("auto+iroh", restarted, how);
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(how === "crash" ? 15_000 : 5_000);
    expect(result.transport).toBe("iroh/1");
    expect(result.requestsPerMin).toBeLessThanOrEqual(10);
  }, 240_000);

  /**
   * The app's Iroh endpoint is up a moment after its first dial (the CLI's 0.3 s after it, two daemons on loopback): that
   * dial found no Iroh and offered WebRTC to a contact still holding the dead session, which reads no offer meanwhile.
   * The lower key dials again once its endpoints are up (node.ts); the higher key waited for the contact to notice: live
   * again 13.6 s after a kill (two CLI daemons with WebRTC and Iroh only, 2026-11-12), 8.5 s with HyperDHT raced at 8 s.
   */
  it.each(["lower", "higher"] as const)("the app with the %s key crashes and its Iroh is up after its first dial: it resumes on Iroh once it is up", async restarted => {
    const result = await restart("auto+iroh", restarted, "crash", undefined, 300);
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(2_000);
    expect(result.transport).toBe("iroh/1");
  }, 240_000);

  /**
   * The same with no Iroh to go on (its relay out of reach): the CLI's HyperDHT endpoint is up 0.1 s after the first dial,
   * which offered WebRTC to a contact holding the dead session. The higher key waited for the race: live again 8.5 s after
   * a kill (two CLI daemons, Iroh relay down, 2026-11-13), against 0.9 s for the lower key.
   */
  it.each(["lower", "higher"] as const)("the app with the %s key crashes and its HyperDHT is up after its first dial: it resumes on HyperDHT once it is up", async restarted => {
    const result = await restart("webrtc+hyperdht", restarted, "crash", undefined, 300, { rtcFailsAfterMs: 27_100 });
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(2_000);
    expect(result.transport).toBe("hyperdht/1");
  }, 240_000);
});

/**
 * A tab that crashed is opened again by hand, or by a busy machine: seconds later, once the contact's connection already
 * went `disconnected` (5 s here, 7.6 s in Chromium). The contact read the packet once as it did, found no offer yet, and
 * read again only when the connection's grace ran out, 12 s later: two pages were live 11 s after the reload (19.9 s
 * after the crash), past the 15 s e2e/web/restart-relink.spec.ts allows whenever the reload was that slow.
 */
describe("a WebRTC chat whose crashed app is back after the contact's connection went disconnected", () => {
  it.each(["lower", "higher"] as const)("the app with the %s key: its offer is read while the connection stays so, not when its grace runs out", async restarted => {
    const result = await restart("webrtc", restarted, "crash", undefined, undefined, undefined, undefined, 6_000);
    // Before: 9.3 s (lower) and 9.6 s (higher), the rest of the grace; 3.3 s and 3.6 s now.
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(5_000);
    expect(result.requestsPerMin).toBeLessThanOrEqual(10);
    expect(result.dialFailures).toBe(0);
  }, 240_000);
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
    if (record) setTimeout(() => desktop.link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: world.native.key("iroh/1", "web"), relay: "https://relay2.test./", addresses: [] } }, true), record.afterMs);
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

  /**
   * The lower key's app is back after a restart and its knock carries the chat again; seconds later the contact's app
   * crashes and is back too, and knocks in turn. The lower key took that knock for one crossing its own (its session
   * was under `CROSSED_FRESH_MS` old) and refused it, so the contact waited for the dead session's end: live again
   * 16.6-18.9 s after the contact's start, 5 of 5, against 0.5 s with the crash 13 s after the knock (CLI daemons over
   * HyperDHT on a loopback testnet, 2026-10-13).
   */
  it("the contact crashes seconds after the lower key's knock, and its own knock carries the chat", async () => {
    const kind = "iroh";
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [lowSide, highSide] = [made.inviter, made.joiner];
    let low = startApp(world, "low", lowSide, { side: highSide, name: "high" }, kind, emptyDhtDeliveryState());
    let high = startApp(world, "high", highSide, { side: lowSide, name: "low" }, kind, emptyDhtDeliveryState());
    expect(await until(() => low.link.isDataLinkOpen && high.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    await quit(world, low, "crash");
    await run(1_000);
    low = startApp(world, "low", lowSide, { side: highSide, name: "high" }, kind, low.dhtState, true);
    expect(await until(() => low.link.isDataLinkOpen && high.link.isDataLinkOpen && channelOf(high) !== null, 30_000), "the lower key's knock").toBeLessThanOrEqual(5_000);
    await run(2_000);
    const held = channelOf(low);
    await quit(world, high, "crash");
    await run(500);
    high = startApp(world, "high", highSide, { side: lowSide, name: "low" }, kind, high.dhtState, true);
    const liveMs = await until(() => low.link.isDataLinkOpen && high.link.isDataLinkOpen && channelOf(low) !== held, 120_000);
    // Before: 30 s and more (the dead session's idle timeout). After: the contact's knock, a round trip and a ping's wait.
    expect(liveMs, "from the contact's start to live on both sides").toBeLessThanOrEqual(5_000);
  }, 240_000);

  /**
   * The chat is live over Iroh, chosen in its Connection menu, and one app crashes. It is back with no Iroh of its own
   * (its relay out of reach, its listener not up yet) and dials WebRTC, the fallback. The staying side, its dead Iroh
   * session still held, closed that WebRTC connection as soon as it opened: the restarted app counted a failed dial and
   * waited its backoff, live again 52.8 s after its start (CLI daemons, local Iroh relay stopped, bug hunt 2026-10-17).
   */
  it.each(["lower", "higher"] as const)("back with no Iroh after a crash over chosen Iroh, the %s key's WebRTC dial carries the chat", async restarted => {
    const kind = "webrtc+iroh";
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = restarted === "lower" ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    let goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, emptyDhtDeliveryState(), false, undefined, true);
    const stays = startApp(world, "stays", staysSide, { side: goesSide, name: "goes" }, kind, emptyDhtDeliveryState(), false, undefined, true);
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== null, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    expect((stays.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport).toBe("iroh/1");
    const held = channelOf(stays);
    await quit(world, goes, "crash");
    await run(2_000);
    // Its Iroh endpoint does not come up in this test's time.
    goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, goes.dhtState, true, 10 * 60_000, true);
    const liveMs = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== held, 120_000);
    // Before: the dead session's idle timeout (30 s), then the restarted app's backoff. After: its WebRTC dial and a ping's wait.
    expect(liveMs, "from the restart to live on both sides").toBeLessThanOrEqual(20_000);
  }, 240_000);

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

/**
 * A chat live on HyperDHT, one app killed and back 3 s later. The contact still holds the dead session, and HyperDHT
 * announces no listener of a chat live on it (endpoint.mjs): the restarted app's resume knock finds nothing
 * (PEER_NOT_FOUND). The lower key then dialled as any attempt, and the app's Iroh, up a moment later, took the held
 * session over. The higher key took that knock for the resume's one dial whatever the key and waited for the contact
 * to notice: live again 14.5-15.2 s after the start between two CLI daemons on a loopback HyperDHT (2026-11-12), against
 * 0.8-1.6 s with the lower key. Its dial after the knock then offered WebRTC, which the contact reads at a live chat's
 * pace, and the Iroh that joined it waited for the race. Here 27.7 s with the higher key before, 17.2 s with the lower.
 */
describe("a CLI back after a kill on HyperDHT, whose contact holds the session with its listener unannounced", () => {
  // Its Iroh up after the dial's offer went out (0.2-0.6 s after its HyperDHT on the CLI), or before that dial.
  it.each([["lower", 800], ["higher", 800], ["higher", 100]] as const)("the app with the %s key restarts, its Iroh up %i ms after its start: it dials once its knock found nothing, and knocks on Iroh", async (restarted, irohAfterMs) => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    world.native.unannouncedWhileLive = true;
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = restarted === "lower" ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    // The CLI's: WebRTC, HyperDHT (chosen here, so the chat is live on it) and an Iroh through its relay.
    const both = (contact: string) => ({ native: {
      peerDescriptors: { "hyperdht/1": { publicKey: world.native.key("hyperdht/1", contact) }, "iroh/1": { id: world.native.key("iroh/1", contact), relay: "https://relay.test./", addresses: [] } },
      peerTransports: ["webrtc/1" as const, "hyperdht/1" as const, "iroh/1" as const], peerFallback: true, preferred: "hyperdht/1" as const, automatic: false } });
    const start = (name: "goes" | "stays", side: Side, contact: { side: Side; name: string }, dhtState: DhtDeliveryState, wasLive: boolean) => {
      const app = startApp(world, name, side, contact, "webrtc+hyperdht", dhtState, wasLive, undefined, true, {}, both(contact.name));
      setTimeout(() => app.link.registerEndpoint(world.native.endpoint("iroh/1", name)), irohAfterMs);
      return app;
    };
    let goes = start("goes", goesSide, { side: staysSide, name: "stays" }, emptyDhtDeliveryState(), false);
    const stays = start("stays", staysSide, { side: goesSide, name: "goes" }, emptyDhtDeliveryState(), false);
    const transportOf = (app: App) => (app.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport;
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && transportOf(stays) === "hyperdht/1", 120_000), "live on HyperDHT at first").toBeLessThan(Infinity);
    await run(20_000);
    const before = channelOf(stays);
    await quit(world, goes, "crash");
    await run(RESTART_AFTER_MS);
    goes = start("goes", goesSide, { side: staysSide, name: "stays" }, goes.dhtState, true);
    const liveAgainMs = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== before, 120_000);
    expect(liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(2_000);
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

  it("on Automatic, Iroh through its relay goes first: the answer held back holds nothing back", async () => {
    const result = await restart("auto+iroh", "lower", "crash", BUDGET_HELD_MS);
    // WebRTC first with a relayed Iroh ranked after it (the rule before WISP 100 revision 2026-11-08): 90.7 s before
    // revision 0.7, 40.6 s after it (the relayed Iroh raced 40 s after the offer), 15.5 requests a minute.
    expect(result.liveAgainMs, "from the restart to live on both sides").toBeLessThanOrEqual(15_000);
    expect(result.transport).toBe("iroh/1");
    expect(result.requestsPerMin).toBeLessThanOrEqual(10);
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
  /**
   * `cli`: as the headless CLI comes back, its HyperDHT endpoint up a moment after the dial began and its offer's STUN
   * answer in 70 ms: the transport joins the race while the dial is still under way.
   */
  async function awayAndBack({ lost = false, cli = false } = {}) {
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
    if (cli) rtc.srflxAfterMs = 70;
    goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, "webrtc+hyperdht", goes.dhtState, true, cli ? 30 : undefined);
    const back = Date.now(), requests = goes.requests.length + stays.requests.length;
    const liveMs = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000);
    return { goes, liveMs, requests: goes.requests.length + stays.requests.length - requests, back,
      transport: (goes.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport };
  }

  it.each([false, true])("knocks on the contact's direct transport as its offer goes out, and is live at once (CLI start: %s)", async cli => {
    const { liveMs, transport, requests } = await awayAndBack({ cli });
    // Before: 8.7 s, the race's HyperDHT dial at `RACE_DIRECT_MS` (n=8, the contact's chat in the background or not).
    // After: 0.7 s.
    expect(liveMs, "from the start of the app that is back to live on both sides").toBeLessThan(RACE_DIRECT_MS / 4);
    expect(transport).toBe("hyperdht/1");
    // No fast looks for an answer meanwhile: fewer requests to the relays, not more (before: 8).
    expect(requests).toBeLessThanOrEqual(8);
  }, 240_000);

  it("a knock that does not reach the contact counts as no failure, and the race still dials", async () => {
    const { goes } = await awayAndBack({ lost: true });
    await run(RACE_DIRECT_MS);
    // The knock as the offer went out, then the race's dial `RACE_DIRECT_MS` after: only the race's counts.
    expect((goes.link as unknown as { nativeFailures: Map<string, number> }).nativeFailures.get("hyperdht/1")).toBe(1);
  }, 240_000);
});

/**
 * Two web apps: WebRTC, and Iroh through its relay (a browser's Iroh has no direct address). The lower key's app comes back
 * after 5 minutes away to a contact whose chat is in the background (it reads every 30 s): its offer waits for that read,
 * and the relayed Iroh is dialled only 40 s on (`RACE_RELAYED_MS`). Measured in this world: live again 17.5 s after the
 * return (median, 3.3 to 35.6 s, n=8). Where both apps say `upgrade/1`, the relay is knocked on at once and the session
 * moves to WebRTC on itself a moment later (WISP 100 § Back to a quiet contact).
 */
describe("back after a while away over a relay at once, then to WebRTC on the session", () => {
  const transportOf = (app: App) => (app.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport;
  /**
   * `higher`: the app that goes has the higher key. The one that stays dials it meanwhile, its offer standing for its
   * attempt (90 s) once it is due again, and the app back answers it.
   */
  async function awayAndBack(upgrade: { goes: boolean; stays: boolean }, { higher = false, kind = "webrtc+iroh" as Kind, awayMs = 5 * 60_000 + 3_700, endpointAfterMs = undefined as number | undefined, dialOnEndpoint = false } = {}) {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = higher ? [made.joiner, made.inviter] : [made.inviter, made.joiner];
    const up = (mine: boolean, contact: boolean) => ({ mine, contact });
    let goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, emptyDhtDeliveryState(), false, undefined, false, up(upgrade.goes, upgrade.stays));
    const stays = startApp(world, "stays", staysSide, { side: goesSide, name: "goes" }, kind, emptyDhtDeliveryState(), false, undefined, false, up(upgrade.stays, upgrade.goes));
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    expect(transportOf(goes)).toBe("webrtc/1");
    await quit(world, goes, "graceful");
    await run(awayMs);
    goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, kind, goes.dhtState, true, endpointAfterMs, false, up(upgrade.goes, upgrade.stays));
    const back = goes;
    if (endpointAfterMs !== undefined && dialOnEndpoint) setTimeout(() => void back.link.connect().catch(() => {}), endpointAfterMs);
    const requests = () => goes.requests.length + stays.requests.length;
    const before = requests();
    // The packets that carry a WebRTC signal from here on (an offer or an answer put on the relays).
    const signalled: number[] = [];
    const traceFile = process.env.RESTART_TRACE;
    setLinkTraceSink(line => {
      if (traceFile) appendFileSync(traceFile, line + "\n");
      const step = JSON.parse(line) as { step: string; rtc?: boolean; t: number }; if (step.step === "publish" && step.rtc) signalled.push(step.t);
    });
    const liveMs = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000);
    const firstOn = transportOf(goes), liveAt = Date.now(), atLive = requests();
    const directMs = kind === "webrtc+iroh" ? await until(() => transportOf(goes) === "webrtc/1" && transportOf(stays) === "webrtc/1", 60_000) : 0;
    setLinkTraceSink(traceFile ? line => appendFileSync(traceFile, line + "\n") : null);
    return { goes, stays, liveMs, firstOn, directMs, requestsToLive: atLive - before, requestsToDirect: requests() - atLive,
      signalsToDirect: signalled.filter(t => t > liveAt).length };
  }

  it("both apps move: live over the relay at once, then on WebRTC, with no request to the relays for the move", async () => {
    const { liveMs, firstOn, directMs, signalsToDirect, requestsToLive } = await awayAndBack({ goes: true, stays: true });
    // Before: 27.6 s, over WebRTC once the contact read the offer. After: 0.6 s over the relayed Iroh, WebRTC 0.9 s later.
    expect(liveMs, "from the return to live on both sides").toBeLessThan(2_000);
    expect(firstOn).toBe("iroh/1");
    expect(directMs, "then to WebRTC, on the session").toBeLessThan(3_000);
    expect(signalsToDirect, "the move's offer and answer go on the session, not on the relays").toBe(0);
    // Before: 8 requests from the return to live.
    expect(requestsToLive).toBeLessThanOrEqual(8);
  }, 240_000);

  it.each(["webrtc+iroh", "webrtc+hyperdht"] as const)("back with the higher key, it answers the contact's standing offer and knocks too (%s)", async kind => {
    // Away a little longer: the contact's offer is near the end of its attempt as the app comes back.
    const { liveMs, firstOn } = await awayAndBack({ goes: true, stays: true }, { higher: true, kind, awayMs: 5 * 60_000 + 7 * 3_700 });
    // Before: 5.7 s (WebRTC: the contact looked for the answer only every 8 s, its offer out a while). After: 1.0 s, over
    // the knocked transport. Over 8 returns 3.7 s apart: 4.05 s median (1.4-7.3) before, 1.0 / 1.3 s (1.0-3.6) after.
    expect(liveMs, "from the return to live on both sides").toBeLessThan(2_000);
    expect(firstOn).toBe(kind === "webrtc+iroh" ? "iroh/1" : "hyperdht/1");
  }, 240_000);

  it("the app's Iroh endpoint comes up after its offer is out, and it dials again then (node.ts): it still knocks", async () => {
    // A browser's Iroh starts in some 300 ms, after an offer gathered in 0.2 s, and the engine dials once its native
    // endpoints are up. That second dial made the offer's record anew, without its resume: no knock (e2e, 1 run in 4).
    rtc.srflxAfterMs = 50;
    const { liveMs, firstOn } = await awayAndBack({ goes: true, stays: true }, { endpointAfterMs: 500, dialOnEndpoint: true });
    expect(liveMs).toBeLessThan(2_000);
    expect(firstOn).toBe("iroh/1");
  }, 240_000);

  it("a contact whose app does not move off a relay: the offer waits, as before, and nothing is said of a move", async () => {
    const { goes, liveMs, firstOn } = await awayAndBack({ goes: true, stays: false });
    expect(liveMs).toBeGreaterThan(10_000);
    expect(firstOn).toBe("webrtc/1");
    expect(goes.link.liveAttempt).toBeUndefined();
  }, 240_000);
});


/**
 * A phone puts the web app to sleep in the background (iOS suspends an installed web app): its session dies with nothing
 * said, and the app is not restarted, only back in front (`wake`). The contact is the CLI, its chat not on screen (it
 * reads every 30 s on the relays). Before: the app back waited for that read, of its fresh packet or of its offer, and
 * was live 10 to 30 s after coming back (Miguel's iPhone and the coordinator's CLI, 2026-10-06: "always 30 seconds").
 * Now a wake that finds the session gone resumes as a restart does: it dials whatever its key and knocks on the
 * contact's Iroh relay at once (`upgrade/1`), then moves to WebRTC on the session.
 */
describe("back from the background (a phone that slept), the contact's chat not on screen", () => {
  const transportOf = (app: App) => (app.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport;
  /**
   * `frozen`: the app's timers stop while it sleeps (iOS suspends the page), so it holds its session to the end, and the
   * close is heard just before the wake, as it is in WebKit and Chromium a few ms after the page runs again.
   * `afterAttempt`: the app wakes 1.4 s after an attempt of the CLI's (its offer to the sleeping app) ended unanswered,
   * so the CLI's newest packet is fresh, though it reads at its slow pace (the lab, 2026-10-07: 18 to 36 s).
   * `times`: the app sleeps and wakes this many times, the same link throughout (the lab: only the first was fast).
   * The numbers are the last return's.
   */
  async function sleepAndWake({ higher, awayMs, frozen = false, afterAttempt = false, duringAttemptMs = 0, times = 1, relayBackMs, dialFailMs, kind = "webrtc+iroh" }: { higher: boolean; awayMs: number; frozen?: boolean; afterAttempt?: boolean; duringAttemptMs?: number; times?: number;
    /** The app's Iroh is off its relay at the wake, and back on it this long after (`NativeWorld.offRelay`). */
    relayBackMs?: number;
    /** A dial that reaches nobody fails this long after it began (Iroh's: 20 s). */
    dialFailMs?: number;
    /** `auto+iroh`: both on Automatic, which dials Iroh first. */
    kind?: "webrtc+iroh" | "auto+iroh" }) {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    if (dialFailMs) world.native.dialFailMs = dialFailMs;
    const made = invitationWhere("inviter");
    const [phoneSide, cliSide] = higher ? [made.joiner, made.inviter] : [made.inviter, made.joiner];
    const up = { mine: true, contact: true };
    const phone = startApp(world, "phone", phoneSide, { side: cliSide, name: "cli" }, kind, emptyDhtDeliveryState(), false, undefined, false, up);
    const cli = startApp(world, "cli", cliSide, { side: phoneSide, name: "phone" }, kind, emptyDhtDeliveryState(), false, undefined, false, up);
    expect(await until(() => phone.link.isDataLinkOpen && cli.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    expect(transportOf(phone)).toBe("webrtc/1");
    let result = { liveMs: Infinity, firstOn: undefined as string | undefined, directMs: Infinity, requestsToLive: 0 };
    for (let time = 0; time < times; time++) {
      if (time) { await run(20_000); rtc.srflxAfterMs = undefined; expect(transportOf(phone)).toBe("webrtc/1"); }
      // Asleep: no network, nothing reaches it, and its WebRTC connection dies unheard (the CLI's fails 20 s on).
      phone.offline = true; world.native.asleep.add("phone"); world.native.dialsLost.add("phone");
      const dead = killRtc("phone", undefined, 20_000);
      const inner = phone.link as unknown as { livenessTimer: ReturnType<typeof setInterval> | null };
      if (frozen && inner.livenessTimer) { clearInterval(inner.livenessTimer); inner.livenessTimer = null; }
      await run(awayMs);
      const state = () => (cli.link as unknown as { dataLink: { state: string } }).dataLink.state;
      if (duringAttemptMs) {
        await until(() => state() === "idle", 4 * 60_000);
        await until(() => state() === "offering", 4 * 60_000);
        await run(duringAttemptMs);
        expect(state(), "the CLI's offer stands at the wake").toBe("offering");
        // The wake's read of the CLI's record brings that offer before the app's own has gathered.
        rtc.srflxAfterMs = 450;
      }
      if (afterAttempt) {
        await until(() => state() === "offering", 4 * 60_000);
        await until(() => state() === "idle", 4 * 60_000);
        await run(1_400);
        // A browser's offer gathers in 0.2 to 0.5 s: the wake's read of the CLI's record is back before it goes out.
        rtc.srflxAfterMs = 450;
      }
      phone.offline = false; world.native.asleep.delete("phone"); world.native.dialsLost.delete("phone");
      if (relayBackMs !== undefined) { world.native.offRelay.add("phone"); setTimeout(() => world.native.relayBack("phone"), relayBackMs); }
      if (frozen) for (const channel of dead) channel.dispatchEvent(new Event("close"));
      const requests = () => phone.requests.length + cli.requests.length, before = requests();
      phone.link.wake();
      const liveMs = await until(() => phone.link.isDataLinkOpen && cli.link.isDataLinkOpen && !!transportOf(cli), 120_000);
      const firstOn = transportOf(phone), requestsToLive = requests() - before;
      const directMs = await until(() => transportOf(phone) === "webrtc/1" && transportOf(cli) === "webrtc/1", 60_000);
      result = { liveMs, firstOn, directMs, requestsToLive };
    }
    return result;
  }

  it.each([
    { higher: false, awayMs: 5 * 60_000 + 3_700, frozen: false, afterAttempt: false, times: 1 },
    { higher: true, awayMs: 5 * 60_000 + 3_700, frozen: false, afterAttempt: false, times: 1 },
    { higher: false, awayMs: 35_000, frozen: false, afterAttempt: false, times: 1 },
    { higher: true, awayMs: 35_000, frozen: false, afterAttempt: false, times: 1 },
    { higher: false, awayMs: 5 * 60_000 + 3_700, frozen: true, afterAttempt: false, times: 1 },
    { higher: true, awayMs: 5 * 60_000 + 3_700, frozen: true, afterAttempt: false, times: 1 },
    { higher: true, awayMs: 5 * 60_000, frozen: true, afterAttempt: true, times: 1 },
    { higher: false, awayMs: 5 * 60_000 + 3_700, frozen: true, afterAttempt: false, times: 3 },
  ])("live again within seconds of coming back (higher key: $higher, away $awayMs ms, frozen: $frozen, after the CLI's attempt: $afterAttempt, times: $times)", async ({ higher, awayMs, frozen, afterAttempt, times }) => {
    const { liveMs, firstOn, directMs, requestsToLive } = await sleepAndWake({ higher, awayMs, frozen, afterAttempt, times });
    if (process.env.WAKE_REPORT) appendFileSync(process.env.WAKE_REPORT, JSON.stringify({ higher, awayMs, frozen, afterAttempt, times, liveMs, firstOn, directMs, requestsToLive }) + "\n");
    // Before: 20 and 64 s away 5 minutes (lower and higher key), 3.3 and 4.9 s away 35 s. After: 0.6 to 0.7 s.
    expect(liveMs, "from the return to live on both sides").toBeLessThan(awayMs > 60_000 ? 2_000 : 3_000);
    // Long away, the contact reads slowly and is reached through its Iroh relay; just away, it still looks fast for the
    // session it lost, and may read the offer first.
    if (awayMs > 60_000) expect(firstOn).toBe("iroh/1");
    expect(directMs, "then to WebRTC, on the session").toBeLessThan(5_000);
    // A knock costs the relays nothing: the reads and publishes of a return, no more (4 to 8 here).
    expect(requestsToLive).toBeLessThanOrEqual(10);
  }, 240_000);

  /**
   * An Android phone back from Doze (the emulator, 2026-11-01): its Iroh lost its relay while the network was cut, and
   * finds it again only seconds after the return, once its own reconnect backoff (up to 16 s) runs out. The knock went at
   * once and went nowhere; QUIC sends it again only seconds later, and Iroh gives a dial 20 s. Live again 4.4 s and
   * 9.8 s after the return (away 5 and 15 minutes), once never over Iroh.
   */
  it.each([false, true])("back from Doze with its Iroh off its relay, it knocks again once the relay is back (higher key: %s)", async higher => {
    const relayBackMs = 4_000, knocks: string[] = [];
    setLinkTraceSink(line => { const step = JSON.parse(line) as { step: string }; if (step.step.startsWith("knock")) knocks.push(step.step); });
    const { liveMs, firstOn } = await sleepAndWake({ higher, awayMs: 5 * 60_000 + 3_700, relayBackMs, dialFailMs: 20_000 });
    setLinkTraceSink(null);
    // Before: the knock's 20 s, or the CLI's background read of the offer. After: the relay's 4 s and a dial.
    expect(liveMs, "from the return to live on both sides").toBeLessThan(relayBackMs + 2_000);
    expect(firstOn).toBe("iroh/1");
    expect(knocks.filter(step => step === "knock-again")).toHaveLength(1);
  }, 240_000);

  /**
   * On Automatic (WISP 100, revision 2026-11-08) a return dials Iroh through its relay first, whatever transport the
   * chat was live on: no WebRTC offer to wait on. Once live, the session moves to WebRTC on itself (`upgrade/1`), which
   * carries files many times faster than the relay. Away 30 s, 2 and 10 minutes.
   */
  it.each([
    { higher: false, awayMs: 30_000 }, { higher: true, awayMs: 30_000 },
    { higher: false, awayMs: 2 * 60_000 }, { higher: true, awayMs: 2 * 60_000 },
    { higher: false, awayMs: 10 * 60_000 }, { higher: true, awayMs: 10 * 60_000 },
  ])("on Automatic, live again on Iroh within seconds of coming back, then on WebRTC (higher key: $higher, away $awayMs ms)", async ({ higher, awayMs }) => {
    const { liveMs, firstOn, directMs, requestsToLive } = await sleepAndWake({ higher, awayMs, frozen: true, kind: "auto+iroh" });
    if (process.env.WAKE_REPORT) appendFileSync(process.env.WAKE_REPORT, JSON.stringify({ kind: "auto+iroh", higher, awayMs, liveMs, firstOn, directMs, requestsToLive }) + "\n");
    expect(liveMs, "from the return to live on both sides").toBeLessThan(2_000);
    expect(firstOn).toBe("iroh/1");
    expect(directMs, "then to WebRTC, on the session").toBeLessThan(5_000);
    expect(requestsToLive).toBeLessThanOrEqual(10);
  }, 240_000);

  it.each([
    { duringAttemptMs: 20_000, crossed: false },
    { duringAttemptMs: 30_000, crossed: false },
    { duringAttemptMs: 47_400, crossed: false },
    // The CLI's own dial of the relayed Iroh is under way (`RACE_RELAYED_MS`, to an app asleep): the knock crosses it,
    // and waits for it there (WISP 100, "Crossed dials": `CROSSED_WAIT_MS` at most).
    { duringAttemptMs: 40_000, crossed: true },
  ])("the higher key wakes while the contact's offer stands (out $duringAttemptMs ms): it answers it, and knocks too", async ({ duringAttemptMs, crossed }) => {
    // Two web pages, one stopped for 4 minutes (e2e): the contact, with the lower key, dials for the whole absence, and
    // its offer is read 70 ms after the wake, while the app's own still gathers. The answer took that offer's place
    // with the dial that made it still under way (it waited 2 s more for candidates of a connection already closed),
    // and no knock went: live at the contact's next read (every 8 s).
    const knocks: string[] = [];
    const traceFile = process.env.RESTART_TRACE;
    setLinkTraceSink(line => {
      if (traceFile) appendFileSync(traceFile, line + "\n");
      const step = JSON.parse(line) as { step: string; transport?: string }; if (step.step === "knock") knocks.push(step.transport ?? "");
    });
    const { liveMs, firstOn, directMs } = await sleepAndWake({ higher: true, awayMs: 4 * 60_000, frozen: true, duringAttemptMs });
    setLinkTraceSink(null);
    if (process.env.WAKE_REPORT) appendFileSync(process.env.WAKE_REPORT, JSON.stringify({ duringAttemptMs, crossed, liveMs, firstOn, directMs, knocks }) + "\n");
    // Before: 7.6, 5.6 and 4.2 s over WebRTC, no knock (3.6 s crossed). After: 1.0 s over the knocked relay (4.0 s crossed).
    expect(knocks).toEqual(["iroh/1"]);
    expect(liveMs, "from the return to live on both sides").toBeLessThan(crossed ? 2_000 + CROSSED_WAIT_MS : 2_000);
    expect(firstOn).toBe("iroh/1");
    expect(directMs, "then to WebRTC, on the session").toBeLessThan(5_000);
  }, 240_000);
});

/**
 * A phone back after minutes asleep to a CLI bot, WebRTC the only transport between them (no Iroh), the phone's key the
 * lower (it dials): its offer waits for the bot's read. The bot read a contact that left at the active pace for 2 minutes,
 * then every 30 s: live again 2.3, 4.5 and 18.3 s after a return from 30 s, 2 and 5 minutes away (the web lab,
 * 2026-11-01). A daemon reads it every 10 s up to 5 minutes (`DAEMON_WATCH_PEER_IDLE_MS`).
 */
describe("a phone back after minutes asleep to a CLI daemon, over WebRTC alone", () => {
  const daemon = { watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS };
  async function asleep(awayMs: number, cli: Partial<ConstructorParameters<typeof GhostLink>[0]>) {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    // The inviter has the lower key: the phone.
    const { inviter: phoneSide, joiner: botSide } = invitationWhere("inviter");
    const phone = startApp(world, "phone", phoneSide, { side: botSide, name: "cli" }, "webrtc", emptyDhtDeliveryState());
    const bot = startApp(world, "cli", botSide, { side: phoneSide, name: "phone" }, "webrtc", emptyDhtDeliveryState(), false, undefined, false, {}, cli);
    expect(await until(() => phone.link.isDataLinkOpen && bot.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    // Asleep: no network, and its WebRTC connection dies unheard (the bot's fails 20 s on).
    phone.offline = true;
    killRtc("phone", undefined, 20_000);
    const asleepAt = Date.now();
    await run(awayMs);
    phone.offline = false;
    /** The bot's reads of the phone's key from `fromMs` to `toMs` into the absence. */
    const reads = (fromMs: number, toMs: number) => bot.requests.filter(r => r.read === phone.link.myPubKeyZ32 && r.at >= asleepAt + fromMs && r.at < asleepAt + toMs).length;
    phone.link.wake();
    const liveMs = await until(() => phone.link.isDataLinkOpen && bot.link.isDataLinkOpen, 120_000);
    return { liveMs, reads };
  }

  // Each just after one of the bot's reads at the background pace (170, 230 s…): the slowest returns before.
  it.each([2 * 60_000 + 51_000, 3 * 60_000 + 51_000, 4 * 60_000 + 30_000])("live within seconds of a return between 2 and 5 minutes (away %i ms)", async awayMs => {
    const { liveMs } = await asleep(awayMs, daemon);
    if (process.env.WAKE_REPORT) appendFileSync(process.env.WAKE_REPORT, JSON.stringify({ daemon: true, awayMs, liveMs }) + "\n");
    // The bot's next read (10 s at most) and the answer's way back.
    expect(liveMs, "from the return to live on both sides").toBeLessThan(RELAY_POLL_INTERVALS.idle + 3_000);
  }, 240_000);

  it("reads a contact away the whole 5 minutes every 10 s from 2 to 5 minutes, 12 reads more, and nothing past them", async () => {
    const before = await asleep(7 * 60_000, {}), after = await asleep(7 * 60_000, daemon);
    if (process.env.WAKE_REPORT) appendFileSync(process.env.WAKE_REPORT, JSON.stringify({ before: before.reads(0, 420_000), after: after.reads(0, 420_000) }) + "\n");
    // The first 2 minutes as before (fast, then the active pace).
    expect(after.reads(0, 120_000)).toBe(before.reads(0, 120_000));
    // From 2.5 to 5 minutes, past the slowing down from the active pace: one read every 10 s, not every 30 s.
    expect(before.reads(150_000, 300_000)).toBeLessThanOrEqual(150_000 / RELAY_POLL_INTERVALS.background + 1);
    expect(after.reads(150_000, 300_000)).toBeGreaterThanOrEqual(150_000 / RELAY_POLL_INTERVALS.idle - 1);
    expect(after.reads(150_000, 300_000)).toBeLessThanOrEqual(150_000 / RELAY_POLL_INTERVALS.idle + 1);
    // Past 5 minutes, the background pace again.
    expect(after.reads(330_000, 420_000)).toBeLessThanOrEqual(90_000 / RELAY_POLL_INTERVALS.background + 1);
    // The whole absence: 12 more (from 2 to 5 minutes, every 10 s and not every 30 s), give or take the edges.
    expect(after.reads(0, 420_000) - before.reads(0, 420_000)).toBeLessThanOrEqual(14);
  }, 240_000);
});

/**
 * Both apps stop, one after the other, and start again together (two bots a service manager restarts, a host that
 * reboots), WebRTC the only transport between them, neither chat on screen. They quit as the engine does (node.ts
 * `stop`): a goodbye on the session, then a last packet that does not advertise. The first to stop was live, so it
 * resumes at its start; the second one's session had ended on that goodbye, so it does not, and its first read finds
 * the goodbye put a second before. Read as any contact away, that left the resumed app's offer to its next read at the
 * background pace: live again after about 35 s (two CLI daemons on loopback, bug hunt 2026-11-14), against 3 to 5 s when
 * only one restarts.
 */
describe("both apps stop one after the other and start again together, over WebRTC alone", () => {
  async function quitAsTheEngine(app: App): Promise<void> {
    app.link.depart({ quitting: true });
    await run(DEPART_FLUSH_MS);
    app.stopped = app.link.stop(true);
    killRtc(app.name);
    await run(DEPART_FLUSH_MS);
  }

  it.each(["lower", "higher"] as const)("the app with the %s key stops first: live again in seconds", async firstStops => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const { inviter: lowSide, joiner: highSide } = invitationWhere("inviter");
    const [firstSide, secondSide] = firstStops === "lower" ? [lowSide, highSide] : [highSide, lowSide];
    let first = startApp(world, "first", firstSide, { side: secondSide, name: "second" }, "webrtc", emptyDhtDeliveryState());
    let second = startApp(world, "second", secondSide, { side: firstSide, name: "first" }, "webrtc", emptyDhtDeliveryState());
    expect(await until(() => first.link.isDataLinkOpen && second.link.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
    await run(20_000);
    await quitAsTheEngine(first);
    expect(second.link.isDataLinkOpen, "the goodbye ends the session").toBe(false);
    await quitAsTheEngine(second);
    await run(500);
    // Back together, the second one a moment ahead: its first read finds the first one's goodbye.
    second = startApp(world, "second", secondSide, { side: firstSide, name: "first" }, "webrtc", second.dhtState);
    const startedAt = Date.now();
    await run(300);
    first = startApp(world, "first", firstSide, { side: secondSide, name: "second" }, "webrtc", first.dhtState, true);
    await until(() => first.link.isDataLinkOpen && second.link.isDataLinkOpen, 120_000);
    const liveMs = Date.now() - startedAt;
    if (process.env.RESTART_REPORT) appendFileSync(process.env.RESTART_REPORT, JSON.stringify({ together: true, firstStops, liveMs }) + "\n");
    // Its next read at the fast pace, and the answer's way back (one restart alone: 3 to 5 s).
    expect(liveMs, "from the start to live on both sides").toBeLessThan(10_000);
    // The relays allow 30 requests a minute per client, reads and publishes together, for every chat.
    await run(Math.max(0, startedAt + 120_000 - Date.now()));
    for (const app of [first, second]) expect(app.requests.filter(r => r.at >= startedAt && r.at < startedAt + 120_000).length / 2, app.name).toBeLessThanOrEqual(10);
  }, 240_000);

  it("a contact that quit a minute before this app starts is read at the background pace, not watched", async () => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const { inviter: lowSide, joiner: highSide } = invitationWhere("inviter");
    // The one that starts has the higher key: the lower key dials a saved contact at its start (`startApp`).
    const first = startApp(world, "first", lowSide, { side: highSide, name: "second" }, "webrtc", emptyDhtDeliveryState());
    let second = startApp(world, "second", highSide, { side: lowSide, name: "first" }, "webrtc", emptyDhtDeliveryState());
    expect(await until(() => first.link.isDataLinkOpen && second.link.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
    await run(20_000);
    await quitAsTheEngine(first);
    await quitAsTheEngine(second);
    await run(60_000);
    second = startApp(world, "second", highSide, { side: lowSide, name: "first" }, "webrtc", second.dhtState);
    const startedAt = Date.now();
    await run(120_000);
    const reads = second.requests.filter(r => r.read === first.link.myPubKeyZ32 && r.at >= startedAt).length;
    // The first read, then one every 30 s (`RELAY_POLL_INTERVALS.background`); watched, it read every 2 s, then every 4 s.
    expect(reads).toBeLessThanOrEqual(120_000 / RELAY_POLL_INTERVALS.background + 2);
  }, 240_000);
});

/**
 * Automatic, both apps with `upgrade/1`: after a restart the chat is live over Iroh through its relay and moves to WebRTC
 * about a second later, when queued texts flush and people type. Each side swaps when its own new session is ready, so
 * for a moment the contact still sends on the session this side just replaced. That session stopped at the swap and
 * dropped what came on it: a text or two each way and a receipt or two, sent within 100 ms of the move, were lost.
 */
describe("texts sent each way while Automatic moves the session from Iroh to WebRTC", () => {
  it.each([
    { restarted: "lower", how: "graceful" }, { restarted: "higher", how: "graceful" },
    { restarted: "lower", how: "crash" }, { restarted: "higher", how: "crash" },
  ] as const)("the app with the $restarted key back ($how): every text arrives, and its receipt within 2 s", async ({ restarted, how }) => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = restarted === "lower" ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    const up = { mine: true, contact: true };
    const got = { goes: new Set<string>(), stays: new Set<string>() }, receipts = { goes: new Set<string>(), stays: new Set<string>() };
    const moves: string[] = [];
    const events = (who: "goes" | "stays") => ({ events: {
      onMessage: async (message: { id?: string }) => { if (message.id) got[who].add(message.id); },
      onMessageReceipt: async (id: string) => { receipts[who].add(id); },
      onTransportSwitched: (from?: string, to?: string) => { moves.push(`${who} ${from}->${to}`); },
    } });
    let goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, "auto+iroh", emptyDhtDeliveryState(), false, undefined, false, up, events("goes"));
    const stays = startApp(world, "stays", staysSide, { side: goesSide, name: "goes" }, "auto+iroh", emptyDhtDeliveryState(), false, undefined, false, up, events("stays"));
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    await quit(world, goes, how);
    await run(RESTART_AFTER_MS);
    moves.length = 0;
    goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, "auto+iroh", goes.dhtState, true, undefined, false, up, events("goes"));
    const before = channelOf(stays);
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== before, 60_000)).toBeLessThan(Infinity);
    // From the moment it is live (on Iroh), one text each way every 50 ms for 8 s: the move falls in the middle.
    const sent = { goes: [] as string[], stays: [] as string[] };
    for (let n = 0; n < 160; n++) {
      for (const [who, app] of [["goes", goes], ["stays", stays]] as const) {
        const id = `${who}${String(n).padStart(4, "0")}`.padEnd(22, "x");
        expect(await app.link.sendMessage(`text ${n}`, Date.now(), id)).toBeNull();
        sent[who].push(id);
      }
      await vi.advanceTimersByTimeAsync(50); await yieldToLoop();
    }
    await run(2_000);
    expect(moves.sort(), "the session moved on both sides while the texts went").toEqual(["goes iroh/1->webrtc/1", "stays iroh/1->webrtc/1"]);
    // Before: 1 or 2 texts each way never arrived, and 1 or 2 that did never had their receipt.
    expect({ goes: sent.goes.filter(id => !got.stays.has(id)), stays: sent.stays.filter(id => !got.goes.has(id)) }, "texts lost").toEqual({ goes: [], stays: [] });
    expect({ goes: sent.goes.filter(id => !receipts.goes.has(id)), stays: sent.stays.filter(id => !receipts.stays.has(id)) }, "receipts missing").toEqual({ goes: [], stays: [] });
  }, 240_000);
});

/**
 * The same move, and what else a person does to a message: a reaction, a pin, an edit (a deletion for everyone is one).
 * Sent by the side that has not swapped yet, the moment its contact did, each went on the session the contact had just
 * replaced. That session read only texts and receipts while it retired: the rest was dropped, and the app said it again
 * only after its 30 s resend (reactions, pins), with the sender's mark unconfirmed until then.
 */
describe("a reaction, a pin and an edit sent while Automatic moves the session from Iroh to WebRTC", () => {
  it.each([
    { restarted: "lower", how: "graceful" }, { restarted: "higher", how: "graceful" },
    { restarted: "lower", how: "crash" }, { restarted: "higher", how: "crash" },
  ] as const)("the app with the $restarted key back ($how): each arrives, and its receipt within 2 s", async ({ restarted, how }) => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = restarted === "lower" ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    const up = { mine: true, contact: true };
    const got: string[] = [], receipts: string[] = [], moves: string[] = [];
    const id = "m".padEnd(22, "x");
    const apps = {} as Record<"goes" | "stays", App>;
    let armed = false;
    // The first side to swap after the restart: its contact, still on the old session, reacts, pins and edits at once.
    const other = (who: "goes" | "stays") => apps[who === "goes" ? "stays" : "goes"];
    const events = (who: "goes" | "stays") => ({ reactionsSupport: true, pinSupport: true, editSupport: true, events: {
      onReaction: async (r: { n: number }) => { got.push(`reaction ${r.n}`); return true; },
      onReactionReceipt: async (n: number) => { receipts.push(`reaction ${n}`); },
      onPin: async (p: { n: number }) => { got.push(`pin ${p.n}`); return true; },
      onPinReceipt: async (n: number) => { receipts.push(`pin ${n}`); },
      onMessageEdit: async (e: { e: number }) => { got.push(`edit ${e.e}`); return true; },
      onEditReceipt: async (_id: string, e: number) => { receipts.push(`edit ${e}`); },
      onTransportSwitched: (from?: string, to?: string) => {
        moves.push(`${who} ${from}->${to}`);
        if (!armed || moves.length !== 1) return;
        const link = other(who).link;
        expect((link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport, "the contact has not swapped yet").toBe("iroh/1");
        expect(link.sendReaction({ id, e: "❤️", n: 7 })).toBeNull();
        expect(link.sendPin({ id, n: 8 })).toBeNull();
        void link.sendEdit({ id, e: 9, ts: Date.now(), m: "edited" });
      },
    } });
    apps.goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, "auto+iroh", emptyDhtDeliveryState(), false, undefined, false, up, events("goes"));
    apps.stays = startApp(world, "stays", staysSide, { side: goesSide, name: "goes" }, "auto+iroh", emptyDhtDeliveryState(), false, undefined, false, up, events("stays"));
    expect(await until(() => apps.goes.link.isDataLinkOpen && apps.stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    await quit(world, apps.goes, how);
    await run(RESTART_AFTER_MS);
    // The first session moved from Iroh to WebRTC too: what counts starts with the restart.
    moves.length = 0; got.length = 0; receipts.length = 0; armed = true;
    apps.goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, "auto+iroh", apps.goes.dhtState, true, undefined, false, up, events("goes"));
    expect(await until(() => moves.length === 2, 60_000)).toBeLessThan(Infinity);
    await run(2_000);
    expect(moves.map(m => m.split(" ")[1]), "the session moved on both sides").toEqual(["iroh/1->webrtc/1", "iroh/1->webrtc/1"]);
    // Before: none of the three arrived, and none was confirmed.
    expect(got.sort(), "arrived").toEqual(["edit 9", "pin 8", "reaction 7"]);
    expect(receipts.sort(), "confirmed").toEqual(["edit 9", "pin 8", "reaction 7"]);
  }, 240_000);
});

/**
 * The same move, and a file under way each way: both senders cancel theirs the moment the first side swaps. Each
 * cancel (`pf-abort`) was lost, and nothing said it again: the sender no longer offers a file it cancelled, and the
 * receiver asks about an active one only after its 30 s idle nudge. Until then it showed the file moving, its progress
 * frozen and its bytes kept.
 * - Said by the side that had not swapped yet, it went on the session its contact had just replaced, which read only
 *   texts, reactions, pins, edits and their receipts while it retired.
 * - Said by the side that had just swapped, it went nowhere: that side's files are off from the swap until the contact
 *   says what it supports on the new session, and a cancel then only ended the file here.
 */
describe("a file's cancel said while Automatic moves the session from Iroh to WebRTC", () => {
  it.each(["lower", "higher"] as const)("the app with the %s key back: each receiver has the file cancelled within 2 s", async restarted => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = restarted === "lower" ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    const up = { mine: true, contact: true };
    const file = new Uint8Array(32 * 1024 * 1024);
    const ids = { goes: "g".padEnd(22, "x"), stays: "s".padEnd(22, "x") };
    const apps = {} as Record<"goes" | "stays", App>, files = {} as Record<"goes" | "stays", ChatFiles>;
    const records = { goes: new Map<string, FileTransferRecord>(), stays: new Map<string, FileTransferRecord>() };
    const other = (who: "goes" | "stays") => who === "goes" ? "stays" : "goes";
    const moves: string[] = [];
    let armed = false, atMove: (string | undefined)[] = [];
    // A chat's files on a link, as the app wires them (filesBinary.test.ts's `desk`); the bytes taken are only counted.
    const chatFiles = (who: "goes" | "stays") => new ChatFiles({
      send: frame => apps[who].link.sendFilesFrame(frame),
      decide: async () => "accept",
      openTarget: async () => ({ offset: 0, append: async () => {}, flush: async () => {}, verify: async () => true, discard: async () => {} }),
      openSource: async () => ({ read: async (offset, length) => file.subarray(offset, offset + length), digest: async () => "x" }),
      changed: record => { records[who].set(record.id, record); },
      room: async () => 1024 ** 3,
    });
    const options = (who: "goes" | "stays") => ({ largeFilesSupport: true, events: {
      onFilesFrame: (frame: Record<string, unknown>) => files[who].handle(frame),
      onFilesSession: (open: boolean) => { if (open) files[who].attach(); else files[who].detach(); },
      onTransportSwitched: (from?: string, to?: string) => {
        moves.push(`${who} ${from}->${to}`);
        if (!armed || moves.length !== 1) return;
        // The side that swapped cancels the file it sends, and so does its contact, still on the old session.
        atMove = [records[other(who)].get(ids[who])?.state, records[who].get(ids[other(who)])?.state];
        files[who].cancel("out", ids[who]);
        files[other(who)].cancel("out", ids[other(who)]);
      },
    } });
    const start = (who: "goes" | "stays", wasLive: boolean) => {
      files[who] = chatFiles(who);
      const [side, contact] = who === "goes" ? [goesSide, { side: staysSide, name: "stays" }] : [staysSide, { side: goesSide, name: "goes" }];
      apps[who] = startApp(world, who, side, contact, "auto+iroh", apps[who]?.dhtState ?? emptyDhtDeliveryState(), wasLive, undefined, false, up, options(who));
    };
    start("goes", false); start("stays", false);
    expect(await until(() => apps.goes.link.isDataLinkOpen && apps.stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    await quit(world, apps.goes, "graceful");
    await run(RESTART_AFTER_MS);
    moves.length = 0; armed = true;
    const before = channelOf(apps.stays);
    start("goes", true);
    expect(await until(() => apps.goes.link.isDataLinkOpen && apps.stays.link.isDataLinkOpen && channelOf(apps.stays) !== before, 60_000)).toBeLessThan(Infinity);
    for (const who of ["goes", "stays"] as const) files[who].offer({ id: ids[who], name: `${who}.bin`, mime: "application/octet-stream", size: file.length, timestamp: 1 });
    expect(await until(() => moves.length === 2, 60_000)).toBeLessThan(Infinity);
    expect(moves.map(m => m.split(" ")[1]), "the session moved on both sides").toEqual(["iroh/1->webrtc/1", "iroh/1->webrtc/1"]);
    expect(atMove, "both files were under way at the move").toEqual(["active", "active"]);
    await run(2_000);
    expect([records.goes.get(ids.goes)?.state, records.stays.get(ids.stays)?.state], "the senders'").toEqual(["cancelled", "cancelled"]);
    // Before: both still active, until each receiver's idle nudge 30 s later got its sender's answer.
    expect({ goes: records.stays.get(ids.goes)?.state, stays: records.goes.get(ids.stays)?.state }, "the receivers'").toEqual({ goes: "cancelled", stays: "cancelled" });
  }, 240_000);
});

/**
 * Automatic, both apps with `upgrade/1`: after a restart the chat is live over Iroh through its relay and then moves to
 * WebRTC. The Iroh endpoint takes connections from anyone who knows its address; one that dials in the moment the chat
 * is live there and never authenticates is nobody. It held the move's one place for a candidate: the WebRTC session
 * that opened for the move was refused as a duplicate, the move failed, and a move off a relay is not planned again.
 */
describe("a connection on the chat's Iroh endpoint that never authenticates, as Automatic moves off the relay", () => {
  const transportOf = (app: App) => (app.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport;
  /** A dial-in that says nothing: whoever read the endpoint's address, with no key of the chat. */
  const silent = () => {
    const channel = { bufferedAmount: 0, drained: async () => {}, send: () => {}, onMessage: null as unknown, onClose: null as (() => void) | null, closed: false,
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); } };
    return channel;
  };
  it.each([
    { restarted: "lower", at: "stays" }, { restarted: "lower", at: "goes" },
    { restarted: "higher", at: "stays" }, { restarted: "higher", at: "goes" },
  ] as const)("the app with the $restarted key back, dialled in at the app that $at: both still move to WebRTC", async ({ restarted, at }) => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    const made = invitationWhere("inviter");
    const [goesSide, staysSide] = restarted === "lower" ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    const up = { mine: true, contact: true };
    const apps = {} as Record<"goes" | "stays", App>;
    const strangers: ReturnType<typeof silent>[] = [];
    let armed = false;
    const events = (who: "goes" | "stays") => ({ events: {
      onPairingState: (state: { status: string; transport?: string }) => {
        if (!armed || who !== at || strangers.length || state.status !== "ready" || state.transport !== "iroh/1") return;
        const endpoint = (apps[who].link as unknown as { endpoints: Map<string, { onConnection: ((c: unknown) => void) | null; descriptor: { id: string } }> }).endpoints.get("iroh/1")!;
        const channel = silent();
        strangers.push(channel);
        endpoint.onConnection?.({ channel, binding: { transport: "iroh/1", context: "c".repeat(64), identities: [endpoint.descriptor.id, "f".repeat(64)] } });
      },
    } });
    apps.goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, "auto+iroh", emptyDhtDeliveryState(), false, undefined, false, up, events("goes"));
    apps.stays = startApp(world, "stays", staysSide, { side: goesSide, name: "goes" }, "auto+iroh", emptyDhtDeliveryState(), false, undefined, false, up, events("stays"));
    expect(await until(() => apps.goes.link.isDataLinkOpen && apps.stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    await quit(world, apps.goes, "graceful");
    await run(RESTART_AFTER_MS);
    armed = true;
    apps.goes = startApp(world, "goes", goesSide, { side: staysSide, name: "stays" }, "auto+iroh", apps.goes.dhtState, true, undefined, false, up, events("goes"));
    expect(await until(() => strangers.length > 0, 60_000), "the stranger dialled in while the chat was live on Iroh").toBeLessThan(Infinity);
    await run(30_000);
    // Before: both stayed on Iroh through its relay for the rest of the session.
    expect([transportOf(apps.goes), transportOf(apps.stays)]).toEqual(["webrtc/1", "webrtc/1"]);
    expect(strangers[0].closed, "the stranger's connection is closed").toBe(true);
  }, 240_000);
});
