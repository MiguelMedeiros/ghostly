import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink, SWITCH_RETIRE_MS } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import type { PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.switch, transport.chat-switch

/**
 * A chat moved off WebRTC and back again within a few seconds (the person tried Iroh, then went back). The WebRTC
 * session it left is closed only `SWITCH_RETIRE_MS` after the move, so the contact has time to move too; a plan back
 * to WebRTC made meanwhile found that data link still open, offered nothing, and gave up after its 8 s, then waited
 * the 20 s retry: 28.3-28.9 s on two CLIs (r9g, n=8) where a later switch takes 0.2-2.3 s.
 */

interface App { name: string; link: GhostLink; state: PairingState }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }): App {
  const app = { name, state: { status: "connecting" } } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerDescriptors: { "iroh/1": { id: `${contact.name}:iroh/1`, relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: { onPairingState: (state) => { app.state = state; } },
  });
  apps.push(app);
  app.link.start();
  app.link.registerEndpoint(native.endpoint("iroh/1", name));
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
const on = (transport: PairedTransport) => () => apps.every((app) => app.state.status === "ready" && app.state.transport === transport && app.link.isDataLinkOpen);

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => { apps.splice(0); await closeWorld(); });

for (const chooser of ["the dialling side", "the other side"] as const) it(`back to WebRTC a moment after leaving it goes at once, chosen by ${chooser}`, async () => {
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" }), b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  await run(5_000);
  const who = chooser === "the dialling side" ? a : b;

  await who.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  // Back within the WebRTC session's retirement.
  await run(500);
  await who.link.setTransportPreference("webrtc/1", true);
  const took = await until(on("webrtc/1"), 60_000);
  console.log(`SWITCH_BACK ${chooser}: on WebRTC again ${took / 1000} s after choosing it (retire ${SWITCH_RETIRE_MS / 1000} s)`);
  expect(took).toBeLessThan(8_000);
}, 60_000);
