import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostLink, RTC_SIGNAL_RATE_WINDOW_MS, RTC_SIGNAL_RECEIVE_LIMIT } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import type { PairingState } from "../src/pairedSession";
import { signPairedSignal } from "../src/pairedSignal";
import type { PairedTransport } from "../src/pairedTransports";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, invitationWhere, rtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";

// covers: transport.switch

/**
 * WebRTC signals on an open session (`paired-rtc`, while a move to WebRTC is pending) have a receive window: each offer
 * taken tears the data link's connection down and builds a new one, so a contact's app that keeps sending offers had
 * this side build one peer connection per frame.
 */

interface App { name: string; side: Side; link: GhostLink; state: PairingState; made: number; signals: number }
let pkarr: MemoryPkarr, native: NativeWorld;
const apps: App[] = [];

function startApp(name: string, side: Side, contact: { side: Side; name: string }): App {
  const app = { name, side, state: { status: "connecting" }, made: 0, signals: 0 } as App;
  app.link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: identityFromSeedB64(contact.side.seedB64).pubKeyZ32 }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerDescriptors: { "iroh/1": { id: native.key("iroh/1", contact.name), relay: "https://relay.test./", addresses: [] } }, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true, automatic: true },
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => { app.made++; return fakePeerConnection(name); },
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: { onPairingState: (state) => { app.state = state; } },
  });
  // Signals that came on the session and got past its window to the data link.
  const dataLink = (app.link as unknown as { dataLink: { handleSignal: (json: string, sight?: { live?: boolean }) => Promise<void> } }).dataLink;
  const handle = dataLink.handleSignal.bind(dataLink);
  dataLink.handleSignal = (json, sight) => { if (sight?.live) app.signals++; return handle(json, sight); };
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
const movingToRtc = (app: App) => () => !!(app.link as unknown as { switcher: { pending: { choices: string[] } | null } }).switcher.pending?.choices.includes("webrtc/1");

/** `from` sends `n` validly signed offers on its live session, `perStep` every 100 ms, each newer than the last. */
async function offers(from: App, n: number, perStep = 50): Promise<void> {
  const channel = (from.link as unknown as { channel: { send(data: string): void } }).channel;
  const to = from.side.params.peerPubKeyZ32, base = Date.now();
  for (let i = 0; i < n; i++) {
    const offer = { t: "o", ts: base + i, u: `ufrag${i}`, p: "passwordpasswordpassword", f: "ab".repeat(32), s: "actpass", c: ["h,192.0.2.1,50000"] };
    channel.send(JSON.stringify({ t: "paired-rtc", signal: signPairedSignal(JSON.stringify(offer), from.side.seedB64, from.link.myPubKeyZ32, to) }));
    if ((i + 1) % perStep === 0) await run(100);
  }
}

/** Both apps live on Iroh, after a first session on WebRTC (`a` has the lower key: it plans the moves and offers). */
async function onIroh(): Promise<[App, App]> {
  const { inviter, joiner } = invitationWhere("inviter");
  const a = startApp("a", inviter, { side: joiner, name: "b" });
  const b = startApp("b", joiner, { side: inviter, name: "a" });
  expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
  await run(5_000);
  await a.link.setTransportPreference("iroh/1", true);
  expect(await until(on("iroh/1"), 30_000)).toBeLessThan(30_000);
  await run(5_000);
  return [a, b];
}

beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); });
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(apps.splice(0).map((app) => app.link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

it("a contact's flood of signed offers while a move to WebRTC is pending builds connections only within the window", async () => {
  const [a, b] = await onIroh();
  await a.link.setTransportPreference("webrtc/1", true);
  expect(await until(movingToRtc(b), 5_000, 5)).toBeLessThan(5_000);
  const made = b.made, signals = b.signals;

  await offers(a, 1_000);
  await run(1_000);
  // Before: every offer reached the data link and built a connection, 1,001 of them.
  expect(b.signals - signals).toBeLessThanOrEqual(RTC_SIGNAL_RECEIVE_LIMIT);
  expect(b.made - made).toBeLessThanOrEqual(RTC_SIGNAL_RECEIVE_LIMIT + 1);

  // The window is full: one more offer builds nothing.
  if (movingToRtc(b)()) {
    const full = b.made;
    await offers(a, 1);
    await run(500);
    expect(b.made).toBe(full);
  }
}, 240_000);

it("the window has room again once its period has passed: a later move's signals all get through", async () => {
  const [a, b] = await onIroh();
  await a.link.setTransportPreference("webrtc/1", true);
  expect(await until(movingToRtc(b), 5_000, 5)).toBeLessThan(5_000);
  await offers(a, RTC_SIGNAL_RECEIVE_LIMIT + 20);
  await run(RTC_SIGNAL_RATE_WINDOW_MS);

  // Whatever the flood left, the chat is moved to Iroh and back towards WebRTC: its signals are read again.
  const back = on("iroh/1")() ? null : (await a.link.setTransportPreference("iroh/1", true), await until(on("iroh/1"), 60_000));
  if (back !== null) expect(back).toBeLessThan(60_000);
  await run(5_000);
  await a.link.setTransportPreference("webrtc/1", true);
  expect(await until(movingToRtc(b), 5_000, 5)).toBeLessThan(5_000);
  const signals = b.signals, made = b.made;
  await offers(a, 10, 10);
  await run(500);
  expect(b.signals - signals).toBeGreaterThanOrEqual(10);
  expect(b.made - made).toBeGreaterThanOrEqual(10);
}, 300_000);

it("honest moves to WebRTC and back each connect, every signal read", async () => {
  const [a, b] = await onIroh();
  for (let move = 1; move <= 5; move++) {
    await a.link.setTransportPreference("webrtc/1", true);
    expect(await until(on("webrtc/1"), 60_000)).toBeLessThan(60_000);
    // One signal each way per move: `a`'s offer, `b`'s answer, both on the session.
    expect([a.signals, b.signals]).toEqual([move, move]);
    await a.link.setTransportPreference("iroh/1", true);
    expect(await until(on("iroh/1"), 60_000)).toBeLessThan(60_000);
  }
}, 300_000);

it("a move whose WebRTC cannot connect sends its signals again within the window, and the next move connects", async () => {
  const [a, b] = await onIroh();
  rtc.blocked = true;
  await a.link.setTransportPreference("webrtc/1", true);
  await run(90_000);
  expect(Math.max(a.signals, b.signals)).toBeLessThanOrEqual(RTC_SIGNAL_RECEIVE_LIMIT / 2);
  rtc.blocked = false;
  expect(await until(on("webrtc/1"), 120_000)).toBeLessThan(120_000);
}, 300_000);
