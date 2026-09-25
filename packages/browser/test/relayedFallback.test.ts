import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState } from "@ghostly/core";
import { db } from "../src/engine/db";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: transport.relayed, transport.iroh-web

/**
 * Two browsers behind NATs WebRTC cannot cross (symmetric NATs, or UDP blocked): the side that dials tries WebRTC
 * first, as the rank says, and when that attempt ends without opening, goes on to the relayed Iroh both sides
 * advertise, instead of giving up to the DHT. Iroh stands in through FakeNativeNet with browser-shaped
 * (relay-only) descriptors.
 */
const links: { id: string; link: GhostLink }[] = [];
afterEach(async () => {
  for (const { id, link } of links.splice(0)) { await link.stop(false); await db.deleteLink(id); }
});

async function pair(tag: string, rtc: "blocked" | "never-answers") {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const seeds = [createIdentity().seedB64, createIdentity().seedB64];
  const endpoints = [0, 1].map(i => {
    const endpoint = net.endpoint("iroh/1", `${tag}-${i}`);
    endpoint.descriptor = { ...(endpoint.descriptor as object), relay: "https://relay.example/", addresses: [], relayed: true };
    return endpoint;
  });
  const states: PairingState[] = [{ status: "connecting" }, { status: "connecting" }];
  const offers: number[] = [0, 0];
  const made: GhostLink[] = [];
  for (let i = 0; i < 2; i++) {
    const id = `${tag}-${i}`;
    await db.putLink({ ...params[i], id, profile: "paired-chat/1", participationSeed: seeds[i], createdAt: 1 });
    const link = new GhostLink({
      params: { ...params[i], profile: "paired-chat/1" },
      pairing: { credentials: { seedB64: seeds[i], peerKey: identityFromSeedB64(seeds[1 - i]).pubKeyZ32 }, pinPeer: async () => {} },
      native: { preferred: "webrtc/1", fallback: true, peerTransports: ["webrtc/1", "iroh/1"], peerFallback: true,
        peerDescriptors: { "iroh/1": endpoints[1 - i].descriptor } },
      transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "in-process", relays: [] }) },
      createPeerConnection: () => {
        offers[i]++;
        if (rtc === "blocked") throw new Error("WebRTC blocked");
        // An offer that gathers nothing and never hears back: the attempt times out.
        return new NeverConnects() as unknown as RTCPeerConnection;
      },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: { onPairingState: state => { states[i] = state; } },
    });
    link.registerEndpoint(endpoints[i]);
    made.push(link); links.push({ id, link });
  }
  return { links: made, states, offers };
}

/** Enough of RTCPeerConnection for DataLink to offer and then wait. */
class NeverConnects extends EventTarget {
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  createDataChannel() { return new EventTarget(); }
  async createOffer() {
    const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");
    return { type: "offer", sdp: ["v=0", `a=fingerprint:sha-256 ${fingerprint}`, "a=ice-ufrag:abcd", "a=ice-pwd:efghijklmnopqrstuvwxyz12",
      "a=setup:actpass", "a=candidate:1 1 udp 2122260223 192.168.0.9 50000 typ host", ""].join("\r\n") };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  close() { this.connectionState = "closed"; }
}

it("goes on to a relayed Iroh when WebRTC cannot even start", async () => {
  const { links: [a], states, offers } = await pair("rtc-blocked", "blocked");
  await a.connect(5_000);
  await vi.waitFor(() => expect(states.map(s => [s.status, s.transport])).toEqual([["ready", "iroh/1"], ["ready", "iroh/1"]]));
  expect(offers[0]).toBe(1);
  expect(await a.sendMessage("over the relay")).toBeNull();
});

it("goes on to a relayed Iroh when a WebRTC attempt times out, and not before", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  try {
    const { links: [a], states, offers } = await pair("rtc-timeout", "never-answers");
    const connected = a.connect(200_000);
    await vi.waitFor(() => expect(offers[0]).toBe(1));
    // WebRTC is still trying: nothing native yet.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states[0].transport).toBeUndefined();
    await vi.advanceTimersByTimeAsync(90_000);
    await connected;
    await vi.waitFor(() => expect(states.map(s => [s.status, s.transport])).toEqual([["ready", "iroh/1"], ["ready", "iroh/1"]]));
  } finally { vi.useRealTimers(); }
});

it("stays off Iroh when the contact does not allow a fallback", async () => {
  const { links: [a], states } = await pair("rtc-no-fallback", "blocked");
  await a.setTransportPreference("webrtc/1", false);
  await expect(a.connect(3_000)).rejects.toThrow(/Could not connect|Timed out/);
  expect(states[0].transport).toBeUndefined();
});
