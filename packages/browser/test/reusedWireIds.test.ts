import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { fileStore } from "../src/shared/idb";
import type { HoldHost } from "../src/engine/hold";
import { FakeNativeNet, fakeDescriptor } from "./helpers/fakeNative";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: chat.paired.send

/**
 * A 1:1 chat's pins, quotes and reactions name a message by its wire id, which both sides know, and look for the
 * contact's row under it first. A message of the contact's under the wire id of one of mine is never stored: whatever
 * names that id keeps showing mine.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `reused-ids-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "contact") } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": fakeDescriptor("iroh/1", "app") } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { contactState = state; }, onMessage: () => {} },
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
  /** Waits for a text the contact sent after the frames under test: those came before it, on the same session. */
  const after = async (text: string) => vi.waitFor(async () => expect((await messages()).find(m => m.text === text)).toBeDefined());
  const hold = (node as unknown as { hold: { host: HoldHost } }).hold.host;
  return { id, contact, hold, messages, after };
}

describe("a contact's message under the wire id of one of mine", () => {
  it("is not stored, live or held, and a quote of that id still shows mine", async () => {
    const t = await setup();
    const [live, held, file] = ["a".repeat(22), "b".repeat(22), "f".repeat(22)];
    for (const [wireId, at] of [[live, 1], [held, 2], [file, 3]] as const)
      await db.putMessage({ linkId: t.id, id: `me_${wireId}`, wireId, text: `mine ${wireId[0]}`, sender: "me", timestamp: 1_790_000_000_000 + at, via: "datalink" });
    expect(await t.contact.sendMessage("theirs a", 1_790_000_000_010, live)).toBeNull();
    await t.hold.receiveText(t.id, { id: held, text: "theirs b", timestamp: 1_790_000_000_011 });
    // A held file's bytes are refused before they land: no file of theirs is kept with no message.
    const refused = await t.hold.receiveFile(t.id, { wireId: file, name: "f.txt", size: 2, mime: "text/plain", timestamp: 1_790_000_000_012 }, new Uint8Array([1, 2]), "00");
    expect(await t.contact.sendMessage("done", 1_790_000_000_013, "d".repeat(22), undefined, { i: live, s: "theirs a", f: "sender" })).toBeNull();
    await t.after("done");
    const rows = await t.messages();
    expect(rows.map(m => m.id).filter(id => id.startsWith("peer_"))).toEqual([`peer_${"d".repeat(22)}`]);
    expect(rows.find(m => m.text === "done")?.replyTo).toMatchObject({ messageId: `me_${live}`, from: "me", snippet: "mine a" });
    expect(refused).not.toBeNull();
    expect((await fileStore.listForLink(t.id)).filter(f => f.direction === "in")).toEqual([]);
  });
});
