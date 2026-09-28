import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFiles, GhostLink, createIdentity, createLink, forwardedAgain, forwardedMany, identityFromSeedB64, readForwarded, type FileTransferRecord, type IncomingMessage, type IncomingTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { forwardKind } from "../src/engine/forwards";
import { fileStore } from "../src/shared/idb";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.forward.wire, chat.forward.files, files.paired.send

/**
 * Forwarding in the engine (WISP 400 § Forwards): a real node with two contacts, A and B, over a stand-in for Iroh,
 * each contact speaking files/3 with a bare `ChatFiles`. What A sent is forwarded to B as a new message of mine that
 * carries one more hop, and a file goes from the bytes already here: A is never asked for it again.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

function pattern(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = ((offset + i) * 7 + ((offset + i) >>> 13)) & 0xff;
  return out;
}
const digestOf = (size: number) => createHash("sha256").update(pattern(0, size)).digest("base64url");

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

type Contact = Awaited<ReturnType<typeof contactOf>>;

/** A contact of the app, on its own chat: the texts it got, the files it got (hashed), every files/3 frame it heard. */
async function contactOf(net: FakeNativeNet, name: string, transport: ConstructorParameters<typeof GhostlyNode>[1]["transport"], { files = true } = {}) {
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `forward-${name}-${crypto.randomUUID()}`;
  // The app's endpoint for this chat: each chat has its own (the engine keys it by this seed), so each its own name here.
  const transportSeed = createIdentity().seedB64;
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1, transportSeeds: { "iroh/1": transportSeed },
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: `${name}:iroh/1` } } });
  const got: IncomingMessage[] = [];
  const frames: Record<string, unknown>[] = [];
  const received = new Map<string, { hash: ReturnType<typeof createHash>; length: number }>();
  const records = new Map<string, FileTransferRecord>();
  const sizes = new Map<string, number>();
  const peer: { link?: GhostLink } = {};
  const chatFiles = new ChatFiles({
    send: frame => peer.link?.sendFilesFrame(frame) ?? false,
    decide: async () => "accept",
    openTarget: async (record): Promise<IncomingTarget> => {
      const disk = received.get(record.id) ?? { hash: createHash("sha256"), length: 0 };
      received.set(record.id, disk);
      return { offset: disk.length, append: async bytes => { disk.hash.update(bytes); disk.length += bytes.length; }, flush: async () => {},
        verify: async digest => disk.hash.copy().digest("base64url") === digest, discard: async () => { received.delete(record.id); } };
    },
    openSource: async record => {
      const size = sizes.get(record.id)!;
      return { read: async (offset, length) => pattern(offset, Math.min(length, size - offset)), digest: async () => digestOf(size) };
    },
    changed: record => { records.set(`${record.direction}:${record.id}`, record); },
    room: async () => 50 * 1024 ** 3,
    writable: () => peer.link?.filesWritable(),
  });
  const link = new GhostLink({
    // Without files: an app that takes none, neither files/2 (no handler) nor files/3.
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false, largeFilesSupport: files,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: `app-${name}:iroh/1` } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: {
      onMessage: message => { got.push(message); },
      onFilesFrame: frame => { frames.push(frame as Record<string, unknown>); return chatFiles.handle(frame); },
      onFilesSession: open => { if (open) chatFiles.attach(); else chatFiles.detach(); },
    },
  });
  peer.link = link;
  link.registerEndpoint(net.endpoint("iroh/1", name));
  cleanup.push(async () => { await link.stop(false); await db.deleteLink(id); });
  return {
    id, name, transportSeed, link, files: chatFiles, takesFiles: files, got, frames, received, records,
    offer(wireId: string, size: number, extra: { forwarded?: number } = {}) {
      sizes.set(wireId, size);
      chatFiles.offer({ id: wireId, name: `${wireId}.png`, mime: "image/png", size, timestamp: Date.now(), ...extra });
    },
  };
}

async function setup({ withCarol = false } = {}) {
  const net = new FakeNativeNet();
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const a = await contactOf(net, "alice", transport), b = await contactOf(net, "bob", transport);
  // Carol's app takes no files.
  const c = withCarol ? await contactOf(net, "carol", transport, { files: false }) : undefined;
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async seed => net.endpoint("iroh/1", `app-${[a, b, c].find(contact => contact?.transportSeed === seed)?.name ?? "other"}`) } });
  cleanup.push(async () => { await node.shutdown(); });
  await node.start();
  for (const contact of [a, b, ...(c ? [c] : [])]) {
    node.setActiveLink({ linkId: contact.id });
    await vi.waitFor(() => expect(node.getState().links.find(l => l.id === contact.id)?.availableTransports).toHaveLength(1));
    void contact.link.connect(5_000).catch(() => {});
    if (!contact.takesFiles) { await vi.waitFor(() => expect(node.getState().links.find(l => l.id === contact.id)?.pairing?.status).toBe("ready"), { timeout: 20_000 }); continue; }
    await vi.waitFor(() => expect(node.getState().links.find(l => l.id === contact.id)?.capabilities?.largeFiles).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(contact.files.live).toBe(true), { timeout: 10_000 });
  }
  const row = async (contact: Contact, find: (m: StoredMessage) => boolean) => {
    await vi.waitFor(async () => expect((await db.getMessages(contact.id)).find(find)).toBeDefined(), { timeout: 10_000 });
    return (await db.getMessages(contact.id)).find(find)!;
  };
  return { node, a, b, c, row };
}

describe("the hop count", () => {
  it("counts one more hop each time, stops at its limit, and says many from five on", () => {
    expect(forwardedAgain(undefined)).toBe(1);
    expect(forwardedAgain(1)).toBe(2);
    expect(forwardedAgain(255)).toBe(255);
    expect(forwardedAgain(-3)).toBe(1);
    expect([4, 5, 9].map(forwardedMany)).toEqual([false, true, true]);
    for (const bad of [0, 1.5, "2", null, 256, Number.NaN]) expect(readForwarded(bad)).toBeUndefined();
  });

  it("forwards texts and files, never payments or a group's history lines", () => {
    const row = (fields: Partial<StoredMessage>): StoredMessage => ({ linkId: "l", id: "x", text: "hi", sender: "peer", timestamp: 1, via: "datalink", ...fields });
    expect(forwardKind(row({}))).toBe("text");
    expect(forwardKind(row({ file: { id: "l-in-x", name: "a.png", size: 1, mime: "image/png" } }))).toBe("file");
    expect(forwardKind(row({ paymentId: "pay-1" }))).toMatchObject({ refused: expect.stringMatching(/Payments/) });
    expect(forwardKind(row({ linkId: "group:g", event: "joined" }))).toMatchObject({ refused: expect.any(String) });
    expect(forwardKind(row({ text: "  " }))).toMatchObject({ refused: expect.any(String) });
  });
});

describe("forwarding between chats", { timeout: 60_000 }, () => {
  it("sends a text on as a new message of mine, one hop further, and nothing of who wrote it", async () => {
    const t = await setup();
    expect(await t.a.link.sendMessage("**lunch** at [noon](https://example.com)?")).toBeNull();
    const original = await t.row(t.a, m => m.sender === "peer");
    const { results } = await t.node.forwardMessages({ linkId: t.a.id, messageIds: [original.id], to: [t.b.id] });
    expect(results).toEqual([{ to: t.b.id, messageIds: [expect.stringMatching(/^me_/)], error: null }]);
    await vi.waitFor(() => expect(t.b.got).toHaveLength(1));
    // The Markdown source goes as it was written; the contact reads a forwarded message, and nothing of Alice.
    expect(t.b.got[0]).toMatchObject({ text: "**lunch** at [noon](https://example.com)?", forwarded: 1 });
    expect(t.b.got[0]).not.toHaveProperty("reply");
    const mine = await t.row(t.b, m => m.id === results[0]!.messageIds[0]);
    expect(mine).toMatchObject({ sender: "me", forwarded: 1 });
  });

  it("adds a hop to a message that was forwarded already, and keeps the order of several", async () => {
    const t = await setup();
    expect(await t.b.link.sendMessage("first", Date.now() - 10)).toBeNull();
    expect(await t.b.link.sendMessage("seen before", Date.now(), undefined, undefined, undefined, 4)).toBeNull();
    const first = await t.row(t.b, m => m.text === "first"), again = await t.row(t.b, m => m.text === "seen before");
    expect(again.forwarded).toBe(4);
    const { results } = await t.node.forwardMessages({ linkId: t.b.id, messageIds: [again.id, first.id], to: [t.a.id] });
    expect(results[0]).toMatchObject({ error: null, messageIds: [expect.any(String), expect.any(String)] });
    await vi.waitFor(() => expect(t.a.got).toHaveLength(2));
    expect(t.a.got.map(m => [m.text, m.forwarded])).toEqual([["first", 1], ["seen before", 5]]);
    expect(forwardedMany(t.a.got[1]!.forwarded)).toBe(true);
  });

  it("sends a received file on from the bytes here: the contact gets it whole, and the one who sent it is never asked again", async () => {
    const t = await setup();
    const size = 300 * 1024 + 17;
    t.a.offer("pic-000001", size);
    const received = await t.row(t.a, m => m.id === "peer_pic-000001");
    await vi.waitFor(() => expect(t.node.getState().transfers[received.file!.id]).toMatchObject({ state: "done" }), { timeout: 15_000 });
    // Alice's side is done too (the app's pf-done has reached her): from here on, nothing about it should.
    await vi.waitFor(() => expect(t.a.records.get("out:pic-000001")).toMatchObject({ state: "done" }), { timeout: 15_000 });
    const heardFromA = t.a.frames.length;
    const { results } = await t.node.forwardMessages({ linkId: t.a.id, messageIds: [received.id], to: [t.b.id] });
    expect(results[0]).toMatchObject({ error: null, messageIds: [expect.stringMatching(/^me_/)] });
    const sent = await t.row(t.b, m => m.id === results[0]!.messageIds[0]);
    expect(sent).toMatchObject({ sender: "me", forwarded: 1, file: { name: "pic-000001.png", size, mime: "image/png" } });
    // A copy of its own under the new chat, the original left as it was.
    expect(sent.file!.id.startsWith(`${t.b.id}-out-`)).toBe(true);
    expect((await fileStore.get(received.file!.id))?.metadata?.size).toBe(size);
    await vi.waitFor(() => expect([...t.b.records.values()].find(r => r.direction === "in")).toMatchObject({ state: "done" }), { timeout: 15_000 });
    const record = [...t.b.records.values()].find(r => r.direction === "in")!;
    expect(record.file).toMatchObject({ size, forwarded: 1 });
    expect(t.b.received.get(record.id)!.hash.digest("base64url")).toBe(digestOf(size));
    // Nothing about that file went to Alice after it arrived: no request, no second transfer.
    expect(t.a.frames.slice(heardFromA)).toEqual([]);
  });

  it("refuses a file still arriving, and what cannot be forwarded at all; one refused chat does not stop another", async () => {
    const t = await setup();
    await db.addMessage({ linkId: t.a.id, id: "peer_pay", text: "💸 Payment", sender: "peer", timestamp: 5, via: "datalink", paymentId: "pay-1" });
    await expect(t.node.forwardMessages({ linkId: t.a.id, messageIds: ["peer_pay"], to: [t.b.id] })).rejects.toThrow(/Payments/);
    await expect(t.node.forwardMessages({ linkId: t.a.id, messageIds: ["nope"], to: [t.b.id] })).rejects.toThrow(/not in this chat/);
    await db.addMessage({ linkId: t.a.id, id: "peer_half", text: "📎 half.png", sender: "peer", timestamp: 6, via: "datalink", file: { id: `${t.a.id}-in-half`, name: "half.png", size: 10, mime: "image/png" } });
    await fileStore.put({ id: `${t.a.id}-in-half`, linkId: t.a.id, blob: new Blob([new Uint8Array(4)]), createdAt: 6, direction: "in", metadata: { name: "half.png", size: 10, mime: "image/png", timestamp: 6 } });
    await db.addMessage({ linkId: t.a.id, id: "peer_note", text: "a note", sender: "peer", timestamp: 7, via: "datalink" });
    const { results } = await t.node.forwardMessages({ linkId: t.a.id, messageIds: ["peer_half", "peer_note"], to: ["group:nope", t.b.id] });
    expect(results[0]).toEqual({ to: "group:nope", messageIds: [], error: "You are not in this group" });
    expect(results[1]).toMatchObject({ to: t.b.id, error: "The file has not arrived yet", messageIds: [expect.any(String)] });
    await vi.waitFor(() => expect(t.b.got.map(m => m.text)).toEqual(["a note"]));
    await expect(t.node.forwardMessages({ linkId: t.a.id, messageIds: ["peer_note"], to: ["a", "b", "c", "d", "e", "f"] })).rejects.toThrow(/at most 5/);
  });

  it("sending a file to a contact whose app takes none rejects with the reason, says failed, and keeps no message", async () => {
    const t = await setup({ withCarol: true });
    const file = { id: `${t.c!.id}-out-carolfile0001`, name: "a.txt", size: 3, mime: "text/plain" };
    await fileStore.put({ id: file.id, linkId: t.c!.id, blob: new Blob(["abc"]), createdAt: 1, direction: "out", wireId: "carolfile0001", metadata: { ...file, timestamp: 9 } });
    await expect(t.node.sendFile({ linkId: t.c!.id, file, timestamp: 9 })).rejects.toThrow(/updated peer to send files/);
    expect(t.node.getState().transfers[file.id]).toMatchObject({ state: "failed", error: expect.stringMatching(/updated peer/) });
    expect((await db.getMessages(t.c!.id)).filter(m => m.file)).toEqual([]);
    await expect(t.node.sendFile({ linkId: "no-such-chat", file: { ...file, id: "no-such-chat-out-x" }, timestamp: 9 })).rejects.toThrow("You are offline");
  });

  it("a file a chat cannot take is said so, never counted as sent, and its copy is not kept", async () => {
    const t = await setup({ withCarol: true });
    t.a.offer("doc-000001", 2048);
    const received = await t.row(t.a, m => m.id === "peer_doc-000001");
    await vi.waitFor(() => expect(t.node.getState().transfers[received.file!.id]).toMatchObject({ state: "done" }), { timeout: 15_000 });
    const { results } = await t.node.forwardMessages({ linkId: t.a.id, messageIds: [received.id], to: [t.c!.id, t.b.id] });
    expect(results[0]).toMatchObject({ to: t.c!.id, messageIds: [], error: expect.stringMatching(/files/) });
    expect(results[1]).toMatchObject({ to: t.b.id, error: null, messageIds: [expect.any(String)] });
    expect((await db.getMessages(t.c!.id)).filter(m => m.file)).toEqual([]);
    expect(await fileStore.listForLink(t.c!.id)).toEqual([]);
  });
});
