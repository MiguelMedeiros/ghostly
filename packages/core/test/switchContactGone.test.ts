import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import type { PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.switch, transport.iroh, transport.hyperdht

/**
 * The contact's app ends its session and goes away while a move to Iroh is pending (the contact's Iroh does not
 * answer). The session the move belonged to is gone, and so is its plan; the switch target went with it too, or this
 * chat never let its native listeners go while the contact stayed away (`canReleaseEndpoint` false for every one).
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
    native: {
      peerDescriptors: {
        "iroh/1": { id: native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] },
        "hyperdht/1": { publicKey: native.key("hyperdht/1", contact.name) },
      },
      // Live on WebRTC first, where the person chose it (Automatic puts Iroh first).
      peerTransports: ["webrtc/1", "iroh/1", "hyperdht/1"], peerFallback: true, preferred: "webrtc/1", automatic: false,
    },
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
  app.link.registerEndpoint(native.endpoint("hyperdht/1", name));
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
const targetOf = (app: App) => (app.link as unknown as { transitionTarget?: PairedTransport }).transitionTarget;
const dialingOf = (app: App) => !!(app.link as unknown as { dialing: unknown }).dialing;

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map((app) => app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

it.each(["a", "b"] as const)("the contact gone while a move %s chose is pending: the chat's native listeners can go", async (chooser) => {
  // `a` has the lower key: it plans the moves and offers.
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" });
  const b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  await run(5_000);

  // `b`'s Iroh does not answer: the move stays pending on both sides.
  native.dialFailMs = 20_000;
  native.asleep.add("b");
  await (chooser === "a" ? a : b).link.setTransportPreference("iroh/1", true);
  await run(1_000);
  expect(targetOf(a)).toBe("iroh/1");

  // `b` closes its session and goes away.
  native.kill("b");
  b.link.disconnect();
  killRtc("b");
  await b.link.stop(false);
  apps.splice(apps.indexOf(b), 1);

  await run(10_000, 1_000);
  expect(targetOf(a)).toBeUndefined();
  await run(50_000, 1_000);
  expect(targetOf(a)).toBeUndefined();
  // Minutes on, nothing dials the contact any more: nothing holds the listeners.
  for (const wait of [240_000, 300_000]) {
    await run(wait, 1_000);
    expect(a.state.status).not.toBe("ready");
    expect(dialingOf(a)).toBe(false);
    expect(targetOf(a)).toBeUndefined();
    expect(a.link.canReleaseEndpoint("iroh/1")).toBe(true);
    expect(a.link.canReleaseEndpoint("hyperdht/1")).toBe(true);
  }
}, 600_000);
