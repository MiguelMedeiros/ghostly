import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createIdentity, identityFromSeed, publicKeyFromZ32, sign, verify } from "../src/identity";
import { fromBase64Url, randomBytes, toBase64Url, toZ32, utf8Encode } from "../src/bytes";
import { PairedSession, type PairedSessionOptions, type PairingCredentials, type PairingState } from "../src/pairedSession";
import { fitSignedPairedSignal, fitSignedPairedSignalWith, signPairedSignal, signPairedSignalWith, verifyPairedSignal } from "../src/pairedSignal";
import { seedSigner, webCryptoSigner, type Signer } from "../src/signer";
import { DEVICES_CAPABILITY, deviceEchoFrame, deviceEchoNonce, deviceLinkPairing, deviceLinkParams, devicePingFrame, signDeviceTransports, verifyDeviceTransports, type DeviceFrame } from "../src/deviceLink";
import { encodePacketTransports } from "../src/capsRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "./support/pairingWorld";
import { NativeWorld } from "./support/nativeWorld";
import { createChannelPair } from "./helpers";
// covers: devices.links.session, devices.signing-key

/*
 * Device links (WISP 06 § Terms): a paired session between two of a person's devices, on keys both derive from the
 * device-set secret `D` and the two device signing keys, pinned to those keys with trust on first use off, and signed
 * through a signer, since the app may hold no seed for a device signing key. Every key here is made in the test.
 */

/** A non-extractable WebCrypto Ed25519 key, as a device makes one where the engine has it. */
async function webCryptoDevice(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  return webCryptoSigner(pair.privateKey, new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
}
const seedDevice = (): Signer => seedSigner(randomBytes(32));

describe("a paired session that signs through a signer", () => {
  const active: PairedSession[] = [];
  afterEach(() => { active.splice(0).forEach((s) => s.stop()); });
  const rendezvousKeys: [string, string] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
  const fingerprints: [string, string] = ["a".repeat(64), "b".repeat(64)];

  function pair(credentials: [PairingCredentials, PairingCredentials], options: Partial<PairedSessionOptions> = {}) {
    const [ac, bc] = createChannelPair();
    const sent: Record<string, unknown>[][] = [[], []];
    [ac, bc].forEach((channel, i) => {
      const send = channel.send.bind(channel);
      channel.send = (data) => { if (typeof data === "string") sent[i].push(JSON.parse(data) as Record<string, unknown>); send(data); };
    });
    const pinned = [vi.fn(async (_key: string) => {}), vi.fn(async (_key: string) => {})];
    const states: PairingState[][] = [[], []];
    const config = (i: number): PairedSessionOptions => ({
      credentials: credentials[i], rendezvousKeys, fingerprints, trustOnFirstUse: false,
      pinPeer: pinned[i], onState: (state) => { states[i].push(state); }, onReady: vi.fn(), onApplication: vi.fn(), onFailure: vi.fn(), ...options,
    });
    const a = new PairedSession(ac, config(0)), b = new PairedSession(bc, config(1));
    active.push(a, b); a.start(); b.start();
    return { a, b, sent, pinned, states };
  }

  /** The transcript both sides sign, built from the two offers as they went over the channel (`PairedSession.receive`). */
  function transcriptOf(offers: Record<string, unknown>[]): Uint8Array {
    const tuple = (o: Record<string, unknown>) => [o.key, o.nonce, o.versions, o.transports, o.capabilities];
    const sorted = [...offers].sort((x, y) => (x.key as string) < (y.key as string) ? -1 : 1).map(tuple);
    return utf8Encode(JSON.stringify(["ghostly-paired-chat", 1, [...rendezvousKeys].sort(), [...fingerprints].sort(), sorted, [1, "webrtc/1", "chat/1", "no-dht-payload"]]));
  }

  it("a seed behind the signer signs the bytes the raw seed signs: the same offer key and the same proof", async () => {
    const seedA = randomBytes(32), seedB = randomBytes(32);
    const keyA = identityFromSeed(seedA).pubKeyZ32, keyB = identityFromSeed(seedB).pubKeyZ32;
    // A as every chat is today (its raw seed); B through the signer, with no seed in its credentials.
    const p = pair([{ seedB64: toBase64Url(seedA), peerKey: keyB }, { seedB64: "", signer: seedSigner(seedB), peerKey: keyA }]);
    await vi.waitFor(() => { expect(p.a.state.status).toBe("ready"); expect(p.b.state.status).toBe("ready"); });
    const offers = [p.sent[0].find((f) => f.t === "pair-offer")!, p.sent[1].find((f) => f.t === "pair-offer")!];
    expect(offers.map((o) => o.key)).toEqual([keyA, keyB]);
    const transcript = transcriptOf(offers);
    expect(p.sent[0].find((f) => f.t === "pair-proof")!.sig).toBe(toBase64Url(sign(transcript, seedA)));
    expect(p.sent[1].find((f) => f.t === "pair-proof")!.sig).toBe(toBase64Url(sign(transcript, seedB)));
    expect(p.a.state.peerKey).toBe(keyB);
    expect(p.b.state.peerKey).toBe(keyA);
  });

  it("two non-extractable WebCrypto keys, each pinned by the other, authenticate with no code to compare", async () => {
    const a = await webCryptoDevice(), b = await webCryptoDevice();
    const p = pair([{ seedB64: "", signer: a, peerKey: toZ32(b.publicKey) }, { seedB64: "", signer: b, peerKey: toZ32(a.publicKey) }]);
    await vi.waitFor(() => { expect(p.a.state.status).toBe("ready"); expect(p.b.state.status).toBe("ready"); });
    expect(p.states.flat().some((s) => s.status === "confirm")).toBe(false);
    const offers = [p.sent[0].find((f) => f.t === "pair-offer")!, p.sent[1].find((f) => f.t === "pair-offer")!];
    // Trust on first use is off: neither offer says `tofu/1`.
    for (const offer of offers) expect(offer.capabilities).not.toContain("tofu/1");
    const transcript = transcriptOf(offers);
    expect(verify(fromBase64Url(p.sent[0].find((f) => f.t === "pair-proof")!.sig as string), transcript, a.publicKey)).toBe(true);
    expect(verify(fromBase64Url(p.sent[1].find((f) => f.t === "pair-proof")!.sig as string), transcript, b.publicKey)).toBe(true);
    expect(p.pinned[0]).toHaveBeenCalledWith(toZ32(b.publicKey), true);
  });

  it("a key that is not the pinned one is refused, whatever it signs", async () => {
    const a = await webCryptoDevice(), b = await webCryptoDevice(), expected = seedDevice();
    const p = pair([{ seedB64: "", signer: a, peerKey: toZ32(expected.publicKey) }, { seedB64: "", signer: b, peerKey: toZ32(a.publicKey) }]);
    await vi.waitFor(() => expect(p.a.state.status).toBe("error"));
    expect(p.a.state.keyMismatch).toBe(true);
    expect(p.pinned[0]).not.toHaveBeenCalled();
    expect(p.b.state.status).not.toBe("ready");
  });

  it("with trust on first use off, a key nobody pinned is never admitted by itself", async () => {
    const a = seedDevice(), b = seedDevice();
    const p = pair([{ seedB64: "", signer: a }, { seedB64: "", signer: b }]);
    await vi.waitFor(() => { expect(p.a.state.status).toBe("confirm"); expect(p.b.state.status).toBe("confirm"); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(p.a.state.status).toBe("confirm");
    expect(p.pinned[0]).not.toHaveBeenCalled();
    expect(p.pinned[1]).not.toHaveBeenCalled();
  });
});

describe("a discovery signal signed through a signer", () => {
  const from = createIdentity().pubKeyZ32, to = createIdentity().pubKeyZ32;
  const signal = JSON.stringify({ t: "o", ts: 100, u: "ufrag", p: "password", f: "a".repeat(64), s: "actpass", c: ["h,192.0.2.1,5000", "h,192.0.2.2,5000", "s,203.0.113.1,5000", "r,203.0.113.3,5000"] });

  it("is the signal the raw seed signs, byte for byte, and loses the same candidates when it must fit", async () => {
    const seed = randomBytes(32), signer = seedSigner(seed);
    expect(await signPairedSignalWith(signal, signer, from, to)).toBe(signPairedSignal(signal, toBase64Url(seed), from, to));
    for (const room of [4, 3, 2, 1]) {
      const fits = (signed: string) => (JSON.parse(signed) as { c: string[] }).c.length <= room;
      expect(await fitSignedPairedSignalWith(signal, signer, from, to, fits)).toBe(fitSignedPairedSignal(signal, toBase64Url(seed), from, to, fits));
    }
    await expect(fitSignedPairedSignalWith(signal, signer, from, to, () => false)).rejects.toThrow("exceed the discovery packet budget");
  });

  it("from a non-extractable key verifies under that key and under no other", async () => {
    const device = await webCryptoDevice();
    const signed = await signPairedSignalWith(signal, device, from, to);
    expect(verifyPairedSignal(signed, from, to, toZ32(device.publicKey), true)).not.toBeNull();
    expect(verifyPairedSignal(signed, from, to, toZ32(seedDevice().publicKey), true)).toBeNull();
    expect(verifyPairedSignal(signed, to, from, toZ32(device.publicKey), true)).toBeNull();
  });
});

interface Device { name: string; link: GhostLink; states: PairingState[]; frames: DeviceFrame[]; agreed: string[][] }
let pkarr: MemoryPkarr;
const opened: GhostLink[] = [];

/** One end of a device link, as the device-link-only engine opens it (`packages/browser/src/devices/links.ts`). */
function open(name: string, d: Uint8Array, me: Signer, peerKey: Uint8Array, options: { capabilities?: boolean; echo?: boolean } = {}): Device {
  const states: PairingState[] = [], frames: DeviceFrame[] = [], agreed: string[][] = [];
  const link: GhostLink = new GhostLink({
    ...deviceLinkPairing(d, me, peerKey),
    ...(options.capabilities === false ? {} : { deviceCapabilities: [DEVICES_CAPABILITY] }),
    native: { automatic: true },
    transport: pkarr.transport(),
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: {
      onPairingState: (state) => { states.push(state); },
      onDeviceCapabilities: (now) => { agreed.push(now); },
      onDeviceFrame: (frame) => {
        frames.push(frame);
        const echo = options.echo === false ? null : deviceEchoFrame(frame);
        if (echo) link.sendDeviceFrame(echo);
      },
    },
  });
  opened.push(link);
  link.start();
  return { name, link, states, frames, agreed };
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); await yieldToLoop(); }
}
const live = (device: Device) => device.link.isDataLinkOpen && device.link.supportsDevice(DEVICES_CAPABILITY);
async function untilLive(devices: Device[], limit: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (devices.every(live)) return true;
    await run(250);
  }
  return devices.every(live);
}

describe("a device link", () => {
  beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); });
  afterEach(async () => {
    const stopping = Promise.all(opened.splice(0).map((link) => link.stop(false)));
    await run(3_000);
    await stopping;
    await closeWorld();
  });

  it("joins two devices that never met: both derive it from D, each pins the other's signing key, and a ping is echoed", async () => {
    const d = randomBytes(32), desktop = seedDevice(), phone = await webCryptoDevice();
    const a = open("desktop", d, desktop, phone.publicKey), b = open("phone", d, phone, desktop.publicKey);
    expect(await untilLive([a, b], 60_000)).toBe(true);
    // Pinned and counted as verified from the first session: the key is the one the turn record names.
    for (const [side, peer] of [[a, phone], [b, desktop]] as const) {
      const ready = [...side.states].reverse().find((s) => s.status === "ready")!;
      expect(ready.peerKey).toBe(toZ32(peer.publicKey));
      expect(ready.verified).toBe(true);
      expect(side.states.some((s) => s.status === "confirm")).toBe(false);
      expect(side.agreed.at(-1)).toEqual([DEVICES_CAPABILITY]);
    }
    const ping = devicePingFrame();
    a.link.sendDeviceFrame(ping);
    await run(1_000);
    expect(b.frames).toEqual([ping]);
    expect(a.frames.map(deviceEchoNonce)).toEqual([ping.n]);
  });

  it("is published under keys derived from D alone: the packets carry signals signed by the device signing keys", async () => {
    const d = randomBytes(32), desktop = seedDevice(), phone = seedDevice();
    const a = open("desktop", d, desktop, phone.publicKey), b = open("phone", d, phone, desktop.publicKey);
    expect(a.link.myPubKeyZ32).toBe(deviceLinkParams(d, phone.publicKey, desktop.publicKey).peerPubKeyZ32);
    expect(b.link.myPubKeyZ32).toBe(deviceLinkParams(d, desktop.publicKey, phone.publicKey).peerPubKeyZ32);
    expect(await untilLive([a, b], 60_000)).toBe(true);
    expect([...pkarr.publishesByKey.keys()].sort()).toEqual([a.link.myPubKeyZ32, b.link.myPubKeyZ32].sort());
  });

  it("three devices have a link between every two of them", async () => {
    const d = randomBytes(32), keys = [seedDevice(), await webCryptoDevice(), seedDevice()];
    const links: Device[] = [];
    for (let i = 0; i < keys.length; i++) for (let j = 0; j < keys.length; j++) if (i !== j) links.push(open(`device-${i}-${j}`, d, keys[i], keys[j].publicKey));
    expect(await untilLive(links, 90_000)).toBe(true);
    expect(new Set(links.map((l) => l.link.myPubKeyZ32)).size).toBe(6);
  });

  it("a device that no longer holds the current D derives no link the others answer", async () => {
    const oldD = randomBytes(32), newD = randomBytes(32);
    const desktop = seedDevice(), phone = seedDevice(), removed = seedDevice();
    // The set moved to a new D; the removed device still holds the old one, its own key and the others' keys.
    const a = open("desktop", newD, desktop, phone.publicKey), b = open("phone", newD, phone, desktop.publicKey);
    const stale = [open("removed-desktop", oldD, removed, desktop.publicKey), open("removed-phone", oldD, removed, phone.publicKey)];
    expect(await untilLive([a, b], 60_000)).toBe(true);
    await run(120_000);
    for (const link of stale) {
      expect(link.link.isDataLinkOpen).toBe(false);
      expect(link.states.some((s) => s.status === "ready")).toBe(false);
      // Nobody publishes at the key it looks for, and nobody reads the key it publishes at.
      const peerKey = (link.link as unknown as { options: { params: { peerPubKeyZ32: string } } }).options.params.peerPubKeyZ32;
      expect(pkarr.publishesByKey.has(peerKey)).toBe(false);
      expect([a, b].some((d2) => (d2.link as unknown as { options: { params: { peerPubKeyZ32: string } } }).options.params.peerPubKeyZ32 === link.link.myPubKeyZ32)).toBe(false);
    }
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
  });

  it("a holder of D without a device signing key of the set gets no session: it can sit at the rendezvous, and nothing it signs is taken", async () => {
    const d = randomBytes(32), desktop = seedDevice(), phone = seedDevice(), intruder = seedDevice();
    // The intruder computes the phone's side of the link from D and the two public keys, and signs with a key of its own.
    const a = open("desktop", d, desktop, phone.publicKey);
    const forged = deviceLinkPairing(d, intruder, desktop.publicKey);
    const states: PairingState[] = [], frames: DeviceFrame[] = [];
    const x: GhostLink = new GhostLink({
      ...forged, params: deviceLinkParams(d, phone.publicKey, desktop.publicKey), deviceCapabilities: [DEVICES_CAPABILITY],
      native: { automatic: true }, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, autoConnect: true,
      createPeerConnection: () => fakePeerConnection("intruder"), localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
      events: { onPairingState: (state) => { states.push(state); }, onDeviceFrame: (frame) => { frames.push(frame); } },
    });
    opened.push(x); x.start();
    expect(x.myPubKeyZ32).toBe((a.link as unknown as { options: { params: { peerPubKeyZ32: string } } }).options.params.peerPubKeyZ32);
    await run(120_000);
    expect(live(a)).toBe(false);
    expect(a.link.isDataLinkOpen).toBe(false);
    expect(a.states.some((s) => s.status === "ready" || s.status === "waiting" || s.status === "confirm")).toBe(false);
    expect(states.some((s) => s.status === "ready")).toBe(false);
    expect(a.frames).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("carries device frames only under a capability both ends announced: a link that offers none drops them and sends none", async () => {
    const d = randomBytes(32), desktop = seedDevice(), phone = seedDevice();
    // The same keys and pins, and one end that announces nothing: what a chat or a group's link is to a device frame.
    const a = open("desktop", d, desktop, phone.publicKey), b = open("phone", d, phone, desktop.publicKey, { capabilities: false });
    const start = Date.now();
    while (Date.now() - start < 60_000 && !(a.link.isDataLinkOpen && b.link.isDataLinkOpen)) await run(250);
    await run(2_000);
    expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true);
    expect(a.link.supportsDevice(DEVICES_CAPABILITY)).toBe(false);
    expect(b.link.supportsDevice(DEVICES_CAPABILITY)).toBe(false);
    expect(() => a.link.sendDeviceFrame(devicePingFrame())).toThrow("not connected");
    expect(() => b.link.sendDeviceFrame(devicePingFrame())).toThrow("not connected");
    // Put on the channel all the same, in both directions: neither end hands one on.
    const raw = (device: Device) => (device.link as unknown as { channel: { send(data: string): void } }).channel;
    raw(a).send(JSON.stringify(devicePingFrame()));
    raw(b).send(JSON.stringify(devicePingFrame()));
    raw(b).send(JSON.stringify({ t: "set-update", d: "x" }));
    await run(1_000);
    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
    expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true);
  });

  it("offers only what it was given: a frame of a capability this part does not offer is not sent and not handed on", async () => {
    const d = randomBytes(32), desktop = seedDevice(), phone = seedDevice();
    const a = open("desktop", d, desktop, phone.publicKey), b = open("phone", d, phone, desktop.publicKey);
    expect(await untilLive([a, b], 60_000)).toBe(true);
    expect(() => a.link.sendDeviceFrame({ t: "handoff-hello", v: 1 })).toThrow("not connected");
    expect(() => a.link.sendDeviceFrame({ t: "enroll-hello" })).toThrow("not connected");
    expect(() => a.link.sendDeviceFrame({ t: "paired-message" })).toThrow("not connected");
    (a.link as unknown as { channel: { send(data: string): void } }).channel.send(JSON.stringify({ t: "handoff-hello", v: 1 }));
    await run(1_000);
    expect(b.frames).toEqual([]);
    // `set-` frames travel under devices/1, which is agreed: the envelope the removal part fills.
    a.link.sendDeviceFrame({ t: "set-ack" });
    await run(1_000);
    expect(b.frames).toEqual([{ t: "set-ack" }]);
  });

  it("has no DHT delivery: a link that signs through a signer refuses one", () => {
    const d = randomBytes(32), desktop = seedDevice(), phone = seedDevice();
    const make = (extra: object) => new GhostLink({
      ...deviceLinkPairing(d, desktop, phone.publicKey), transport: pkarr.transport(), createPeerConnection: () => fakePeerConnection("desktop"),
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined, ...extra,
    });
    expect(() => make({ dht: { save: async () => {} } })).toThrow("no DHT delivery");
    const pairing = deviceLinkPairing(d, desktop, phone.publicKey);
    expect(() => make({ params: { ...pairing.params, deliveryMode: "dht" } })).toThrow("no DHT delivery");
    expect(publicKeyFromZ32(pairing.pairing.credentials.peerKey!)).toEqual(phone.publicKey);
    expect(pairing.pairing.trustOnFirstUse).toBe(false);
  });
});

describe("a device link's transports in its packet (`_tr`)", () => {
  const from = createIdentity().pubKeyZ32, to = createIdentity().pubKeyZ32;
  const value = encodePacketTransports(["iroh/1"], { "iroh/1": { id: "a".repeat(64), relay: "https://relay.test./", addresses: [] } });

  it("is signed by the device signing key, over both rendezvous keys, and read back only under that key", async () => {
    const device = seedDevice(), other = seedDevice();
    const signed = await signDeviceTransports(value, device, from, to);
    expect(verifyDeviceTransports(signed, from, to, device.publicKey)).toBe(value);
    expect(verifyDeviceTransports(signed, from, to, other.publicKey)).toBeNull();
    expect(verifyDeviceTransports(signed, to, from, device.publicKey)).toBeNull();
    expect(verifyDeviceTransports(value, from, to, device.publicKey)).toBeNull();
    const tampered = JSON.parse(signed) as { t: string[] };
    tampered.t = ["iroh/1", "webrtc/1"];
    expect(verifyDeviceTransports(JSON.stringify(tampered), from, to, device.publicKey)).toBeNull();
    expect(verifyDeviceTransports("not json", from, to, device.publicKey)).toBeNull();
  });

  describe("on a link with no WebRTC", () => {
    let native: NativeWorld;
    beforeEach(() => { useFakeWorld(); pkarr = new MemoryPkarr(DESKTOP_NETWORK); native = new NativeWorld(); native.hexIds = true; });
    afterEach(async () => {
      const stopping = Promise.all(opened.splice(0).map((link) => link.stop(false)));
      await run(3_000);
      await stopping;
      await closeWorld();
    });

    /** One end, native only, as the device links of an app with no WebRTC run (the Linux Desktop). */
    function openNative(name: string, params: ReturnType<typeof deviceLinkPairing>, said: string[][]) {
      const states: PairingState[] = [];
      const link: GhostLink = new GhostLink({
        ...params, deviceCapabilities: [DEVICES_CAPABILITY], rtcAvailable: false, native: { automatic: true }, packetTransports: true,
        transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, autoConnect: true,
        createPeerConnection: () => { throw new ReferenceError("RTCPeerConnection is not defined"); },
        localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
        events: { onPairingState: (state) => { states.push(state); }, onPacketTransports: (transports) => { said.push(transports); } },
      });
      opened.push(link);
      link.start();
      link.registerEndpoint(native.endpoint("iroh/1", name));
      return { link, states };
    }

    it("goes live on the transports each device signed", async () => {
      const d = randomBytes(32), desktop = seedDevice(), phone = await webCryptoDevice();
      const heard: string[][] = [];
      const a = openNative("desktop", deviceLinkPairing(d, desktop, phone.publicKey), heard);
      const b = openNative("phone", deviceLinkPairing(d, phone, desktop.publicKey), []);
      for (let i = 0; i < 480 && !(a.link.isDataLinkOpen && b.link.supportsDevice(DEVICES_CAPABILITY)); i++) await run(250);
      expect(a.link.supportsDevice(DEVICES_CAPABILITY) && b.link.supportsDevice(DEVICES_CAPABILITY)).toBe(true);
      expect(heard[0]).toEqual(["iroh/1"]);
    });

    it("ignores transports a holder of D wrote in the other device's packet, dials none of them, and goes live once the device itself says its own", async () => {
      const d = randomBytes(32), desktop = seedDevice(), phone = seedDevice(), intruder = seedDevice();
      const heard: string[][] = [];
      const a = openNative("desktop", deviceLinkPairing(d, desktop, phone.publicKey), heard);
      // The intruder holds D: it publishes at the phone's rendezvous key, with an endpoint of its own, signed by its own key.
      const forged = { ...deviceLinkPairing(d, intruder, desktop.publicKey), params: deviceLinkParams(d, phone.publicKey, desktop.publicKey) };
      const x = openNative("intruder", forged, []);
      expect(x.link.myPubKeyZ32).toBe((a.link as unknown as { options: { params: { peerPubKeyZ32: string } } }).options.params.peerPubKeyZ32);
      await run(120_000);
      expect(heard).toEqual([]);
      // The desktop dials none of the intruder's endpoints. The intruder may dial the desktop (it reads the desktop's
      // own signed `_tr`, which is genuine), and is refused there: whether it does depends on which side dials first.
      expect(native.dialsBy.get("desktop") ?? 0).toBe(0);
      expect(a.link.isDataLinkOpen).toBe(false);
      expect(a.states.some((s) => s.keyMismatch)).toBe(false);
      expect((a.link as unknown as { keyStopped: boolean }).keyStopped).toBe(false);

      // The intruder goes, and the phone comes: its signed transports are taken at once, and the link goes live.
      await x.link.stop(false);
      opened.splice(opened.indexOf(x.link), 1);
      const b = openNative("phone", deviceLinkPairing(d, phone, desktop.publicKey), []);
      for (let i = 0; i < 480 && !(a.link.supportsDevice(DEVICES_CAPABILITY) && b.link.supportsDevice(DEVICES_CAPABILITY)); i++) await run(250);
      expect(a.link.supportsDevice(DEVICES_CAPABILITY)).toBe(true);
      // Only what the phone signed was ever taken. The desktop may have gone live on the phone's dial before it read
      // the phone's packet, so it need not have heard it yet.
      expect(heard.every((said) => said.length === 1 && said[0] === "iroh/1")).toBe(true);
    });
  });
});
