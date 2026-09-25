import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFiles, GhostLink, createIdentity, createLink, identityFromSeedB64, type FileTransferRecord, type IncomingTarget, type PairingState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { fileStore } from "../src/shared/idb";
import { pathSnapshot, trim, withSend } from "../src/engine/messageDetails";
import { MESSAGE_DETAILS_MAX_BYTES, MESSAGE_DETAILS_MAX_SENDS, type MessageDetails } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.paired.message-details

/**
 * What the engine remembers about a message's travels (WISP 400 § Message details): a real node (the app) and its
 * contact's link over a stand-in for Iroh. A text sent gets its path, frame, sizes and the receipt's time; a text
 * received gets where it came from; a file gets its protocol, chunks, digest and completion. The view the UI asks
 * for puts it together with the chat's public keys, and never a seed.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const SEEDS: string[] = [];

async function setup() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  SEEDS.push(mine, theirs, invitation.mine.seedB64, invitation.invite.seedB64);
  const id = `details-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" }, "hyperdht/1": { id: "contact:hyperdht/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app"), "hyperdht/1": async () => net.endpoint("hyperdht/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: string[] = [];
  // The contact takes files with files/3 and hashes what it gets.
  const received = new Map<string, { hash: ReturnType<typeof createHash>; length: number }>();
  const records = new Map<string, FileTransferRecord>();
  const peer: { link?: GhostLink } = {};
  const files = new ChatFiles({
    send: (frame) => peer.link?.sendFilesFrame(frame) ?? false,
    decide: async () => "accept",
    openTarget: async (record): Promise<IncomingTarget> => {
      const disk = received.get(record.id) ?? { hash: createHash("sha256"), length: 0 };
      received.set(record.id, disk);
      return { offset: disk.length, append: async (bytes) => { disk.hash.update(bytes); disk.length += bytes.length; }, flush: async () => {},
        verify: async (digest) => disk.hash.copy().digest("base64url") === digest, discard: async () => { received.delete(record.id); } };
    },
    openSource: async () => { throw new Error("The contact sends no files here"); },
    changed: (record) => { records.set(`${record.direction}:${record.id}`, record); },
    room: async () => 50 * 1024 ** 3,
  });
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false, largeFilesSupport: true,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true,
      peerDescriptors: { "iroh/1": { id: "app:iroh/1" }, "hyperdht/1": { id: "app:hyperdht/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message.text); },
      onFilesFrame: (frame) => files.handle(frame), onFilesSession: (open) => { if (open) files.attach(); else files.detach(); } },
  });
  peer.link = contact;
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  contact.registerEndpoint(net.endpoint("hyperdht/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(2));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, view().pairing?.transport, contactState.status]).toEqual(["ready", "iroh/1", "ready"]));
  await vi.waitFor(() => expect(view().capabilities?.largeFiles).toBe(true), { timeout: 10_000 });
  const messages = () => db.getMessages(id);
  return { net, node, contact, id, view, contactGot, messages, records, myKey: identityFromSeedB64(mine).pubKeyZ32, peerKey: identityFromSeedB64(theirs).pubKeyZ32 };
}

describe("a text over the live link", () => {
  it("is remembered with its path, frame, sizes and the receipt's time, on both sides", async () => {
    const t = await setup();
    const before = Date.now();
    expect((await t.node.sendMessage({ linkId: t.id, text: "how did this travel?" })).error).toBeNull();
    await vi.waitFor(() => expect(t.contactGot).toEqual(["how did this travel?"]));
    await vi.waitFor(async () => expect((await t.messages()).find(m => m.sender === "me")?.delivery).toBe("delivered"));
    const mine = (await t.messages()).find(m => m.sender === "me")!;
    await vi.waitFor(async () => expect((await t.messages()).find(m => m.sender === "me")?.details?.receiptAt).toBeDefined());
    const sent = (await t.messages()).find(m => m.sender === "me")!;
    expect(sent.details).toMatchObject({
      attempts: 1,
      sends: [{ path: "iroh/1", relayed: false, result: "sent" }],
      wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes: 20 },
    });
    const d = sent.details!;
    expect(d.sends![0].at).toBeGreaterThanOrEqual(before);
    expect(d.sentAt).toBe(d.sends![0].at);
    expect(d.receiptAt!).toBeGreaterThanOrEqual(d.sentAt!);
    // The frame on the wire holds the id, the time and the text.
    expect(d.wire!.wireBytes).toBe(JSON.stringify({ t: "paired-message", id: mine.wireId, ts: mine.timestamp, m: mine.text }).length);

    expect(await t.contact.sendMessage("and this one?")).toBeNull();
    await vi.waitFor(async () => expect((await t.messages()).find(m => m.sender === "peer")).toBeDefined());
    const theirs = (await t.messages()).find(m => m.sender === "peer")!;
    expect(theirs.details).toMatchObject({ received: { path: "iroh/1", relayed: false }, wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes: 13 } });
    expect(theirs.details!.received!.at).toBeGreaterThanOrEqual(theirs.timestamp - 1_000);

    // The view the UI asks for: the record, the chat's public keys, what the session is right now.
    const view = (await t.node.messageDetails({ linkId: t.id, messageId: sent.id }))!;
    expect(view).toMatchObject({
      message: { id: sent.id, wireId: sent.wireId, kind: "text", textBytes: 20, delivery: "delivered", via: "datalink" },
      details: { sends: [{ path: "iroh/1" }] },
      link: { id: t.id, profile: "paired-chat/1", myKey: t.myKey, peerKey: t.peerKey, verified: false, transportNow: "iroh/1", relayedNow: false },
    });
    const json = JSON.stringify(view);
    for (const seed of SEEDS) expect(json).not.toContain(seed);
    expect(await t.node.messageDetails({ linkId: t.id, messageId: "nothing" })).toBeNull();
  }, 20_000);
});

describe("a file with files/3", () => {
  it("is remembered with its protocol, chunks, digest and the moment it was all there", async () => {
    const t = await setup();
    const size = 40_000, wireId = "details-file-01";
    const bytes = new Uint8Array(size).map((_, i) => i % 251);
    const file = { id: `${t.id}-out-${wireId}`, name: "haunted house.bin", size, mime: "application/octet-stream" };
    await fileStore.put({ id: file.id, linkId: t.id, blob: new Blob([bytes as BlobPart]), createdAt: 1, direction: "out", wireId,
      metadata: { name: file.name, size, mime: file.mime, timestamp: 5 } });
    t.node.sendFile({ linkId: t.id, file, timestamp: 5 });
    await vi.waitFor(() => expect(t.node.getState().transfers[file.id]).toMatchObject({ state: "done" }), { timeout: 30_000 });
    await vi.waitFor(async () => expect((await t.messages()).find(m => m.file?.id === file.id)?.details?.completedAt).toBeDefined());
    const message = (await t.messages()).find(m => m.file?.id === file.id)!;
    expect(message.details).toMatchObject({
      attempts: 1,
      sends: [{ path: "iroh/1", relayed: false, result: "sent" }],
      wire: { frame: "pf-offer + pf-data", protocol: "files/3", plaintextBytes: size, chunks: Math.ceil(size / 16_384), chunkBytes: 16_384 },
    });
    expect(message.details!.receiptAt).toBe(message.details!.completedAt);
    const view = (await t.node.messageDetails({ linkId: t.id, messageId: message.id }))!;
    expect(view.message.kind).toBe("file");
    expect(view.file).toMatchObject({ name: "haunted house.bin", size, mime: "application/octet-stream", protocol: "files/3", state: "done", confirmed: size, storage: "blob" });
    expect(view.file!.digest).toMatch(/^[a-f0-9]{64}$|^[A-Za-z0-9_-]{43}$/);
  }, 40_000);
});

describe("the record's bounds", () => {
  const send = (at: number): MessageDetails["sends"] extends (infer S)[] | undefined ? S : never => ({ at, path: "webrtc/1", relayed: false, result: "sent" });

  it("keeps the first send and the last ones, and counts them all", () => {
    let details: MessageDetails | undefined;
    for (let i = 0; i < 10; i++) details = withSend(details, send(i));
    expect(details!.attempts).toBe(10);
    expect(details!.sends!.map(s => s.at)).toEqual([0, 5, 6, 7, 8, 9]);
    expect(details!.sends).toHaveLength(MESSAGE_DETAILS_MAX_SENDS);
  });

  it("never grows past its budget", () => {
    const relays = Array.from({ length: 40 }, (_, i) => `relay-${i}.example.com`);
    let details: MessageDetails = { wire: { frame: "paired-message", protocol: "chat/1" } };
    for (let i = 0; i < 6; i++) details = withSend(details, { at: i, path: "iroh/1", relayed: true, relays, result: "sent" });
    expect(JSON.stringify(trim(details)).length).toBeLessThanOrEqual(MESSAGE_DETAILS_MAX_BYTES);
    expect(trim(details).attempts).toBe(6);
  });

  it("names the path by the way the engine routes and the session up at the time", () => {
    const paired = { stored: { profile: "paired-chat/1" as const }, pairing: { transport: "hyperdht/1" as const }, link: { isDataLinkOpen: true, relayedPath: { relays: ["r.example"] }, rttMs: 30 } };
    expect(pathSnapshot(paired, "datalink")).toEqual({ path: "hyperdht/1", relayed: true, relays: ["r.example"], rttMs: 30 });
    expect(pathSnapshot(paired, "pkarr")).toEqual({ path: "dht" });
    expect(pathSnapshot(paired, "hold")).toEqual({ path: "hold" });
    expect(pathSnapshot({ ...paired, link: { isDataLinkOpen: false } }, "datalink")).toEqual({ path: "hyperdht/1" });
    const legacy = { stored: {}, link: { isDataLinkOpen: true } };
    expect(pathSnapshot(legacy, "datalink")).toEqual({ path: "legacy-datalink" });
    expect(pathSnapshot(legacy, "pkarr")).toEqual({ path: "legacy-dht" });
  });
});
