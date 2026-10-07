import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import type { PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: chat.typing, transport.switch

/**
 * Typing across a transport switch (WISP 401 § Typing). The contact's reader clears the indicator when a session ends,
 * a switch included, and a `start` said between the switch's two sessions goes nowhere. Before, nothing was said again:
 * the contact saw this side stop typing at the switch, and a one-shot `start` (the CLI's `typing`) never came back.
 * Now a start still standing is said again once the new session agreed `typing/1`.
 */

interface App { name: string; link: GhostLink; state: PairingState; typing: boolean[] }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }): App {
  const app = { name, state: { status: "connecting" }, typing: [] as boolean[] } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerDescriptors: { "iroh/1": { id: `${contact.name}:iroh/1`, relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    typingSupport: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: { onPairingState: (state) => { app.state = state; }, onPeerTyping: (typing) => { app.typing.push(typing); } },
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
const agreed = () => apps.every((app) => app.link.supportsTyping);
/**
 * Runs `act` once, the moment `app`'s next session is ready and has not heard its contact's capabilities yet: typing
 * is not agreed then. (Polled for, that moment is too short to land on every time.)
 */
function betweenSessions(app: App, act: () => void): { agreed?: boolean } {
  const capabilities = app.link["sessionCapabilities"] as { reset(): void };
  const reset = capabilities.reset.bind(capabilities), seen: { agreed?: boolean } = {};
  capabilities.reset = () => { reset(); capabilities.reset = reset; seen.agreed = app.link.supportsTyping; act(); };
  return seen;
}

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => { apps.splice(0); await closeWorld(); });

async function liveOnWebrtc(): Promise<{ a: App; b: App }> {
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" }), b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  expect(await until(agreed, 5_000)).toBeLessThan(5_000);
  return { a, b };
}

for (const typer of ["the side that chose", "the other side"] as const) it(`a start still standing when the chat moves is said again on the new session (${typer} typing)`, async () => {
  const { a, b } = await liveOnWebrtc();
  const [writer, reader] = typer === "the side that chose" ? [a, b] : [b, a];
  writer.link.setTyping(true);
  expect(await until(() => reader.link.peerTyping, 5_000)).toBeLessThan(5_000);

  await a.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  // No keystroke since: the writer's start comes back as soon as the new session agreed typing/1.
  const back = await until(() => agreed() && reader.link.peerTyping, 2_000);
  console.log(`TYPING_SWITCH ${typer}: shown again ${back} ms after both were on Iroh; reader saw ${JSON.stringify(reader.typing)}`);
  expect(back).toBeLessThan(2_000);
  expect(reader.typing).toEqual([true, false, true]);

  // The stop that follows reaches the contact on the new session.
  writer.link.setTyping(false);
  expect(await until(() => !reader.link.peerTyping, 2_000)).toBeLessThan(2_000);
}, 60_000);

it("a start said while the chat is between two sessions goes on the new one", async () => {
  const { a, b } = await liveOnWebrtc();
  // The moment the new session is up, its capabilities not said yet (typing not agreed), the person types once.
  const seen = betweenSessions(a, () => a.link.setTyping(true));
  await a.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  expect(seen.agreed).toBe(false);
  expect(await until(() => b.link.peerTyping, 2_000)).toBeLessThan(2_000);
}, 60_000);

it("a start the person ended during the switch is not said again, nor one older than the contact would still show", async () => {
  const { a, b } = await liveOnWebrtc();
  a.link.setTyping(true);
  expect(await until(() => b.link.peerTyping, 5_000)).toBeLessThan(5_000);
  const seen = betweenSessions(a, () => a.link.setTyping(false));
  await a.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  expect(seen.agreed).toBe(false);
  await run(2_000);
  expect(b.link.peerTyping).toBe(false);

  // Typed, then nothing for longer than the contact's 6 s: a move after that says nothing.
  a.link.setTyping(true);
  expect(await until(() => b.link.peerTyping, 5_000)).toBeLessThan(5_000);
  await run(7_000);
  expect(b.link.peerTyping).toBe(false);
  await a.link.setTransportPreference("webrtc/1", true);
  expect(await until(on("webrtc/1"), 30_000)).toBeLessThan(30_000);
  await run(2_000);
  expect(b.link.peerTyping).toBe(false);
}, 60_000);
