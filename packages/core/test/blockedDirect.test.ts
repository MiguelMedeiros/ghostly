import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { emptyDhtDeliveryState } from "../src/dhtDelivery";
import { setLinkTraceSink } from "../src/linkTrace";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, rtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.relayed, chat.paired.reconnect

/**
 * A saved contact, both apps starting, on a network that lets no direct connection through (a VPN, a firewall): how
 * long until the chat is live over the transport that still works, Iroh through its relay. Two browsers, as the engine
 * runs their links (node.ts `startLink`): WebRTC first, a relayed Iroh ranked after it whose listener is up a moment
 * after the app starts, an in-memory Pkarr with the network's delays, fake time. The chat was live over WebRTC when
 * the apps last ran, so both dial it again first (`resume`).
 */
interface App { name: string; link: GhostLink }
const apps: App[] = [];
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;
/** A browser's Iroh is up this long after the page loads (the wasm, then its relay). */
const IROH_UP_MS = 1_500;

function startApp(world: { pkarr: MemoryPkarr; native: NativeWorld }, name: string, side: Side, contact: { side: Side; name: string }): App {
  const app = { name } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: peerKeyOf(contact.side) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: { state: emptyDhtDeliveryState(), save: async () => {} },
    // The contact's Iroh as its capability record says it: reached through a relay, no direct address.
    native: { peerDescriptors: { "iroh/1": { id: `${contact.name}:iroh/1`, relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
    resume: "webrtc/1",
    transport: world.pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  apps.push(app);
  app.link.start();
  app.link.setChatActive(false);
  setTimeout(() => app.link.registerEndpoint(world.native.endpoint("iroh/1", name)), IROH_UP_MS);
  // node.ts startLink: a saved contact with transports known is dialled once the endpoints are up, by the lower key.
  if (app.link.myPubKeyZ32 < side.params.peerPubKeyZ32) void app.link.connect().catch(() => {});
  return app;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
}
const transportOf = (app: App) => (app.link as unknown as { paired?: { state: { status: string; transport?: string } } }).paired?.state;
const live = (app: App) => app.link.isDataLinkOpen && transportOf(app)?.status === "ready";

/** Both apps start; resolves to how long the chat took to be live on both sides, and over what. */
async function bothStart(): Promise<{ ms: number; transport?: string }> {
  const world = { pkarr: new MemoryPkarr(DESKTOP_NETWORK), native: new NativeWorld() };
  const made = invitationWhere("inviter");
  const low = startApp(world, "low", made.inviter, { side: made.joiner, name: "high" });
  const high = startApp(world, "high", made.joiner, { side: made.inviter, name: "low" });
  const start = Date.now();
  while (!(live(low) && live(high))) {
    if (Date.now() - start > 5 * 60_000) return { ms: Infinity };
    await run(100);
  }
  const result = { ms: Date.now() - start, transport: transportOf(low)?.transport };
  const report = process.env.BLOCKED_REPORT;
  if (report) appendFileSync(report, `${expect.getState().currentTestName}: ${(result.ms / 1000).toFixed(1)} s over ${result.transport}\n`);
  return result;
}

beforeEach(() => {
  useFakeWorld();
  const trace = process.env.BLOCKED_TRACE;
  if (trace) setLinkTraceSink(line => appendFileSync(trace, `${expect.getState().currentTestName} ${line}\n`));
});
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map(app => app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

describe("a saved contact on a network that lets no direct connection through goes live over the relayed Iroh, soon", () => {
  it("on an open network the chat is back over WebRTC, as always", async () => {
    const result = await bothStart();
    expect(result.transport).toBe("webrtc/1");
    expect(result.ms).toBeLessThan(10_000);
  });

  it("offer and answer meet and nothing connects (a VPN's NAT): the relayed Iroh is dialled a few seconds after the answer, not when ICE gives up", async () => {
    rtc.blocked = true;
    // Chromium says `failed` about 15 s after the answer; the attempt itself would wait 90 s.
    rtc.blockedFailsAfterMs = 15_000;
    const result = await bothStart();
    expect(result.transport).toBe("iroh/1");
    expect(result.ms).toBeLessThan(12_000);
  });

  it("the same when ICE never says it failed: the chat does not wait out the attempt", async () => {
    rtc.blocked = true;
    const result = await bothStart();
    expect(result.transport).toBe("iroh/1");
    expect(result.ms).toBeLessThan(12_000);
  });

  for (const who of [["low"], ["high"], ["low", "high"]]) {
    it(`no candidate at all on ${who.join(" and ")} (UDP blocked, a VPN's browser extension): that app dials the relayed Iroh itself, at once`, async () => {
      for (const name of who) rtc.noCandidates.add(name);
      const result = await bothStart();
      expect(result.transport).toBe("iroh/1");
      // Its gathering stalls three times over first (`GATHER_STALL_MS`, 9 s in all); then the dial takes a moment.
      expect(result.ms).toBeLessThan(12_000);
    });
  }
});
