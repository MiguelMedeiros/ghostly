import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUTTONS_CAPABILITY, GhostLink, createIdentity, createLink, identityFromSeedB64, readStatusCard, type IncomingMessage, type PairingState, type WireEdit } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { buttonPress, buttonsState } from "../src/shared/buttons";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.buttons.wire

/**
 * Message buttons in the engine (WISP 4xx · Message Buttons): a real node and its contact's link over a stand-in for
 * Iroh. The bot's buttons go as a card beside its question; a press is a reply naming the button, which the author's
 * engine takes as a press only for its own open buttons; the presser's engine refuses what cannot be pressed.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `buttons-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [], contactEdits: WireEdit[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    editSupport: true, statusCardSupport: true, buttonsSupport: true,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message); }, onMessageEdit: edit => { contactEdits.push(edit); return true; } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  cleanup.push(async () => { await contact.stop(false); await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const row = async (messageId: string) => (await db.getMessages(id)).find(m => m.id === messageId)!;
  const peerRow = async (text: string) => { await vi.waitFor(async () => expect((await db.getMessages(id)).find(m => m.text === text && m.sender === "peer")).toBeDefined()); return (await db.getMessages(id)).filter(m => m.text === text && m.sender === "peer").at(-1)!; };
  return { node, contact, id, contactGot, contactEdits, row, peerRow, view };
}

const ask = (extra: Record<string, unknown> = {}) => ({ kind: "buttons", id: "ask-30", buttons: [{ id: "yes", label: "Yes", style: "primary", once: true }, { id: "no", label: "No", once: true }, { id: "more", label: "Tell me more" }], ...extra });
const QUESTION = "Want the $30 one? Reply yes or no";
const WIRE = (c: string) => c.repeat(22);

describe("a bot asks with buttons", () => {
  it("the question goes with its buttons, and the contact's app says it can press", async () => {
    const t = await setup();
    await vi.waitFor(() => expect(t.view().sessionOffers?.peer).toContain(BUTTONS_CAPABILITY));
    const sent = await t.node.sendMessage({ linkId: t.id, text: QUESTION, card: ask() });
    expect(sent.error).toBeNull();
    await vi.waitFor(() => expect(t.contactGot.at(-1)).toMatchObject({ text: QUESTION, card: readStatusCard(ask()) }));
    expect(await t.row(sent.messageId!)).toMatchObject({ text: QUESTION, card: { kind: "buttons" } });
    expect(await t.node.sendMessage({ linkId: t.id, text: QUESTION, card: ask({ buttons: [] }) })).toMatchObject({ refused: true });
  });

  it("takes a press from the contact once per person, and none after closing", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: QUESTION, card: ask() });
    const wireId = (await t.row(sent.messageId!)).wireId!;
    const reply = (b?: string) => ({ i: wireId, s: QUESTION, f: "recipient", ...(b && { b }) });
    // A non-once button first: a press, and the question stays open for them.
    expect(await t.contact.sendMessage("Tell me more", Date.now(), WIRE("M"), undefined, reply("more"))).toBeNull();
    expect((await t.peerRow("Tell me more")).press).toEqual({ messageId: sent.messageId, button: "more", label: "Tell me more" });
    expect(await t.contact.sendMessage("Yes", Date.now(), WIRE("Y"), undefined, reply("yes"))).toBeNull();
    const yes = await t.peerRow("Yes");
    expect(yes.press).toEqual({ messageId: sent.messageId, button: "yes", label: "Yes" });
    expect(yes.replyTo).toMatchObject({ button: "yes", messageId: sent.messageId });
    // Answered with a once button: another press is only a reply.
    expect(await t.contact.sendMessage("No", Date.now(), WIRE("N"), undefined, reply("no"))).toBeNull();
    expect((await t.peerRow("No")).press).toBeUndefined();
    // The bot marks the answer and closes: every press after is a reply.
    expect(await t.node.editMessage({ linkId: t.id, messageId: sent.messageId!, text: QUESTION, card: ask({ chosen: "yes", closed: true }) })).toMatchObject({ error: null });
    await vi.waitFor(() => expect(t.contactEdits.at(-1)).toMatchObject({ sc: { chosen: "yes", closed: true } }));
    expect(await t.contact.sendMessage("Tell me more", Date.now(), WIRE("L"), undefined, reply("more"))).toBeNull();
    await vi.waitFor(async () => expect((await db.getMessages(t.id)).filter(m => m.text === "Tell me more")).toHaveLength(2));
    expect((await t.peerRow("Tell me more")).press).toBeUndefined();
  });

  it("takes a reply that lost its button id (the DHT floor, an older app) by its label", async () => {
    const t = await setup();
    const sent = await t.node.sendMessage({ linkId: t.id, text: QUESTION, card: ask() });
    const wireId = (await t.row(sent.messageId!)).wireId!;
    expect(await t.contact.sendMessage(" yes ", Date.now(), WIRE("Y"), undefined, { i: wireId, s: QUESTION, f: "recipient" })).toBeNull();
    expect((await t.peerRow("yes")).press).toEqual({ messageId: sent.messageId, button: "yes", label: "Yes", inferred: true });
    // A reply that is not a label is only a reply.
    expect(await t.contact.sendMessage("maybe later", Date.now(), WIRE("Z"), undefined, { i: wireId, s: QUESTION, f: "recipient" })).toBeNull();
    expect((await t.peerRow("maybe later")).press).toBeUndefined();
  });
});

describe("pressing a contact's buttons", () => {
  it("sends a reply naming the button, the label as its text; refuses what cannot be pressed", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage(QUESTION, Date.now(), WIRE("Q"), undefined, undefined, undefined, readStatusCard(ask())!)).toBeNull();
    const question = await t.peerRow(QUESTION);
    expect(question.card).toMatchObject({ kind: "buttons" });
    expect(await t.node.pressButton({ linkId: t.id, messageId: question.id, buttonId: "nope" })).toMatchObject({ refused: true });
    const more = await t.node.pressButton({ linkId: t.id, messageId: question.id, buttonId: "more" });
    expect(more.error).toBeNull();
    await vi.waitFor(() => expect(t.contactGot.at(-1)).toMatchObject({ text: "Tell me more", reply: { i: WIRE("Q"), f: "recipient", b: "more" } }));
    // One press a second per message.
    expect(await t.node.pressButton({ linkId: t.id, messageId: question.id, buttonId: "yes" })).toMatchObject({ refused: true, error: "One press a second" });
    await new Promise(resolve => setTimeout(resolve, 1_050));
    expect((await t.node.pressButton({ linkId: t.id, messageId: question.id, buttonId: "yes" })).error).toBeNull();
    await vi.waitFor(() => expect(t.contactGot.at(-1)).toMatchObject({ text: "Yes", reply: { b: "yes" } }));
    expect((await t.row(more.messageId!)).replyTo).toMatchObject({ button: "more", messageId: question.id });
    // Answered with a once button: nothing more goes.
    await new Promise(resolve => setTimeout(resolve, 1_050));
    expect(await t.node.pressButton({ linkId: t.id, messageId: question.id, buttonId: "no" })).toMatchObject({ refused: true, error: "You already answered" });
    // My own message's buttons do nothing.
    const mine = await t.node.sendMessage({ linkId: t.id, text: "Mine?", card: ask() });
    expect(await t.node.pressButton({ linkId: t.id, messageId: mine.messageId!, buttonId: "yes" })).toMatchObject({ refused: true });
  });

  it("refuses a question its author closed", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage(QUESTION, Date.now(), WIRE("Q"), undefined, undefined, undefined, readStatusCard(ask({ closed: true, chosen: "no" }))!)).toBeNull();
    const question = await t.peerRow(QUESTION);
    expect(await t.node.pressButton({ linkId: t.id, messageId: question.id, buttonId: "yes" })).toMatchObject({ refused: true, error: "These buttons are closed" });
  });
});

describe("the buttons' state and a press, as pure rules", () => {
  const card = readStatusCard(ask())!;
  const question: StoredMessage = { linkId: "l", id: "peer_Q", wireId: WIRE("Q"), text: QUESTION, sender: "peer", timestamp: 1, card };
  const mine = (button: string, at: number): StoredMessage => ({ linkId: "l", id: `me_${at}`, text: button, sender: "me", timestamp: at, replyTo: { id: WIRE("Q"), snippet: "", messageId: "peer_Q", button } });

  it("marks my last press, and stays open until a once button answers it", () => {
    expect(buttonsState(question, WIRE("Q"), [])).toEqual({ card, open: true });
    expect(buttonsState(question, WIRE("Q"), [mine("more", 2)])).toEqual({ card, mine: "more", chosen: "more", open: true });
    expect(buttonsState(question, WIRE("Q"), [mine("more", 2), mine("no", 3)])).toEqual({ card, mine: "no", chosen: "no", open: false });
    // The bot's answer is what shows, for everyone.
    const closed = { ...question, card: readStatusCard(ask({ chosen: "yes", closed: true }))! };
    expect(buttonsState(closed, WIRE("Q"), [])).toMatchObject({ chosen: "yes", open: false });
    expect(buttonsState({ ...question, sender: "me" }, WIRE("Q"), [])).toMatchObject({ open: false });
  });

  it("takes a group member's press, once per member", () => {
    const original: StoredMessage = { linkId: "group:g", id: "k:1:1", text: QUESTION, sender: "me", member: "k", timestamp: 1, card };
    const press = (id: string, member: string, button: string): StoredMessage => ({ linkId: "group:g", id, text: button, sender: "peer", member, timestamp: 2, replyTo: { id: "k:1:1", snippet: "", member: "k", button } });
    const bob = press("b:1:1", "b", "yes");
    const bobPress = buttonPress(bob, original, [original])!;
    expect(bobPress).toEqual({ messageId: "k:1:1", button: "yes", label: "Yes" });
    const history = [original, { ...bob, press: bobPress }];
    expect(buttonPress(press("b:1:2", "b", "no"), original, history)).toBeUndefined();
    expect(buttonPress(press("c:1:1", "c", "no"), original, history)).toEqual({ messageId: "k:1:1", button: "no", label: "No" });
  });
});
