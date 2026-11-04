import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import type { NativeEndpoint } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.switch

/**
 * The switch coordinator dials what a plan names. A plan cancelled while its native dial runs cannot abort it (the
 * dial ends at its own timeout, 20 s on the web), so a contact that keeps proposing and failing moves stacked dials,
 * one per plan, to addresses it named. One switch dial is in flight per transport; the next waits for it.
 */

interface App { name: string; link: GhostLink; state: PairingState; endpoint: NativeEndpoint }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }): App {
  const app = { name, state: { status: "connecting" } } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerDescriptors: { "iroh/1": { id: native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
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

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => { apps.splice(0); await closeWorld(); });

it("a contact proposing and failing moves over and over gets one switch dial in flight at a time", async () => {
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" }), b = startApp("b", joiner, { side: inviter, name: "a" });
  for (let t = 0; t < 60_000 && !apps.every(app => app.state.status === "ready" && app.link.isDataLinkOpen); t += 100) await run(100);
  expect(apps.every(app => app.state.status === "ready" && app.state.transport === "webrtc/1")).toBe(true);
  await run(5_000);
  const [coordinator, contact] = a.link.myPubKeyZ32 < b.link.myPubKeyZ32 ? [a, b] : [b, a];

  // The coordinator's Iroh dials hang until their own timeout, as a dial to an address nobody answers does.
  let inFlight = 0, most = 0, dials = 0;
  coordinator.endpoint.connect = () => {
    dials++; most = Math.max(most, ++inFlight);
    return new Promise((_, reject) => setTimeout(() => { inFlight--; reject(new Error("iroh/1 did not connect")); }, 20_000));
  };
  // The contact sends switch frames by hand; its own switch stays quiet.
  const raw = contact.link as unknown as { channel: { send(data: string): void }; switcher: { handle(frame: unknown): boolean } };
  raw.switcher.handle = () => true;
  const switcher = (coordinator.link as unknown as { switcher: { pending: { id: string } | null; context: string } }).switcher;
  const send = (frame: object) => raw.channel.send(JSON.stringify({ ...frame, context: switcher.context }));

  for (let i = 1; i <= 30; i++) {
    const id = i.toString(16).padStart(64, "0");
    send({ t: "paired-policy", replaces: true, policy: { revision: 1_000 + i, intent: 1_000 + i, preferred: "iroh/1", fallback: false,
      available: ["webrtc/1", "iroh/1"], descriptors: { "iroh/1": { id, relay: null, addresses: [] } } } });
    await run(20, 10);
    const plan = switcher.pending;
    if (!plan) continue;
    send({ t: "paired-switch-ready", id: plan.id });
    await run(20, 10);
    send({ t: "paired-switch-failed", id: plan.id });
    await run(20, 10);
  }
  await run(1_000);
  expect(dials).toBeGreaterThan(0);
  expect(most).toBe(1);
}, 90_000);
