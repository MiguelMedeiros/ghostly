import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.paired.reconnect

/**
 * Two apps live on WebRTC; one side's session closes and that side hears it at once (its network changed), while the
 * contact's connection is left as it is. The side whose key dials offered at once; the other did nothing until the
 * contact's own connection gave up: 31-34 s offline with a CLI contact (node-datachannel goes `failed` about 30 s on),
 * 20 s with a browser's (`disconnected` at 5 s, then `DISCONNECT_GRACE_MS`), although Iroh was up on both sides.
 */

interface App { name: string; link: GhostLink; state: PairingState }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }, upgrade: boolean): App {
  const app = { name, state: { status: "connecting" } } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerDescriptors: { "iroh/1": { id: native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
    ...(upgrade ? { upgradeSupport: true, peerUpgrades: () => true } : {}),
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
const live = () => apps.every((app) => app.state.status === "ready" && app.link.isDataLinkOpen);
const onRtc = () => apps.every((app) => app.state.status === "ready" && app.state.transport === "webrtc/1" && app.link.isDataLinkOpen);

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map((app) => app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

// `withinMs`: from the drop to both sides live. The side that does not dial (`b`) offers at once, as the other does, and
// the contact reads it at a live chat's pace; where both move off a relay once live (`upgrade/1`), it knocks on Iroh
// too and is live in a second. Before: 31.6-33.6 s with a CLI contact, 20.6 s with a browser's.
it.each([
  { who: "b", upgrade: false, hearMs: 200, far: "failed", withinMs: 13_000 },
  { who: "b", upgrade: true, hearMs: 200, far: "failed", withinMs: 3_000 },
  { who: "b", upgrade: false, hearMs: 3_000, far: "failed", withinMs: 13_000 },
  { who: "b", upgrade: false, hearMs: 200, far: "disconnected", withinMs: 9_000 },
  { who: "a", upgrade: false, hearMs: 200, far: "failed", withinMs: 13_000 },
  { who: "a", upgrade: true, hearMs: 200, far: "disconnected", withinMs: 9_000 },
] as const)("$who's WebRTC session closes there first: live again without waiting for the contact's to fail (upgrade/1 $upgrade, heard at $hearMs ms, contact's $far)", async ({ who, upgrade, hearMs, far, withinMs }) => {
  // `a` has the lower key: it dials; `b` does not.
  const { inviter, joiner } = invitationWhere("inviter");
  startApp("a", inviter, { side: joiner, name: "b" }, upgrade);
  startApp("b", joiner, { side: inviter, name: "a" }, upgrade);
  expect(await until(onRtc, 60_000)).toBeLessThan(60_000);
  await run(10_000);

  // A CLI contact's connection never says `disconnected`, and goes `failed` 30 s on; a browser's says so after 5 s.
  const closed = far === "failed" ? killRtc(who, undefined, 30_000) : killRtc(who, 5_000);
  await run(hearMs);
  for (const channel of closed) channel.dispatchEvent(new Event("close"));
  const liveMs = await until(live, 60_000);
  const rtcMs = await until(onRtc, 60_000);
  console.log(`RTC_CLOSED_HERE who=${who} upgrade=${upgrade} hear=${hearMs} far=${far}: live again ${(hearMs + liveMs) / 1000} s after the drop, on WebRTC ${(hearMs + liveMs + rtcMs) / 1000} s`);
  expect(hearMs + liveMs).toBeLessThan(withinMs);
  expect(hearMs + liveMs + rtcMs).toBeLessThan(15_000);
}, 240_000);
