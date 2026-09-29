import { describe, expect, it, vi } from "vitest";
import { LinkSession } from "../src/link";
import { GhostLink } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { fromBase64Url } from "../src/bytes";
import { buildLinkRecords } from "../src/records";
import { signPairedSignal } from "../src/pairedSignal";
import { PairedSession } from "../src/pairedSession";
import { createChannelPair } from "./helpers";
import type { BoundChannel, NativeEndpoint } from "../src/pairedTransports";
// covers: chat.paired.session, chat.paired.status, core.peer-keys, transport.preference, chat.dht.send

describe("paired profile policy boundaries", () => {
  it("retains a real discovery read error until reading recovers", async () => {
    const read = vi.fn<() => Promise<null>>().mockRejectedValue(new Error("relay read unavailable"));
    const onDiscoveryError = vi.fn();
    const session = new LinkSession({ params: createLink().mine, getServices: () => [],
      transport: { publish: async () => {}, resolve: read, describe: () => ({ protocol: "test", relays: [] }) },
      events: { onDiscoveryError },
    });
    try {
      session.start();
      await vi.waitFor(() => expect(onDiscoveryError).toHaveBeenLastCalledWith("Could not read discovery: relay read unavailable"));
      await session.refreshAdvertisement();
      expect(onDiscoveryError).toHaveBeenLastCalledWith("Could not read discovery: relay read unavailable");
      read.mockResolvedValue(null);
      session.pollNow();
      await vi.waitFor(() => expect(onDiscoveryError).toHaveBeenLastCalledWith(null));
    } finally { await session.stop(false); }
  });
  it("cancels an obsolete native dial when the local preference changes", async () => {
    let complete!: (connection: BoundChannel) => void;
    const endpoint: NativeEndpoint = { transport: "iroh/1", descriptor: {}, onConnection: null, onDescriptor: null,
      close: async () => {}, connect: () => new Promise(resolve => { complete = resolve; }) };
    const onPairingState = vi.fn();
    const link = new GhostLink({ params: { ...createLink().mine, profile: "paired-chat/1" },
      pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn() },
      native: { preferred: "iroh/1", fallback: true, peerDescriptors: { "iroh/1": {} }, peerTransports: ["iroh/1", "webrtc/1"] },
      transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
      createPeerConnection: () => { throw new Error("No new dial expected"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: { onPairingState },
    });
    link.registerEndpoint(endpoint);
    const pending = link.connect().catch(error => error as Error);
    await link.setTransportPreference("webrtc/1", false);
    expect(await pending).toBeInstanceOf(Error);
    const [channel] = createChannelPair();
    const close = vi.spyOn(channel, "close");
    complete({ channel, binding: { transport: "iroh/1", context: "a".repeat(64), identities: ["a", "b"] } });
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(link.isDataLinkOpen).toBe(false);
    expect(onPairingState.mock.calls.some(([state]) => state.status === "error")).toBe(false);
    await link.stop(false);
  });
  it.each([false, true])("after the pin, drops discovery signed by a replacement key without a stop (tampered signature: %s)", async tampered => {
    // covers: chat.dht.key-change
    const invitation = createLink();
    const saved = createIdentity();
    const replacement = createIdentity();
    const credentials = { seedB64: createIdentity().seedB64, peerKey: saved.pubKeyZ32, requireSignedSignals: true };
    const signal = JSON.stringify({ t: "o", ts: Date.now(), u: "ufrag", p: "password", f: "a".repeat(64), s: "actpass", c: [] });
    const signed = signPairedSignal(signal, replacement.seedB64, invitation.mine.peerPubKeyZ32, invitation.invite.peerPubKeyZ32);
    const raw = JSON.parse(signed);
    if (tampered) raw.p = "tampered";
    const records = buildLinkRecords(invitation.mine.peerPubKeyZ32, {
      messages: [], ackTimestamp: 0, rtcSignal: JSON.stringify(raw),
    }, fromBase64Url(invitation.mine.encKeyB64)).records;
    const onPairingState = vi.fn(), onDhtDelivery = vi.fn(), createPeerConnection = vi.fn(() => { throw new Error("must not connect"); });
    const pinPeer = vi.fn();
    // The link's records are published under keys any copy of the invite derives: a signal there proves nothing.
    const resolve = vi.fn(async (key: string) => key === invitation.mine.peerPubKeyZ32 ? { pubKeyZ32: key, records, timestampMicros: BigInt(Date.now()) * 1000n } : null);
    const link = new GhostLink({ params: { ...invitation.mine, profile: "paired-chat/1" },
      pairing: { credentials, pinPeer },
      dht: { state: { sequence: 0, peerSequence: 0, peerMode: "stream" }, save: vi.fn(async () => {}) },
      transport: { publish: vi.fn(), resolve, describe: () => ({ protocol: "test", relays: [] }) },
      createPeerConnection, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: { onPairingState, onDhtDelivery },
    });
    try {
      link.session.start();
      await vi.waitFor(() => expect(resolve.mock.calls.some(([key]) => key === invitation.mine.peerPubKeyZ32)).toBe(true));
      if (!tampered) await vi.waitFor(() => expect(onDhtDelivery.mock.lastCall?.[0].foreignKeySeenAt).toBeGreaterThan(0));
      else await new Promise(resolve => setTimeout(resolve, 100));
      expect(onPairingState.mock.calls.some(([state]) => state.status === "error" || state.keyMismatch)).toBe(false);
      expect(createPeerConnection).not.toHaveBeenCalled();
      expect(pinPeer).not.toHaveBeenCalled();
      expect(credentials.peerKey).toBe(saved.pubKeyZ32);
      // Text still goes, over the DHT while no stream is up.
      expect(link.textDelivery).toBe("dht");
      expect(await link.sendMessage("still here")).toBeNull();
    } finally { await link.stop(false); }
  });
  /** A pinned chat with an Iroh endpoint, and the other end of a native connection run by `key`'s participation key. */
  function nativePair(inbound: boolean) {
    const saved = createIdentity(), params = { ...createLink().mine, profile: "paired-chat/1" as const };
    const credentials = { seedB64: createIdentity().seedB64, peerKey: saved.pubKeyZ32, requireSignedSignals: true };
    let dial!: (connection: BoundChannel) => void;
    const endpoint: NativeEndpoint = { transport: "iroh/1", descriptor: {}, onConnection: null, onDescriptor: null,
      close: async () => {}, connect: () => new Promise(resolve => { dial = resolve; }) };
    const onPairingState = vi.fn(), onDhtDelivery = vi.fn();
    const link = new GhostLink({ params, pairing: { credentials, pinPeer: vi.fn() },
      dht: { state: { sequence: 0, peerSequence: 0, peerMode: "stream" }, save: vi.fn(async () => {}) },
      native: { preferred: "iroh/1", fallback: true, peerDescriptors: { "iroh/1": {} }, peerTransports: ["iroh/1"] },
      transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
      rtcAvailable: false, createPeerConnection: () => { throw new Error("no WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: { onPairingState, onDhtDelivery },
    });
    link.registerEndpoint(endpoint);
    const [mine, theirs] = createChannelPair();
    const binding = { transport: "iroh/1" as const, context: "a".repeat(64), identities: ["b".repeat(64), "c".repeat(64)] as [string, string] };
    // Someone holding a copy of the invite, with a participation key of its own.
    const other = new PairedSession(theirs, { credentials: { seedB64: createIdentity().seedB64 }, rendezvousKeys: [params.peerPubKeyZ32, link.myPubKeyZ32], binding,
      transports: ["iroh/1"], trustOnFirstUse: true, pinPeer: async () => {}, onState: () => {}, onReady: () => {}, onApplication: () => {}, onFailure: () => {} });
    const close = vi.spyOn(mine, "close");
    const go = async () => {
      if (inbound) { endpoint.onConnection!({ channel: mine, binding }); other.start(); }
      else { const pending = link.connect().catch(() => {}); await vi.waitFor(() => expect(dial).toBeTypeOf("function")); dial({ channel: mine, binding }); other.start(); await pending; }
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
    };
    return { link, onPairingState, onDhtDelivery, go, stop: async () => { other.stop(); await link.stop(false); } };
  }
  it("a native connection dialled in with another key closes, and stops nothing: its address was readable with the invite", async () => {
    const p = nativePair(true);
    try {
      await p.go();
      // It did get as far as the other key (a passive warning), and no further.
      expect(p.onDhtDelivery.mock.lastCall?.[0].foreignKeySeenAt).toBeGreaterThan(0);
      expect(p.onPairingState.mock.calls.some(([state]) => state.status === "error" || state.keyMismatch)).toBe(false);
      expect(p.link.isDataLinkOpen).toBe(false);
      expect(p.link.textDelivery).toBe("dht");
    } finally { await p.stop(); }
  });
  it("a native connection this side dialled that authenticates another key still stops the chat on both layers", async () => {
    const p = nativePair(false);
    try {
      await p.go();
      await vi.waitFor(() => expect(p.onPairingState.mock.calls.some(([state]) => state.keyMismatch)).toBe(true));
      expect(p.link.textDelivery).toBe("unavailable");
      expect(await p.link.sendMessage("blocked")).not.toBeNull();
    } finally { await p.stop(); }
  });
  it("reports failed discovery publication when explicitly requested", async () => {
    const session = new LinkSession({ params: createLink().mine,
      transport: { publish: async () => { throw new Error("Discovery unavailable"); }, resolve: async () => null,
        describe: () => ({ protocol: "test", relays: [] }) } });
    await expect(session.setRtcSignal("offer", true)).rejects.toThrow("Discovery unavailable");
    await expect(session.setRtcSignal("legacy offer")).resolves.toBeUndefined();
  });
  it("does not publish chat, call signaling, files or payment payloads to the bootstrap", async () => {
    const publish=vi.fn();
    const link=new GhostLink({params:{...createLink().mine,profile:"paired-chat/1"},
      pairing:{credentials:{seedB64:createIdentity().seedB64},pinPeer:vi.fn()},
      transport:{publish,resolve:async()=>null,describe:()=>({protocol:"test",relays:[]})},
      createPeerConnection:()=>{throw new Error("not available");},localFetch:vi.fn(),getServices:()=>[],getHostedHttpService:()=>undefined});
    expect(await link.sendMessage("private text")).toMatch(/never falls back/);
    // Calls are a paired capability of their own now (calls/1): without a live session a signal is refused.
    await expect(link.setCallSignal("private signal")).rejects.toThrow(/not available in this app/);
    // Shared services travel over the paired session now (paired-services / ph frames), so a
    // request is no longer refused as out-of-profile: without a data link it fails, and never
    // reaches the bootstrap.
    await expect(link.request("private-service",{method:"GET",path:"/"})).rejects.toThrow();
    // Payments are a paired capability of their own now (payments/1), so this is
    // no longer refused as out-of-profile. It must still fail without a data
    // link, and — the point of this test — never reach the bootstrap.
    await expect(link.sendPaymentRequest({id:"test",timestamp:1,amount:{value:"1",asset:"sat"},endpoints:[]})).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});

it.each([false, true])("new DHT-only invites never dial or advertise streams (fallback %s)", async fallback => {
  const publish = vi.fn(async () => {}), resolve = vi.fn(async () => null);
  const rtc = vi.fn(() => { throw new Error("RTC must not run"); });
  const dial = vi.fn(), close = vi.fn(async () => {});
  const link = new GhostLink({ params: { ...createLink().mine, profile: "paired-chat/1", deliveryMode: "dht" },
    pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn() },
    dht: { save: vi.fn(async () => {}) },
    native: { preferred: "iroh/1", fallback, peerDescriptors: { "iroh/1": {} }, peerTransports: ["iroh/1"] },
    transport: { publish, resolve, describe: () => ({ protocol: "fixture", relays: [] }) },
    createPeerConnection: rtc, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const startDiscovery = vi.spyOn(link.session, "start");
  link.registerEndpoint({ transport: "iroh/1", descriptor: {}, onConnection: null, onDescriptor: null, connect: dial, close });
  try {
    link.start();
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    await expect(link.connect()).rejects.toThrow(/DHT/i);
    expect(await link.sendMessage("new invitation text")).toBeNull();
    expect(link.textDelivery).toBe("dht");
    expect(link.supportsPayments).toBe(false);
    expect(startDiscovery).not.toHaveBeenCalled();
    expect(rtc).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled(); expect(close).toHaveBeenCalled();
    for (const [, records] of publish.mock.calls as unknown as [unknown, { label: string }[]][]) {
      expect(records.every(record => record.label === "_dm" || record.label === "_dmk")).toBe(true);
    }
  } finally { await link.stop(false); }
});
