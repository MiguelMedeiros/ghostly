import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink, RESUME_WAIT_MS } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.paired.reconnect, transport.chat-switch

/**
 * A chat live on Iroh through its relay (chosen in the Connection menu, Fallback on) when one app crashes or quits, and
 * the Iroh relay out of reach when it starts again: its Iroh endpoint never comes up, while both apps' HyperDHT
 * answers. The resume waited `RESUME_WAIT_MS` (10 s, as long as Iroh's own start waits for its relay) for that
 * endpoint, and the dial after it was a plain one, whose HyperDHT race goes 8 s after its offer: live 20.5-22.9 s
 * after the restart between two CLIs (bh-zero43, n=6), where the contact still held its dead Iroh session.
 */

interface App { name: string; link: GhostLink; stopped?: Promise<void> }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }, opts: { resume?: PairedTransport; endpoints: ("iroh/1" | "hyperdht/1")[] }): App {
  const app = { name } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: {
      peerDescriptors: {
        "iroh/1": { id: native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] },
        "hyperdht/1": { publicKey: native.key("hyperdht/1", contact.name) },
      },
      peerTransports: ["webrtc/1", "hyperdht/1", "iroh/1"], peerFallback: true, preferred: "iroh/1", automatic: false,
    },
    ...(opts.resume ? { resume: opts.resume } : {}),
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  apps.push(app);
  app.link.start();
  app.link.setChatActive(false);
  for (const transport of opts.endpoints) app.link.registerEndpoint(native.endpoint(transport, name));
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
const channelOf = (app: App) => (app.link as unknown as { channel: unknown }).channel;
const transportOf = (app: App) => (app.link as unknown as { paired?: { state: { transport?: string } } }).paired?.state.transport;

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map(app => app.stopped ?? app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

for (const restarted of ["lower", "higher"] as const) it(`back after a crash on Iroh with its relay out of reach, the app with the ${restarted} key is live over HyperDHT at once`, async () => {
  const { inviter, joiner } = invitationWhere("inviter");
  const [goesSide, staysSide] = restarted === "lower" ? [inviter, joiner] : [joiner, inviter];
  let goes = startApp("goes", goesSide, { side: staysSide, name: "stays" }, { endpoints: ["iroh/1", "hyperdht/1"] });
  const stays = startApp("stays", staysSide, { side: goesSide, name: "goes" }, { endpoints: ["iroh/1", "hyperdht/1"] });
  expect(await until(() => transportOf(goes) === "iroh/1" && transportOf(stays) === "iroh/1" && goes.link.isDataLinkOpen && stays.link.isDataLinkOpen, 120_000), "live on Iroh at first").toBeLessThan(Infinity);
  await run(20_000);

  // It crashes: the contact holds its dead Iroh session (it hears nothing until Iroh's idle timeout, 30 s).
  const before = channelOf(stays);
  native.kill("goes"); killRtc("goes");
  goes.stopped = goes.link.stop(false);
  await run(3_000);
  // Back, its Iroh endpoint never starting (the relay is out of reach); its HyperDHT starts at once.
  goes = startApp("goes", goesSide, { side: staysSide, name: "stays" }, { resume: "iroh/1", endpoints: ["hyperdht/1"] });
  const took = await until(() => goes.link.isDataLinkOpen && stays.link.isDataLinkOpen && channelOf(stays) !== before, 120_000);
  console.log(`RESUME_ENDPOINT_DOWN ${restarted}: live again ${took / 1000} s after the restart, on ${transportOf(goes)} (resume wait ${RESUME_WAIT_MS / 1000} s)`);
  expect(took).toBeLessThan(3_000);
  expect(transportOf(goes)).toBe("hyperdht/1");
}, 240_000);
