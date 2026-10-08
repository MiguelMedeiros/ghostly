import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_CAPABILITY, DhtDelivery, GhostLink, STATUS_CARD_CAPABILITY, appCardId, createIdentity, createLink, createRelayPayload, identityFromSeedB64, parseRelayPayload, readStatusCard, statusCardText,
  type IncomingMessage, type PairingState, type SignedPacket, type StatusCard, type WireEdit } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.status-cards.wire, apps.chat.card

/**
 * A card that went without its message (WISP 405 · Status Cards): the DHT floor and a hold carry a message's text alone,
 * and a copy under the same id that comes live later is taken as the one already there. An app card, or a task a bot
 * sent once, gets no later update to carry its card, so the contact would see the text for good. Once the chat is live
 * with an app that shows the kind, the author's engine sends the card again as an edit of the card alone, once.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

type Keys = { invitation: ReturnType<typeof createLink>; mine: string; theirs: string; id: string };

const PUBLISHER = createIdentity().pubKeyZ32;
const REF = `${PUBLISHER}/chess`;
const APP = { kind: "app", id: appCardId(REF), ref: REF, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", sequence: 7, title: "Chess", version: "1.2.0",
  url: "https://raw.githubusercontent.com/ghostly-e2e/chess/HEAD/app.ghostlyapp", opened: true };
const TASK = { kind: "task", id: "relay-rotation", title: "Fix relay rotation", status: "done", progress: 100 };
const appCard = readStatusCard(APP)!, taskCard = readStatusCard(TASK)!;
const WIRE = (c: string) => c.repeat(22);

/**
 * A node (apps on) and its contact, live. `contactApps`: false for a contact's app that shows no app card (before 1.2);
 * `contactCards`: false for one that shows no card at all (before cards); `keys`: the same chat again (a restart).
 */
async function setup({ keys, rows = [], contactApps = true, contactCards = true }: { keys?: Keys; rows?: StoredMessage[]; contactApps?: boolean; contactCards?: boolean } = {}) {
  const net = new FakeNativeNet();
  const invitation = keys?.invitation ?? createLink();
  const [mine, theirs] = keys ? [keys.mine, keys.theirs] : [createIdentity().seedB64, createIdentity().seedB64];
  const id = keys?.id ?? `cards-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  for (const row of rows) await db.putMessage({ ...row, linkId: id });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false, apps: true,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [], contactEdits: WireEdit[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    editSupport: true, statusCardSupport: contactCards, buttonsSupport: contactCards, appsSupport: contactCards && contactApps,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message); }, onMessageEdit: edit => { contactEdits.push(edit); return true; } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await contact.stop(false); await node.shutdown(); };
  cleanup.push(async () => { await stop(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const row = async (messageId: string) => (await db.getMessages(id)).find(m => m.id === messageId)!;
  const peerRow = async (text: string) => { await vi.waitFor(async () => expect((await db.getMessages(id)).find(m => m.text === text && m.sender === "peer")).toBeDefined()); return (await db.getMessages(id)).filter(m => m.text === text && m.sender === "peer").at(-1)!; };
  return { node, contact, id, contactGot, contactEdits, row, peerRow, view, stop, keys: { invitation, mine, theirs, id } as Keys };
}

/** As the floor left it: delivered as its text, the card due. */
const floored = (c: string, card: StatusCard, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "", id: `me_${WIRE(c)}`, wireId: WIRE(c), text: statusCardText(card), sender: "me",
  timestamp: Date.now() - 60_000, via: "pkarr", delivery: "delivered", card, cardRestore: "due", ...fields });

describe("a card sent on the DHT floor", () => {
  it("goes as its text alone, and its row says the card is due: an app card and a task card, not only buttons", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const packets = new Map<string, SignedPacket>();
    const transport = { publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
      packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
    }, resolve: async (key: string) => packets.get(key) ?? null, describe: () => ({ protocol: "signed packet fixture", relays: [] }) };
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });
    const invitation = createLink();
    const received: { id: string; text: string }[] = [];
    const contact = new DhtDelivery({ params: invitation.invite, mode: "dht", credentials: { seedB64: createIdentity().seedB64 }, transport,
      save: async () => {}, pin: async () => {}, message: async m => { received.push(m); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    let linkId = "";
    try {
      await node.start();
      ({ linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", deliveryMode: "dht" }));
      node.setActiveLink({ linkId });
      await contact.start();
      for (const [card, kind] of [[APP, "app"], [TASK, "task"]] as const) {
        const sent = await node.sendMessage({ linkId, text: "", card });
        expect(sent.error).toBeNull();
        await vi.waitFor(async () => expect((await db.getMessage(linkId, sent.messageId!))?.delivery).toBe("delivered"), { timeout: 20_000 });
        expect(received.at(-1)).not.toHaveProperty("card");
        expect(await db.getMessage(linkId, sent.messageId!)).toMatchObject({ via: "pkarr", card: { kind }, cardRestore: "due" });
      }
      expect(received.map(m => m.text)).toEqual([statusCardText(appCard), statusCardText(taskCard)]);
    } finally { await contact.stop(); await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
  }, 60_000);
});

describe("once live, the card goes again as an edit of the card alone", () => {
  it("an app card and a task card, once each, restarts included, with no version kept", async () => {
    const t = await setup({ rows: [floored("A", appCard), floored("T", taskCard, { timestamp: Date.now() - 50_000 })] });
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(2), { timeout: 15_000 });
    expect(t.contactEdits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: WIRE("A"), e: 1, m: statusCardText(appCard), sc: appCard }),
      expect.objectContaining({ id: WIRE("T"), e: 1, m: statusCardText(taskCard), sc: taskCard })]));
    for (const c of ["A", "T"]) {
      await vi.waitFor(async () => expect((await t.row(`me_${WIRE(c)}`)).edit?.pending).toBeUndefined(), { timeout: 10_000 });
      expect(await t.row(`me_${WIRE(c)}`)).toMatchObject({ cardRestore: "sent", edit: { seq: 1, history: [], restore: true } });
    }
    const keys = t.keys;
    await t.stop();
    const again = await setup({ keys });
    await vi.waitFor(() => expect(again.view().sessionOffers?.peer).toContain(APPS_CAPABILITY));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(again.contactEdits).toEqual([]);
  }, 60_000);

  it("a contact whose app shows no app card gets none (it would mark the text edited): it stays due, while a task card goes", async () => {
    const t = await setup({ rows: [floored("A", appCard), floored("T", taskCard)], contactApps: false });
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(1), { timeout: 15_000 });
    expect(t.contactEdits[0]).toMatchObject({ id: WIRE("T"), sc: taskCard });
    expect(t.view().sessionOffers?.peer).not.toContain(APPS_CAPABILITY);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(t.contactEdits).toHaveLength(1);
    expect(await t.row(`me_${WIRE("A")}`)).toMatchObject({ cardRestore: "due" });
    expect((await t.row(`me_${WIRE("A")}`)).edit).toBeUndefined();
  }, 30_000);

  it("a contact whose app shows no cards at all gets nothing: both stay due", async () => {
    const t = await setup({ rows: [floored("A", appCard), floored("T", taskCard)], contactCards: false });
    await vi.waitFor(() => expect(t.view().sessionOffers?.peer).toContain("edit/1"));
    expect(t.view().sessionOffers?.peer).not.toContain(STATUS_CARD_CAPABILITY);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(t.contactEdits).toEqual([]);
    for (const c of ["A", "T"]) expect(await t.row(`me_${WIRE(c)}`)).toMatchObject({ cardRestore: "due" });
  }, 30_000);

  it("a row kept from before every kind was restored (`buttonsRestore`) still goes", async () => {
    const { cardRestore: _new, ...old } = floored("B", readStatusCard({ kind: "buttons", id: "ask", buttons: [{ id: "yes", label: "Yes" }] })!);
    const t = await setup({ rows: [{ ...old, text: "Want it?", buttonsRestore: "due" }] });
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(async () => expect(await t.row(`me_${WIRE("B")}`)).toMatchObject({ cardRestore: "sent", edit: { seq: 1, restore: true } }));
    expect((await t.row(`me_${WIRE("B")}`)).buttonsRestore).toBeUndefined();
  }, 30_000);

  it("is bounded: a card of over 7 days is given up, and only the newest 50 go", async () => {
    const now = Date.now();
    const ids = Array.from({ length: 52 }, (_, i) => `x${String(i).padStart(20, "0")}`);
    // 52 recent task cards, the oldest two past the 50; one of 8 days.
    const rows = ids.map((wire, i) => ({ ...floored("Z", taskCard), id: `me_${wire}`, wireId: wire, timestamp: now - 60_000 - i * 1_000 }));
    rows.push(floored("O", taskCard, { timestamp: now - 8 * 24 * 60 * 60_000 }));
    const t = await setup({ rows });
    await vi.waitFor(async () => expect((await db.getMessages(t.id)).filter(m => m.cardRestore === "due")).toHaveLength(0), { timeout: 15_000 });
    const after = await db.getMessages(t.id);
    const restored = after.filter(m => m.edit?.restore).map(m => m.wireId);
    expect(restored.sort()).toEqual(ids.slice(0, 50).sort());
    for (const given of [ids[50], ids[51], WIRE("O")]) expect(after.find(m => m.wireId === given)).toMatchObject({ cardRestore: "sent" });
    expect(after.find(m => m.wireId === WIRE("O"))?.edit).toBeUndefined();
  }, 30_000);

  it("on the contact's side, an app card and a task card that came as text take their card from the edit, with no version kept", async () => {
    const t = await setup();
    for (const [c, card] of [["P", appCard], ["Q", taskCard]] as const) {
      const text = statusCardText(card);
      expect(await t.contact.sendMessage(text, Date.now(), WIRE(c))).toBeNull();
      expect((await t.peerRow(text)).card).toBeUndefined();
      expect(await t.contact.sendEdit({ id: WIRE(c), e: 1, ts: Date.now(), m: text, sc: card })).toBeNull();
      await vi.waitFor(async () => expect((await t.peerRow(text)).card).toEqual(card));
      expect((await t.peerRow(text)).edit).toMatchObject({ seq: 1, history: [] });
    }
  }, 30_000);
});
