import { afterEach, expect, it, vi } from "vitest";
import { DEMOTE_AFTER_FAILURES, DEMOTE_MS, GhostLink } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
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
