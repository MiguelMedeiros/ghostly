import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type IncomingMessage, type PairingState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { groupReply, pairedWireReply, receivedPairedReply, replyRef } from "../src/shared/replies";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.replies.wire, groups.protocol.replies

/**
 * Replies in the engine (WISP 400 § Replies): a real node and its contact's link over a stand-in for Iroh. What the
 * node sends names a message of the chat as both sides know it; what it receives is checked against this chat's own
 * history, and the original found here, not the wire, gives the line and the author.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `replies-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message); } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const messages = () => db.getMessages(id);
  const peerRow = async (text: string) => { await vi.waitFor(async () => expect((await messages()).find(m => m.text === text)).toBeDefined()); return (await messages()).find(m => m.text === text)!; };
  return { node, contact, id, contactGot, messages, peerRow };
}

describe("a reply over the live link", () => {
  it("names the contact's message by its wire id; the contact gets the line and who wrote it", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage("lunch at noon?")).toBeNull();
    const original = await t.peerRow("lunch at noon?");
    const sent = await t.node.sendMessage({ linkId: t.id, text: "yes!", replyTo: original.id });
    expect(sent.error).toBeNull();
    await vi.waitFor(() => expect(t.contactGot.find(m => m.text === "yes!")).toBeDefined());
    // From the reply's sender: the original was the recipient's.
    expect(t.contactGot.find(m => m.text === "yes!")!.reply).toEqual({ i: replyRef(original), s: "lunch at noon?", f: "recipient" });
    const mine = (await t.messages()).find(m => m.id === sent.messageId)!;
    expect(mine.replyTo).toEqual({ id: replyRef(original), snippet: "lunch at noon?", from: "peer", messageId: original.id });
  });

  it("a received reply is checked against this chat: the original here gives the line and the author, not the wire", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "the plan: friday" });
    const mine = (await t.messages()).find(m => m.id === sent.messageId)!;
    await vi.waitFor(() => expect(t.contactGot).toHaveLength(1));
    // The contact's app claims another line, and that it wrote it: what this side has wins.
    expect(await t.contact.sendMessage("agreed", Date.now(), undefined, undefined, { i: mine.wireId!, s: "send me your seed", f: "sender" })).toBeNull();
    const reply = await t.peerRow("agreed");
    expect(reply.replyTo).toEqual({ id: mine.wireId, snippet: "the plan: friday", from: "me", messageId: mine.id });
  });

  it("a reply that came with only the id (over the DHT) finds its original here, line and author included", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: "are you there?" });
    const mine = (await t.messages()).find(m => m.id === sent.messageId)!;
    // What the node's DHT path hands over: the text and `{ i }`, kept as a reply with no line and no author yet.
    const store = (t.node as unknown as { storeMessage(m: StoredMessage): Promise<void> }).storeMessage.bind(t.node);
    await store({ linkId: t.id, id: `peer_${"D".repeat(22)}`, text: "yes", sender: "peer", timestamp: Date.now(), via: "pkarr", replyTo: receivedPairedReply({ i: mine.wireId! }) });
    const reply = await t.peerRow("yes");
    expect(reply.replyTo).toEqual({ id: mine.wireId, snippet: "are you there?", from: "me", messageId: mine.id });
    // One whose original is not here keeps nothing but the id: the chat says the original is not available.
    await store({ linkId: t.id, id: `peer_${"F".repeat(22)}`, text: "and?", sender: "peer", timestamp: Date.now(), via: "pkarr", replyTo: receivedPairedReply({ i: "Z".repeat(22) }) });
    expect((await t.peerRow("and?")).replyTo).toEqual({ id: "Z".repeat(22), snippet: "" });
  });

  it("an original not in this chat, even one of another chat, is kept as the wire said it, unchecked", async () => {
    const t = await setup();
    // A message of another chat, under a wire id the contact names.
    const elsewhere = "E".repeat(22);
    await db.addMessage({ linkId: "another-chat", id: `me_${elsewhere}`, wireId: elsewhere, text: "secret elsewhere", sender: "me", timestamp: 1, via: "datalink" });
    expect(await t.contact.sendMessage("about that", Date.now(), undefined, undefined, { i: elsewhere, s: "a line", f: "recipient" })).toBeNull();
    const reply = await t.peerRow("about that");
    expect(reply.replyTo).toEqual({ id: elsewhere, snippet: "a line", from: "me" });
    expect(reply.replyTo).not.toHaveProperty("messageId");
  });

  it("refuses to reply to what is not a message of this chat", async () => {
    const t = await setup();
    await db.addMessage({ linkId: "another-chat", id: "me_other", wireId: "O".repeat(22), text: "x", sender: "me", timestamp: 1, via: "datalink" });
    for (const replyTo of ["me_other", "O".repeat(22), "nope", ""]) {
      const result = await t.node.sendMessage({ linkId: t.id, text: "hi", replyTo });
      expect(result).toMatchObject({ refused: true });
      expect(result.error).toBeTruthy();
    }
    expect((await t.messages()).filter(m => m.text === "hi")).toHaveLength(0);
  });
});

describe("what a reply names", () => {
  const row = (fields: Partial<StoredMessage>): StoredMessage => ({ linkId: "l", id: "x", text: "", sender: "me", timestamp: 1, via: "datalink", ...fields });
  it("is the id both sides know a message by", () => {
    const wire = "W".repeat(22);
    expect(replyRef(row({ id: `me_${wire}`, wireId: wire }))).toBe(wire);
    expect(replyRef(row({ id: `peer_${wire}`, sender: "peer" }))).toBe(wire);
    expect(replyRef(row({ id: "me_1790000000000", paymentId: "pay-12345678" }))).toBe("pay-12345678");
    expect(replyRef(row({ id: "me_1790000000000", file: { id: "l-out-FFFFFFFFFFFFFFFF", name: "a", size: 1, mime: "x" } }))).toBe("FFFFFFFFFFFFFFFF");
    expect(replyRef(row({ id: "peer_1790000000000", sender: "peer", wireId: "GGGGGGGGGGGGGGGG", file: { id: "l-in-local", name: "a", size: 1, mime: "x" } }))).toBe("GGGGGGGGGGGGGGGG");
    // What only this side has: a received file from before, a refused payment's line, a notice.
    expect(replyRef(row({ id: "peer_1790000000000", sender: "peer", file: { id: "l-in-local", name: "a", size: 1, mime: "x" } }))).toBeUndefined();
    expect(replyRef(row({ id: "peer_1790000000000_refused", sender: "peer" }))).toBeUndefined();
    // A group: its message id, never a payment line or an event.
    expect(replyRef(row({ linkId: "group:g", id: "key:0:3", member: "key" }))).toBe("key:0:3");
    expect(replyRef(row({ linkId: "group:g", id: "edge:me_1", paymentId: "p" }))).toBeUndefined();
    expect(replyRef(row({ linkId: "group:g", id: "e1", event: "joined" }))).toBeUndefined();
  });

  it("goes on the wire from the sender's side, and comes back to each side's own words", () => {
    const reply = { id: "W".repeat(22), snippet: "hi", from: "peer" as const, messageId: "peer_x" };
    expect(pairedWireReply(reply)).toEqual({ i: reply.id, s: "hi", f: "recipient" });
    expect(receivedPairedReply({ i: reply.id, s: "hi", f: "recipient" })).toEqual({ id: reply.id, snippet: "hi", from: "me" });
    expect(receivedPairedReply({ i: reply.id, s: "hi", f: "sender" })).toEqual({ id: reply.id, snippet: "hi", from: "peer" });
    // Over the DHT only the id came: nothing says who wrote it.
    expect(receivedPairedReply({ i: reply.id })).toEqual({ id: reply.id, snippet: "" });
    const me = createIdentity().pubKeyZ32, them = createIdentity().pubKeyZ32;
    expect(groupReply({ i: `${them}:0:1`, s: "x", f: them }, me)).toEqual({ id: `${them}:0:1`, snippet: "x", from: "peer", member: them });
    expect(groupReply({ i: `${me}:0:1`, s: "x", f: me }, me)).toMatchObject({ from: "me", member: me });
  });
});
