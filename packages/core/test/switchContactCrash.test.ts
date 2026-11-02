import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import type { PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.switch, chat.paired.reconnect

/**
 * The contact's app ends while this side's move to WebRTC connects to it, and comes back on the native transport the
 * chat was on: its dial lands the move there (a fallback the move allows), and the move to WebRTC is made again. The
 * WebRTC connection the move had started was left connecting to the app that ended until it failed (about 30 s on the
 * CLI's WebRTC): the next try, 20 s on, found it still there, offered nothing and gave up after its 8 s, and the chat
 * waited 40 s more. On WebRTC again 70 s after the contact was back (two CLIs, the twoPeers restart test on CI).
 */

interface App { name: string; link: GhostLink; state: PairingState }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }, resume?: PairedTransport): App {
  const app = { name, state: { status: "connecting" } } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerDescriptors: { "iroh/1": { id: native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
    ...(resume && { resume }),
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

async function run(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) { await vi.advanceTimersByTimeAsync(step); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number, step = 100): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(step, step);
  }
  return Date.now() - start;
}
const on = (transport: PairedTransport) => () => apps.every((app) => app.state.status === "ready" && app.state.transport === transport && app.link.isDataLinkOpen);
const dataLinkOf = (app: App) => (app.link as unknown as { dataLink: { state: string } }).dataLink;

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map((app) => app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

it("the contact back on the native transport after it ended mid-move: on WebRTC again at the next try", async () => {
  // `a` has the lower key: it plans the moves and offers.
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" });
  const b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  await run(5_000);
  await a.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  await run(10_000);

  // Back to WebRTC; `b` ends with nothing said while that connection is still connecting. The CLI's WebRTC never says
  // `disconnected`: `a`'s goes `failed` 30 s later.
  await a.link.setTransportPreference("webrtc/1", true);
  expect(await until(() => dataLinkOf(a).state === "connecting", 10_000, 5)).toBeLessThan(10_000);
  native.kill("b");
  killRtc("b", undefined, 30_000);
  await b.link.stop(false);
  apps.splice(apps.indexOf(b), 1);
  await run(3_000);

  // Back on Iroh, the transport it was live on: its knock reaches `a`, which still holds the old session.
  startApp("b", joiner, { side: inviter, name: "a" }, "iroh/1");
  expect(await until(on("iroh/1"), 15_000)).toBeLessThan(15_000);
  const took = await until(on("webrtc/1"), 120_000);
  console.log(`CONTACT_CRASH_MID_MOVE: on WebRTC again ${took / 1000} s after the contact was back`);
  // The next try, 20 s after the move landed on Iroh, connects. Before: 68 s.
  expect(took).toBeLessThan(25_000);
}, 240_000);
