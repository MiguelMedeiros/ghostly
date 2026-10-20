import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { DHT_POLL_INTERVALS } from "../src/link";
import type { PkarrTransport } from "../src/transport";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { setLinkTraceSink } from "../src/linkTrace";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.paired.reconnect

/**
 * The app with the lower key (the one that dials) restarts, and its first dials fail: in the DHT-direct lab (Desktop
 * pace, CLI daemons, HyperDHT on loopback) a knock and a dial both failed in 4-13 ms (HOLEPUNCH_ABORTED), the next dial
 * waited the 40 s backoff, and meanwhile the chat read the contact's key every 0.7 s for the rest of the start's fast
 * window: 45 reads, each ending in `dial-backoff`, live again at 40.5 s while the app's other chats took 0.5-3 s.
 * Two apps of a chat on HyperDHT only (no WebRTC), the Desktop's DHT pace; the restarted app's dials fail after
 * `failMs` until a second after the restart.
 */

interface App { name: string; side: Side; link: GhostLink; dhtState: DhtDeliveryState; reads: number[]; stopped?: Promise<void> }
const apps: App[] = [];
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

function counted(pkarr: MemoryPkarr, app: App): PkarrTransport {
  const inner = pkarr.transport();
  return {
    publish: (identity, records) => inner.publish(identity, records),
    resolve: async (key, options) => { app.reads.push(Date.now()); return inner.resolve(key, options); },
    describe: inner.describe,
  };
}

function startApp(world: { pkarr: MemoryPkarr; native: NativeWorld }, name: string, side: Side, contact: { side: Side; name: string }, dhtState: DhtDeliveryState, wasLive = false): App {
  const app = { name, side, dhtState, reads: [] } as unknown as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: false,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: peerKeyOf(contact.side) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: dhtState, save: async state => { app.dhtState = state; } },
    native: { peerDescriptors: { "hyperdht/1": { publicKey: world.native.key("hyperdht/1", contact.name) } }, peerTransports: ["hyperdht/1"], peerFallback: true, automatic: true },
    ...(wasLive ? { resume: "hyperdht/1" as const } : {}),
    transport: counted(world.pkarr, app),
    pollIntervals: DHT_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  apps.push(app);
  app.link.start();
  app.link.setChatActive(false);
  app.link.registerEndpoint(world.native.endpoint("hyperdht/1", name));
  if (app.link.myPubKeyZ32 < side.params.peerPubKeyZ32) void app.link.connect().catch(() => {});
  return app;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > limit) return Infinity; await run(100); }
  return Date.now() - start;
}

beforeEach(useFakeWorld);
afterEach(async () => {
  setLinkTraceSink(null);
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map(app => app.stopped ?? app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

describe("a HyperDHT-only chat whose first dials after a restart fail", () => {
  // 0: the dials go through. 13: they fail at once (the lab's HOLEPUNCH_ABORTED), and the first is tried again soon.
  // 5000: NativeWorld's usual failure, a real attempt: the backoff stands (40 s after the dial at 5 s), and the chat
  // reads fast only while its knock and dial are under way (10 s). Before: 53 and 54 reads, the 13 ms case live at 40.9 s.
  it.each([[0, 1_000, 5], [13, 6_000, 10], [5_000, 50_000, 25]])("does not read the contact fast while no dial can go, and is live again in time (dials fail after %s ms)", async (failMs, liveBy, readsBy) => {
    const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
    world.native.dialMs = 30;
    const made = invitationWhere("inviter");
    let goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, emptyDhtDeliveryState());
    const stays = startApp(world, "stays", made.joiner, { side: made.inviter, name: "goes" }, emptyDhtDeliveryState());
    expect(await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000)).toBeLessThan(Infinity);
    await run(20_000);
    goes.link.depart(); await run(300);
    world.native.kill("goes");
    goes.stopped = goes.link.stop(false);
    await run(10_000);
    if (failMs > 0) { world.native.dialsLost.add("goes"); world.native.dialFailMs = failMs; }
    const steps: string[] = [];
    setLinkTraceSink(line => { steps.push((JSON.parse(line) as { step: string }).step); });
    goes = startApp(world, "goes", made.inviter, { side: made.joiner, name: "stays" }, goes.dhtState, true);
    const back = Date.now();
    // As in the lab: the knock and the dial right after it fail, and the path works a moment later.
    setTimeout(() => world.native.dialsLost.delete("goes"), failMs * 2 + 1_000);
    const liveMs = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000);
    const reads = goes.reads.filter(t => t >= back && t < back + liveMs).length;
    const backoffs = steps.filter(s => s === "dial-backoff").length;
    console.log(`dials fail after ${failMs} ms: live again ${liveMs} ms, restarted app's reads to live ${reads}, dial-backoff steps ${backoffs}`);
    expect(liveMs, "from the restart to live on both sides").toBeLessThanOrEqual(liveBy);
    expect(reads, "reads by the restarted app until live").toBeLessThanOrEqual(readsBy);
  }, 240_000);
});
