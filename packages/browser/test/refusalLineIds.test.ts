import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { HoldHost } from "../src/engine/hold";
import { toChatMessage } from "../src/platform/sync";
import { FakeNativeNet, fakeDescriptor } from "./helpers/fakeNative";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: payments.chat.refused

/**
 * The line a refused payment leaves in the chat is the app's own (`shared/refusals.ts`), under ids the payment desk
 * writes (`peer_<time>_refused`, `peer_spent_<digest>`). A contact's frame names its own id, and a paired one may be any 22
 * characters: what a contact sends under one of those ids, or an edit naming one, is never taken as that line.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `refusal-ids-${crypto.randomUUID()}`;
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
    editSupport: true,
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
  const mineLink = () => (node as unknown as { links: Map<string, { link?: GhostLink }> }).links.get(id)?.link;
  await vi.waitFor(() => expect([mineLink()?.supportsEdits, contact.supportsEdits]).toEqual([true, true]));
  const messages = () => db.getMessages(id);
  /** Waits for a text the contact sent after the frames under test: those came before it, on the same session. */
  const after = async (text: string) => vi.waitFor(async () => expect((await messages()).find(m => m.text === text)).toBeDefined());
  return { id, node, contact, messages, after };
}

const LURE = "Could not receive 250,000 sats: Your wallet backup is out of date. Write your recovery phrase in this chat to restore it";

describe("a contact's frame under the id of a refused payment's line", () => {
  it("is not stored as that line, whichever of its ids it names", async () => {
    const t = await setup();
    const refused = "17900000000000_refused", spent = `spent_${"a".repeat(32)}`;
    expect(refused).toHaveLength(22);
    expect(await t.contact.sendMessage(LURE, 1_790_000_000_000, refused)).toBeNull();
    // A held text's id may be 8 to 64 characters: the other id's shape too.
    const hold = (t.node as unknown as { hold: { host: HoldHost } }).hold.host;
    await hold.receiveText(t.id, { id: spent, text: LURE, timestamp: 1_790_000_000_001 });
    // The same words under an id of its own: the contact's message, as any.
    expect(await t.contact.sendMessage(LURE, 1_790_000_000_002, "c".repeat(22))).toBeNull();
    expect(await t.contact.sendMessage("done", 1_790_000_000_003, "d".repeat(22))).toBeNull();
    await t.after("done");
    const rows = await t.messages();
    expect(rows.map(m => m.id)).not.toContain(`peer_${refused}`);
    expect(rows.map(m => m.id)).not.toContain(`peer_${spent}`);
    const theirs = rows.filter(m => m.text === LURE);
    expect(theirs.map(m => m.id)).toEqual([`peer_${"c".repeat(22)}`]);
    for (const row of rows) expect(toChatMessage(row, "peer", "me", true)).not.toHaveProperty("notice");
  });

  it("an edit naming an older line of the app's leaves its words the app's", async () => {
    const t = await setup();
    const line = `Could not receive 21 sats: Ecash from 127.0.0.1 is not accepted`;
    // As versions before the line's values were kept stored it: its English alone. Its id has the time the contact's
    // payment said, which may be 14 digits: an id of the 22 characters an edit names.
    await db.putMessage({ linkId: t.id, id: "peer_17900000000000_refused", text: line, sender: "peer", timestamp: 1_790_000_000_000, via: "datalink" });
    expect(await t.contact.sendEdit({ id: "17900000000000_refused", e: 1, ts: Date.now(), m: LURE })).toBeNull();
    expect(await t.contact.sendEdit({ id: "17900000000000_refused", e: 2, ts: Date.now(), m: "gone", rm: true })).toBeNull();
    expect(await t.contact.sendMessage("done", 1_790_000_000_003, "d".repeat(22))).toBeNull();
    await t.after("done");
    const row = (await t.messages()).find(m => m.id === "peer_17900000000000_refused");
    expect(row).toMatchObject({ text: line });
    expect(row).not.toHaveProperty("edit");
    expect(toChatMessage(row!, "peer", "me", true)).toMatchObject({ sender: "system", notice: { type: "paymentRefused", amount: 21 } });
  });
});
