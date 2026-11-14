import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import type { NativeEndpoint, PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.paired.reconnect, transport.switch

/**
 * Connections dialled in on a pinned chat's native endpoint that never authenticate: whoever read the endpoint (a copy
 * of the invite before the pin, the Iroh relay's operator) can dial it as often as they like. Such a connection keeps
 * no place against the contact's own: the contact back after a restart takes the chat over, and a move both sides
 * agreed lands, however many of them come first or keep coming.
 */

interface App { name: string; link: GhostLink; state: PairingState; endpoint: NativeEndpoint }
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
  app.endpoint = native.endpoint("iroh/1", name);
  app.link.registerEndpoint(app.endpoint);
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
const channelOf = (app: App) => (app.link as unknown as { channel: unknown }).channel;

/** Someone who read `target`'s endpoint dials it every `everyMs` and never says a word, until `stop()`. */
function silentDials(target: string, everyMs: number): { stop(): void } {
  const silent = native.endpoint("iroh/1", "silent");
  const timer = setInterval(() => { void silent.connect({ id: native.key("iroh/1", target) }).catch(() => {}); }, everyMs);
  return { stop: () => clearInterval(timer) };
}

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map((app) => app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

it("silent dials in, one every 100 ms, do not turn the contact back after a crash away", async () => {
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" });
  const b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  await run(5_000);
  await a.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  await run(10_000);

  // `b` ends with nothing said: `a` still holds the session, and `b`'s dial back replaces it once it authenticated.
  const held = channelOf(a);
  native.kill("b");
  killRtc("b");
  await b.link.stop(false);
  apps.splice(apps.indexOf(b), 1);
  const dials = silentDials("a", 100);
  await run(3_000);
  startApp("b", joiner, { side: inviter, name: "a" }, "iroh/1");
  const took = await until(() => on("iroh/1")() && channelOf(a) !== held, 20_000);
  dials.stop();
  // Before: each silent dial took the place of the contact's before it authenticated, and the chat waited for the old
  // session's idle timeout (30 s) and the contact's next try.
  expect(took).toBeLessThan(10_000);
}, 240_000);

it("a silent dial in that comes first does not make the move both sides agreed fail", async () => {
  // `a` has the lower key: it plans the move and dials `b`'s Iroh.
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" });
  const b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  await run(5_000);
  const [coordinator, contact] = a.link.myPubKeyZ32 < b.link.myPubKeyZ32 ? [a, b] : [b, a];
  // The coordinator's dial takes a second longer than the silent one, which reaches the contact first.
  const connect = coordinator.endpoint.connect.bind(coordinator.endpoint);
  coordinator.endpoint.connect = async (to) => { await new Promise(resolve => setTimeout(resolve, 1_000)); return connect(to); };
  const switcher = (contact.link as unknown as { switcher: { pending: unknown } }).switcher;
  const silent = native.endpoint("iroh/1", "silent");
  let dialled = false;
  void coordinator.link.setTransportPreference("iroh/1", true);
  await until(() => !!switcher.pending, 5_000, 10);
  if (switcher.pending) { dialled = true; void silent.connect({ id: native.key("iroh/1", contact.name) }).catch(() => {}); }
  expect(dialled).toBe(true);
  // Before: the contact refused the coordinator's dial as a duplicate while the silent one held the place, and the move
  // failed.
  expect(await until(on("iroh/1"), 8_000)).toBeLessThan(8_000);
}, 240_000);
