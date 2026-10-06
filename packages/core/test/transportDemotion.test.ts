import { afterEach, expect, it, vi } from "vitest";
import { DEMOTE_AFTER_FAILURES, DEMOTE_MS, GhostLink } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import type { NativeEndpoint, NativeTransport } from "../src/pairedTransports";

// covers: chat.one-chat, transport.iroh, transport.hyperdht

/**
 * WISP 100: a transport that keeps failing is demoted for an hour (tried after the others), and a contact's
 * native transports learnt from its capability record are dialled without a WebRTC session first.
 */
function endpoint(transport: NativeTransport, calls: string[]): NativeEndpoint {
  return {
    transport, descriptor: { id: transport }, onConnection: null, onDescriptor: null,
    connect: async () => { calls.push(transport); throw new Error(`${transport} did not answer`); },
    close: async () => {},
  };
}

afterEach(() => vi.useRealTimers());

it("dials the contact's native transports from its record, and demotes one that fails three times for an hour", async () => {
  vi.useFakeTimers();
  const { mine } = createLink();
  const link = new GhostLink({
    params: { ...mine, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const calls: string[] = [];
  link.registerEndpoint(endpoint("iroh/1", calls));
  link.registerEndpoint(endpoint("hyperdht/1", calls));
  // Nothing but the record: no session ever told this side how to reach the contact.
  link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": { id: "a" }, "hyperdht/1": { publicKey: "b" } });
  const attempt = async () => { await link.connect(1_000).catch(() => {}); await vi.advanceTimersByTimeAsync(1_000); };
  for (let i = 0; i < DEMOTE_AFTER_FAILURES; i++) await attempt();
  expect(calls, "Iroh first, as preferred, then HyperDHT").toEqual(Array(DEMOTE_AFTER_FAILURES).fill(["iroh/1", "hyperdht/1"]).flat());
  calls.length = 0;
  await attempt();
  expect(calls, "both failed three times: both demoted, so the order stays").toEqual(["iroh/1", "hyperdht/1"]);
  await vi.advanceTimersByTimeAsync(DEMOTE_MS);
  calls.length = 0;
  await attempt();
  expect(calls).toEqual(["iroh/1", "hyperdht/1"]);
  await link.stop(false);
});

it("puts a demoted transport after the others", async () => {
  vi.useFakeTimers();
  const { mine } = createLink();
  const link = new GhostLink({
    params: { ...mine, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const calls: string[] = [];
  link.registerEndpoint(endpoint("iroh/1", calls));
  link.registerEndpoint(endpoint("hyperdht/1", calls));
  link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": { id: "a" }, "hyperdht/1": { publicKey: "b" } });
  const attempt = async () => { await link.connect(1_000).catch(() => {}); await vi.advanceTimersByTimeAsync(1_000); };
  for (let i = 0; i < DEMOTE_AFTER_FAILURES; i++) await attempt();
  // HyperDHT's demotion is over (as after a success, which clears it) while Iroh's is not: HyperDHT goes first.
  (link as unknown as { demotedUntil: Map<string, number> }).demotedUntil.delete("hyperdht/1");
  calls.length = 0;
  await attempt();
  expect(calls).toEqual(["hyperdht/1", "iroh/1"]);
  await link.stop(false);
});

it("a newer record that lists a transport with no way to dial it: the endpoint known before is not dialled until a record describes it again", async () => {
  // Omarchy (2026-09-30): both apps restarted, and the web app had no Iroh listener left for the chat (its eight slots
  // taken by other chats). Its record said so, but the Desktop kept the endpoint it knew and dialled it, 20 s each
  // timing out, until it demoted Iroh and nothing was left to try.
  vi.useFakeTimers();
  const { mine } = createLink();
  const link = new GhostLink({
    params: { ...mine, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: false, automatic: false },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const calls: string[] = [];
  link.registerEndpoint(endpoint("iroh/1", calls));
  const attempt = async () => { await link.connect(1_000).catch(() => {}); await vi.advanceTimersByTimeAsync(1_000); };
  // As saved from the last session.
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a" } });
  for (let i = 0; i < DEMOTE_AFTER_FAILURES; i++) await attempt();
  expect(calls).toEqual(Array(DEMOTE_AFTER_FAILURES).fill("iroh/1"));
  // The contact's record, read just now: Iroh listed, not started.
  link.learnPeerTransports(["iroh/1"], {}, true);
  expect(link.transportWait).toMatchObject({ transport: "iroh/1", reason: "starting" });
  calls.length = 0;
  await attempt();
  expect(calls, "nothing to dial while its endpoint is down").toEqual([]);
  // Its next record describes it: dialled again, the failures and the demotion of the old one forgotten.
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a" } }, true);
  expect((link as unknown as { demotedUntil: Map<string, number> }).demotedUntil.has("iroh/1")).toBe(false);
  await attempt();
  expect(calls).toEqual(["iroh/1"]);
  await link.stop(false);
});

it("a listener that starts late, with the contact there and its way known, is dialled at once, not after the backoff", async () => {
  // Every native slot was taken when the app started; the chat gets one later (opened on screen). Its attempts with
  // nothing to dial over had built a backoff of minutes, and the contact, the higher key, does not dial.
  vi.useFakeTimers();
  let made = createLink();
  while (identityFromSeedB64(made.mine.seedB64).pubKeyZ32 > made.mine.peerPubKeyZ32) made = createLink();
  const link = new GhostLink({
    params: { ...made.mine, profile: "paired-chat/1" }, rtcAvailable: false, autoConnect: true,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { fallback: true, automatic: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const session = (link as unknown as { session: object }).session;
  Object.defineProperty(session, "peerPresence", { get: () => ({ online: true, lastPacketAt: Date.now(), services: null }) });
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a" } });
  Object.assign(link as unknown as Record<string, number>, { autoConnectFailures: 4, lastAutoConnectAt: Date.now() });
  const calls: string[] = [];
  link.registerEndpoint(endpoint("iroh/1", calls));
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toEqual(["iroh/1"]);
  await link.stop(false);
});

it("a listener registered again and again, and a record that keeps describing it again, dial no more often than the wait between attempts", async () => {
  // Idle CPU (Linux Desktop, 2026-10-01): each registration and each record that described the endpoint again set the
  // failed attempts back to none and dialled at once, so a chat whose contact never answered was dialled every time,
  // each a native dial, instead of backing off to minutes.
  vi.useFakeTimers();
  let made = createLink();
  while (identityFromSeedB64(made.mine.seedB64).pubKeyZ32 > made.mine.peerPubKeyZ32) made = createLink();
  const link = new GhostLink({
    params: { ...made.mine, profile: "paired-chat/1" }, rtcAvailable: false, autoConnect: true,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { fallback: true, automatic: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const session = (link as unknown as { session: object }).session;
  Object.defineProperty(session, "peerPresence", { get: () => ({ online: true, lastPacketAt: Date.now(), services: null }) });
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a" } });
  const calls: string[] = [];
  // Ten minutes: every 20 s the listener is lost and started anew, and every 30 s the record says it is down, then up.
  for (let s = 0; s < 600; s += 10) {
    if (s % 20 === 0) link.registerEndpoint(endpoint("iroh/1", calls));
    if (s % 30 === 0) link.learnPeerTransports(["iroh/1"], {}, true);
    if (s % 30 === 10) link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a" } }, true);
    await vi.advanceTimersByTimeAsync(10_000);
  }
  // The backoff alone (20 s doubling to 3 min) allows about six in ten minutes; dialling on every change made 40.
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.length).toBeLessThanOrEqual(8);
  await link.stop(false);
});

/** An endpoint whose dials end only at a 20 s connect timeout, as Iroh's do with no network. */
function slowEndpoint(transport: NativeTransport, calls: number[]): NativeEndpoint {
  return {
    transport, descriptor: { id: transport }, onConnection: null, onDescriptor: null,
    connect: () => { calls.push(Date.now()); return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 20_000)); },
    close: async () => {},
  };
}

it("dials that fail with this device offline demote nothing", async () => {
  // Bug hunt r10a (2026-10-06): a PWA offline for a few minutes dialled Iroh three times, each failing for want of a
  // network, and Iroh was then tried last for an hour.
  vi.useFakeTimers();
  let offline = true;
  const { mine } = createLink();
  const link = new GhostLink({
    params: { ...mine, profile: "paired-chat/1" }, rtcAvailable: false, offline: () => offline,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const calls: string[] = [];
  link.registerEndpoint(endpoint("iroh/1", calls));
  link.registerEndpoint(endpoint("hyperdht/1", calls));
  link.learnPeerTransports(["iroh/1", "hyperdht/1"], { "iroh/1": { id: "a" }, "hyperdht/1": { publicKey: "b" } });
  const attempt = async () => { await link.connect(1_000).catch(() => {}); await vi.advanceTimersByTimeAsync(1_000); };
  for (let i = 0; i < DEMOTE_AFTER_FAILURES + 1; i++) await attempt();
  const state = link as unknown as { demotedUntil: Map<string, number>; nativeFailures: Map<string, number> };
  expect(state.demotedUntil.size).toBe(0);
  expect(state.nativeFailures.size).toBe(0);
  offline = false;
  calls.length = 0;
  await attempt();
  expect(calls, "Iroh still first once the network is back").toEqual(["iroh/1", "hyperdht/1"]);
  expect(state.nativeFailures.get("iroh/1")).toBe(1);
  await link.stop(false);
});

it("a native dial started offline is let go when the network comes back, and the chat dialled again at once", async () => {
  // Bug hunt r10a: the dial made offline ran Iroh's 20 s timeout past the network's return, and counted as a failure.
  vi.useFakeTimers();
  let offline = true;
  let made = createLink();
  while (identityFromSeedB64(made.mine.seedB64).pubKeyZ32 > made.mine.peerPubKeyZ32) made = createLink();
  const link = new GhostLink({
    params: { ...made.mine, profile: "paired-chat/1" }, rtcAvailable: false, autoConnect: true, offline: () => offline,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { fallback: true, automatic: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const session = (link as unknown as { session: object }).session;
  Object.defineProperty(session, "peerPresence", { get: () => ({ online: true, lastPacketAt: Date.now(), services: null }) });
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a" } });
  const calls: number[] = [];
  link.registerEndpoint(slowEndpoint("iroh/1", calls));
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toHaveLength(1);
  // Ten seconds into that dial, the network is back.
  await vi.advanceTimersByTimeAsync(10_000);
  offline = false;
  const back = Date.now();
  link.wake({ network: true });
  await vi.advanceTimersByTimeAsync(100);
  expect(calls, "dialled again now, not after the first dial's timeout").toHaveLength(2);
  expect(calls[1]! - back).toBeLessThan(100);
  // The first dial times out: no failure of Iroh's.
  await vi.advanceTimersByTimeAsync(10_000);
  expect((link as unknown as { nativeFailures: Map<string, number> }).nativeFailures.has("iroh/1")).toBe(false);
  await link.stop(false);
});
