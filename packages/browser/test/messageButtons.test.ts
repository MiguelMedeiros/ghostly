import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUTTONS_CAPABILITY, DhtDelivery, GhostLink, createIdentity, createLink, createRelayPayload, identityFromSeedB64, parseRelayPayload, readStatusCard, type IncomingMessage, type PairingState, type PkarrTransport, type SignedPacket, type WireEdit } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { HoldEngine, emptyHoldState } from "../src/engine/hold";
import { presignS3 } from "../src/backup/s3";
import type { HoldStore } from "../src/backup/storage";
import { buttonPress, buttonsState } from "../src/shared/buttons";
import { withEdit } from "../src/shared/edits";
import type { StoredMessage } from "../src/shared/types";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: chat.buttons.wire

/**
 * Message buttons in the engine (WISP 406 · Message Buttons): a real node and its contact's link over a stand-in for
 * Iroh. The bot's buttons go as a card beside its question; a press is a reply naming the button, which the author's
 * engine takes as a press only for its own open buttons; the presser's engine refuses what cannot be pressed.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

type Keys = { invitation: ReturnType<typeof createLink>; mine: string; theirs: string; id: string };

/**
 * A node and its contact, live. `keys`: the same chat again (a restart of both apps); `rows`: kept in the chat before the
 * node starts; `contactButtons`: false for a contact's app without buttons (1.0.0 has none); `confirmEdits`: false for a
 * contact that confirms no edit (its message is not there yet); `slowOutbox`: the node's outbox for the chat flushes only
 * once this settles (a busy device, as on a slow CI runner); `hold`: both sides hold for each other (WISP 404 · Store and
 * Forward), the node reading the contact's pointer and storage through these.
 */
async function setup({ keys, rows = [], contactButtons = true, confirmEdits = true, slowOutbox, hold }: { keys?: Keys; rows?: StoredMessage[]; contactButtons?: boolean; confirmEdits?: boolean;
  slowOutbox?: Promise<void>; hold?: { transport: PkarrTransport; fetch: typeof fetch } } = {}) {
  const net = new FakeNativeNet();
  const invitation = keys?.invitation ?? createLink();
  const [mine, theirs] = keys ? [keys.mine, keys.theirs] : [createIdentity().seedB64, createIdentity().seedB64];
  const id = keys?.id ?? `buttons-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } }, ...(hold && { hold: { ...emptyHoldState(), enabled: true, peerAllows: true } }) });
  for (const row of rows) await db.putMessage({ ...row, linkId: id });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false,
    nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") } });
  if (hold) Object.assign((node as unknown as { hold: { host: object } }).hold.host, hold);
  let contactState: PairingState = { status: "connecting" };
  const contactGot: IncomingMessage[] = [], contactEdits: WireEdit[] = [], contactReceipts: [string, number][] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    editSupport: true, statusCardSupport: contactButtons, buttonsSupport: contactButtons, holdSupport: !!hold,
    events: { onPairingState: state => { contactState = state; }, onMessage: message => { contactGot.push(message); }, onMessageEdit: edit => { contactEdits.push(edit); return confirmEdits; },
      onEditReceipt: (id, e) => { contactReceipts.push([id, e]); } },
  });
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  let stopped = false;
  /** Both apps closed, the chat kept (for a restart with the same `keys`). */
  const stop = async () => { if (stopped) return; stopped = true; await contact.stop(false); await node.shutdown(); };
  cleanup.push(async () => { await stop(); await db.deleteLink(id); });
  await node.start();
  node.setActiveLink({ linkId: id });
  if (slowOutbox) {
    const box = (node as unknown as { outboxFor(linkId: string): { flush(options?: object): Promise<void> } }).outboxFor(id), flush = box.flush.bind(box);
    box.flush = async options => { await slowOutbox; return flush(options); };
  }
  const view = () => node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  const row = async (messageId: string) => (await db.getMessages(id)).find(m => m.id === messageId)!;
  const peerRow = async (text: string) => { await vi.waitFor(async () => expect((await db.getMessages(id)).find(m => m.text === text && m.sender === "peer")).toBeDefined()); return (await db.getMessages(id)).filter(m => m.text === text && m.sender === "peer").at(-1)!; };
  return { node, contact, id, contactGot, contactEdits, contactReceipts, row, peerRow, view, stop, keys: { invitation, mine, theirs, id } as Keys };
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
    // Two labels a typed answer could not tell apart: the engine refuses them too, whoever calls it.
    expect(await t.node.sendMessage({ linkId: t.id, text: QUESTION, card: ask({ buttons: [{ id: "a", label: "Yes" }, { id: "b", label: " YES" }] }) }))
      .toMatchObject({ refused: true, error: expect.stringMatching(/repeats buttons\[0\]\.label/) });
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
  // A press as the app sends it: the button's label as its text.
  const mine = (button: string, at: number): StoredMessage => ({ linkId: "l", id: `me_${at}`, text: card.buttons.find(b => b.id === button)!.label, sender: "me", timestamp: at, replyTo: { id: WIRE("Q"), snippet: "", messageId: "peer_Q", button } });

  it("marks my last press, and stays open until a once button answers it", () => {
    expect(buttonsState(question, WIRE("Q"), [])).toEqual({ card, open: true });
    expect(buttonsState(question, WIRE("Q"), [mine("more", 2)])).toEqual({ card, mine: "more", chosen: "more", open: true });
    expect(buttonsState(question, WIRE("Q"), [mine("more", 2), mine("no", 3)])).toEqual({ card, mine: "no", chosen: "no", open: false });
    // The bot's answer is what shows, for everyone.
    const closed = { ...question, card: readStatusCard(ask({ chosen: "yes", closed: true }))! };
    expect(buttonsState(closed, WIRE("Q"), [])).toMatchObject({ chosen: "yes", open: false });
    expect(buttonsState({ ...question, sender: "me" }, WIRE("Q"), [])).toMatchObject({ open: false });
  });

  it("counts my reply typed in words as the press the author's app takes it for", () => {
    const typed = (text: string, at: number): StoredMessage => ({ linkId: "l", id: `me_${at}`, text, sender: "me", timestamp: at, replyTo: { id: WIRE("Q"), snippet: "", messageId: "peer_Q" } });
    // "yes" answering the question is the author's inferred press of a once button: no more presses here either.
    expect(buttonsState(question, WIRE("Q"), [typed(" yes ", 2)])).toEqual({ card, mine: "yes", chosen: "yes", open: false });
    // The author takes it so: the same row on its side is a press.
    const original = { ...question, id: "me_Q", sender: "me" as const };
    expect(buttonPress({ ...typed(" yes ", 2), id: "peer_2", sender: "peer", replyTo: { id: WIRE("Q"), snippet: "", messageId: "me_Q" } }, original, [original])).toMatchObject({ button: "yes", inferred: true });
    // Words that are no label stay a reply, and the buttons open.
    expect(buttonsState(question, WIRE("Q"), [typed("maybe later", 2)])).toEqual({ card, open: true });
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

  it("takes a press only when its text is the label of the button it names", () => {
    const original: StoredMessage = { linkId: "group:g", id: "k:1:1", text: QUESTION, sender: "me", member: "k", timestamp: 1, card };
    const reply = (text: string, button: string): StoredMessage => ({ linkId: "group:g", id: "b:1:1", text, sender: "peer", member: "b", timestamp: 2, replyTo: { id: "k:1:1", snippet: "", member: "k", button } });
    // Everyone reads "No"; the author must not take it as Yes.
    expect(buttonPress(reply("No", "yes"), original, [original])).toBeUndefined();
    expect(buttonPress(reply("Sure, go ahead", "yes"), original, [original])).toBeUndefined();
    // Case and spaces at the ends are not a different answer.
    expect(buttonPress(reply(" yes ", "yes"), original, [original])).toEqual({ messageId: "k:1:1", button: "yes", label: "Yes" });
  });

  it("reads a card from a sender that repeated a label without failing: a typed answer takes the first", () => {
    const twins = readStatusCard({ kind: "buttons", id: "ask-2", buttons: [{ id: "a", label: "Yes" }, { id: "b", label: "yes" }, { id: "c", label: "a" }] })!;
    const original: StoredMessage = { linkId: "l", id: "me_Q", wireId: WIRE("Q"), text: QUESTION, sender: "me", timestamp: 1, card: twins };
    const typed = (text: string, button?: string): StoredMessage => ({ linkId: "l", id: "peer_1", text, sender: "peer", timestamp: 2, replyTo: { id: WIRE("Q"), snippet: "", messageId: "me_Q", ...(button && { button }) } });
    expect(buttonPress(typed("YES"), original, [original])).toEqual({ messageId: "me_Q", button: "a", label: "Yes", inferred: true });
    expect(buttonPress(typed("a"), original, [original])).toMatchObject({ button: "a" });
    // A press naming the second twin still names it: its text is its label.
    expect(buttonPress(typed("yes", "b"), original, [original])).toEqual({ messageId: "me_Q", button: "b", label: "yes" });
    expect(buttonsState({ ...original, sender: "peer" }, WIRE("Q"), [{ ...typed("Yes"), sender: "me" }])).toMatchObject({ mine: "a" });
  });
});

describe("a question changed after it was answered", () => {
  const card = readStatusCard(ask())!;
  const question: StoredMessage = { linkId: "l", id: "me_Q", text: QUESTION, sender: "me", timestamp: 1, card };

  it("keeps the version a new text replaces; the buttons alone marked or closed keep none", () => {
    const marked = withEdit(question, { seq: 1, at: 2, text: QUESTION, card: readStatusCard(ask({ chosen: "yes", closed: true }))! });
    expect(marked.edit?.history).toEqual([]);
    const reworded = withEdit(marked, { seq: 2, at: 3, text: "Want the $50 one?", card: marked.card });
    expect(reworded).toMatchObject({ text: "Want the $50 one?", edit: { seq: 2, history: [{ at: 2, text: QUESTION }] } });
    // A task's card keeps no trail, as before.
    const task = { ...question, card: readStatusCard({ kind: "task", id: "t", title: "T", status: "running" })! };
    expect(withEdit(task, { seq: 1, at: 2, text: "other", card: task.card }).edit?.history).toEqual([]);
  });
});

describe("a press names a button that holds", () => {
  it("is refused on the 1:1 path when the id does not hold or there is no reply", async () => {
    const t = await setup();
    expect(await t.contact.sendMessage(QUESTION, Date.now(), WIRE("Q"), undefined, undefined, undefined, readStatusCard(ask())!)).toBeNull();
    const question = await t.peerRow(QUESTION);
    expect(await t.node.sendMessage({ linkId: t.id, text: "Yes", replyTo: question.id, button: "no way" })).toMatchObject({ refused: true, error: "No such button" });
    expect(await t.node.sendMessage({ linkId: t.id, text: "Yes", button: "yes" })).toMatchObject({ refused: true, error: "No such button" });
  });
});

describe("buttons that went without their question (the DHT floor, a hold)", () => {
  it("a question sent on the DHT floor goes as text alone, and its row says its buttons are due", async () => {
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
      const sent = await node.sendMessage({ linkId, text: QUESTION, card: ask() });
      expect(sent.error).toBeNull();
      await vi.waitFor(async () => expect((await db.getMessage(linkId, sent.messageId!))?.delivery).toBe("delivered"), { timeout: 20_000 });
      expect(received.map(m => m.text)).toEqual([QUESTION]);
      expect(received[0]).not.toHaveProperty("card");
      expect(await db.getMessage(linkId, sent.messageId!)).toMatchObject({ via: "pkarr", card: { kind: "buttons" }, cardRestore: "due" });
      // A plain text on the floor has no buttons to restore.
      const plain = await node.sendMessage({ linkId, text: "just text" });
      await vi.waitFor(async () => expect((await db.getMessage(linkId, plain.messageId!))?.delivery).toBe("delivered"), { timeout: 20_000 });
      expect(await db.getMessage(linkId, plain.messageId!)).not.toHaveProperty("cardRestore");
    } finally { await contact.stop(); await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
  }, 60_000);

  // As the floor left it: delivered as text, the buttons due.
  const floored = (fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "", id: `me_${WIRE("F")}`, wireId: WIRE("F"), text: QUESTION, sender: "me", timestamp: Date.now() - 60_000,
    via: "pkarr", delivery: "delivered", card: readStatusCard(ask())!, cardRestore: "due", ...fields });

  it("once live, the buttons go again as an edit of the buttons alone, once, restarts included", async () => {
    const t = await setup({ rows: [floored()] });
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(1), { timeout: 10_000 });
    expect(t.contactEdits[0]).toMatchObject({ id: WIRE("F"), e: 1, m: QUESTION, sc: readStatusCard(ask()) });
    // Here: the same text, no version kept (no edit mark), confirmed by the contact, and not due any more.
    await vi.waitFor(async () => expect((await t.row(`me_${WIRE("F")}`)).edit?.pending).toBeUndefined(), { timeout: 10_000 });
    expect(await t.row(`me_${WIRE("F")}`)).toMatchObject({ text: QUESTION, cardRestore: "sent", edit: { seq: 1, history: [], restore: true } });
    // Both apps closed and open again: nothing goes a second time.
    const keys = t.keys;
    await t.stop();
    const again = await setup({ keys });
    await vi.waitFor(() => expect(again.view().sessionOffers?.peer).toContain(BUTTONS_CAPABILITY));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(again.contactEdits).toEqual([]);
    // The bot's own update after it goes as the next number, and the contact takes the highest.
    expect(await again.node.editMessage({ linkId: again.id, messageId: `me_${WIRE("F")}`, text: QUESTION, card: ask({ chosen: "yes", closed: true }) })).toMatchObject({ error: null });
    await vi.waitFor(() => expect(again.contactEdits).toEqual([expect.objectContaining({ e: 2, sc: expect.objectContaining({ chosen: "yes", closed: true }) })]), { timeout: 10_000 });
    // The restore mark stays with the restore: the bot's own edit is reported as any (the CLI's event stream).
    expect((await again.row(`me_${WIRE("F")}`)).edit).toMatchObject({ seq: 2 });
    expect((await again.row(`me_${WIRE("F")}`)).edit).not.toHaveProperty("restore");
  }, 60_000);

  it("a question the bot updated meanwhile goes as its latest version, one number above", async () => {
    const t = await setup({ rows: [floored({ edit: { seq: 3, at: Date.now() - 30_000, history: [] }, card: readStatusCard(ask({ chosen: "no" }))! })] });
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(1), { timeout: 10_000 });
    expect(t.contactEdits[0]).toMatchObject({ e: 4, m: QUESTION, sc: expect.objectContaining({ chosen: "no" }) });
  }, 30_000);

  it("goes once on a session whose outbox is slow to resend: the edit queue starts over at the opening, not after it", async () => {
    // The opening's resends (texts, then edits) end after edits are agreed and the buttons went: they once started the
    // edit queue over then, and the edit, not confirmed yet, went a second time.
    let release!: () => void;
    const slowOutbox = new Promise<void>(resolve => { release = resolve; });
    const t = await setup({ rows: [floored()], confirmEdits: false, slowOutbox });
    cleanup.push(async () => release());
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(1), { timeout: 10_000 });
    release();
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(t.contactEdits).toHaveLength(1);
    // Still pending: it goes again by the queue's backoff, or on the next session.
    expect(await t.row(`me_${WIRE("F")}`)).toMatchObject({ cardRestore: "sent", edit: { seq: 1, pending: true } });
  }, 30_000);

  it("a contact whose app shows no buttons gets no edit (an older app would mark it edited): the buttons stay due", async () => {
    const t = await setup({ rows: [floored()], contactButtons: false });
    await vi.waitFor(() => expect(t.view().sessionOffers?.peer).toContain("edit/1"));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(t.contactEdits).toEqual([]);
    expect(await t.row(`me_${WIRE("F")}`)).toMatchObject({ cardRestore: "due" });
    expect((await t.row(`me_${WIRE("F")}`)).edit).toBeUndefined();
  }, 30_000);

  it("a question that went live, or a plain text on the floor, gets nothing", async () => {
    const t = await setup({ rows: [floored({ id: `me_${WIRE("L")}`, wireId: WIRE("L"), via: "datalink", cardRestore: undefined }),
      floored({ id: `me_${WIRE("P")}`, wireId: WIRE("P"), text: "just text", card: undefined, cardRestore: undefined })] });
    await vi.waitFor(() => expect(t.view().sessionOffers?.peer).toContain(BUTTONS_CAPABILITY));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(t.contactEdits).toEqual([]);
  }, 30_000);

  it("on the contact's side, a question that came as text alone takes its buttons from the edit, with no version kept", async () => {
    const t = await setup();
    // As the DHT floor or a hold gives it: the text, no card.
    expect(await t.contact.sendMessage(QUESTION, Date.now(), WIRE("Q"))).toBeNull();
    expect((await t.peerRow(QUESTION)).card).toBeUndefined();
    expect(await t.contact.sendEdit({ id: WIRE("Q"), e: 1, ts: Date.now(), m: QUESTION, sc: readStatusCard(ask())! })).toBeNull();
    await vi.waitFor(async () => expect((await t.peerRow(QUESTION)).card).toEqual(readStatusCard(ask())));
    const restored = await t.peerRow(QUESTION);
    expect(restored.edit).toMatchObject({ seq: 1, history: [] });
    expect(buttonsState(restored, WIRE("Q"), [])).toMatchObject({ open: true });
  }, 30_000);

  /**
   * The bot's app held the question (sealed in its own storage, its text alone) and restores its buttons live; this app
   * picks the question up from that storage, which answers only once the edit is here: the order a slow pickup gives.
   * `heldBeforeOpen`: held while this app was closed, so the pickup is already under way when the chat goes live; else
   * held after, and the contact's app says so on the live session (`paired-hold` with its top).
   */
  async function editBeforeHeldQuestion({ heldBeforeOpen }: { heldBeforeOpen: boolean }) {
    const relay = memoryRelay(), bucket = memoryBucket();
    const keys: Keys = { invitation: createLink(), mine: createIdentity().seedB64, theirs: createIdentity().seedB64, id: `buttons-${crypto.randomUUID()}` };
    const holder = botHold(keys, relay, bucket);
    cleanup.push(() => holder.stop());
    const holdQuestion = () => holder.hold("bot-link", { kind: "text", id: WIRE("H"), messageId: "me_h", bytes: new TextEncoder().encode(QUESTION).length, timestamp: Date.now() - 60_000 });
    if (heldBeforeOpen) await holdQuestion();
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const slowStorage = (async (input: RequestInfo | URL, init?: RequestInit) => { reads++; await released; return bucket.fetcher(input, init); }) as typeof fetch;
    const t = await setup({ keys, hold: { transport: relay, fetch: slowStorage } });
    cleanup.push(async () => release());
    const mineLink = () => (t.node as unknown as { links: Map<string, { link?: GhostLink }> }).links.get(t.id)?.link;
    await vi.waitFor(() => expect([mineLink()?.supportsEdits, t.contact.supportsEdits]).toEqual([true, true]));
    if (!heldBeforeOpen) {
      await holdQuestion();
      t.contact.setHoldSupport(true, 1);
    }
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 5_000 });
    // The bot's app restores the buttons live (`restoreCards`): the edit comes before its message.
    expect(await t.contact.sendEdit({ id: WIRE("H"), e: 1, ts: Date.now(), m: QUESTION, sc: readStatusCard(ask())! })).toBeNull();
    // Kept for its message, not confirmed: the bot's app keeps it pending and says it again.
    const buffer = (t.node as unknown as { editBuffer: { held: Map<string, Map<string, unknown>> } }).editBuffer;
    await vi.waitFor(() => expect(buffer.held.get(t.id)?.has(WIRE("H"))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(t.contactReceipts).toEqual([]);
    expect(await db.getMessage(t.id, `peer_${WIRE("H")}`)).toBeUndefined();
    // The held question arrives: it shows with its buttons, no edit mark, and the edit is confirmed now.
    release();
    await vi.waitFor(() => expect(t.contactReceipts).toEqual([[WIRE("H"), 1]]), { timeout: 10_000 });
    const question = (await db.getMessage(t.id, `peer_${WIRE("H")}`))!;
    expect(question).toMatchObject({ text: QUESTION, via: "hold", card: readStatusCard(ask()), edit: { seq: 1, history: [] } });
    expect(buttonsState(question, WIRE("H"), [])).toMatchObject({ open: true });
  }

  it("on the contact's side, a held question picked up after its buttons' edit takes them then, and only then confirms the edit", async () => {
    await editBeforeHeldQuestion({ heldBeforeOpen: false });
  }, 30_000);

  it("a pickup under way when the chat goes live holds back no frame of the session: the edit still comes first", async () => {
    await editBeforeHeldQuestion({ heldBeforeOpen: true });
  }, 30_000);

  it("a question that went into a hold: its buttons' edit stays pending until the contact confirms it", async () => {
    const t = await setup({ rows: [floored({ via: "hold" })], confirmEdits: false });
    await vi.waitFor(() => expect(t.contactEdits).toHaveLength(1), { timeout: 10_000 });
    expect(t.contactEdits[0]).toMatchObject({ id: WIRE("F"), e: 1, m: QUESTION, sc: readStatusCard(ask()) });
    // Restored once ("sent"), but not settled: an edit unconfirmed goes again (the edit queue's resends, the next session).
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await t.row(`me_${WIRE("F")}`)).toMatchObject({ cardRestore: "sent", edit: { seq: 1, pending: true } });
    // The contact's app has the question now and confirms it: settled.
    t.contact.confirmEdit(WIRE("F"), 1);
    await vi.waitFor(async () => expect((await t.row(`me_${WIRE("F")}`)).edit?.pending).toBeUndefined());
  }, 30_000);
});

/** A bucket in memory that hands out presigned addresses as S3 does (`hold.test.ts`), and what reads them. */
function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const store: HoldStore = {
    description: "S3 · test",
    async put(name, bytes) { objects.set(name, bytes.slice()); },
    async get(name) { const bytes = objects.get(name); if (!bytes) throw new Error("S3 refused (404 NoSuchKey)"); return bytes; },
    async list() { return []; },
    async listFolder(space, mailbox) { return [...objects.keys()].filter(k => k.startsWith(`${space}/hold/${mailbox}/`)).map(name => ({ name, created: 0 })); },
    async remove(name) { objects.delete(name); },
    presign: (name, seconds) => presignS3({ method: "GET", url: new URL(`https://s3.test/bucket/${name}`), expiresSeconds: seconds }, { region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" }),
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const bytes = objects.get(decodeURIComponent(new URL(String(input)).pathname.replace(/^\/bucket\//, "")));
    return bytes ? new Response(bytes.slice() as BodyInit, { headers: { "content-length": String(bytes.length) } }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { store, fetcher };
}

/** A relay in memory, for the hold pointers. */
function memoryRelay(): PkarrTransport {
  const packets = new Map<string, SignedPacket>();
  return {
    async publish(identity, records) { packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records))); },
    async resolve(key) { return packets.get(key) ?? null; },
    describe: () => ({ protocol: "memory", relays: [] }),
  };
}

/** The bot's side of the chat holding for this app: its own store-and-forward engine, the question's text in it. */
function botHold(keys: Keys, transport: PkarrTransport, bucket: ReturnType<typeof memoryBucket>): HoldEngine {
  let stored = { id: "bot-link", ...keys.invitation.invite, profile: "paired-chat/1" as const, participationSeed: keys.theirs, pairedPeerKey: identityFromSeedB64(keys.mine).pubKeyZ32, createdAt: 0,
    hold: { ...emptyHoldState(), enabled: true, peerAllows: true } };
  return new HoldEngine({
    transport, storage: () => ({ store: bucket.store, space: "abcdefghijklmnop" }), link: () => ({ stored, open: false }), linkIds: () => [stored.id],
    saveHold: async (_id, hold) => { stored = { ...stored, hold: structuredClone(hold) }; }, delivery: async () => {},
    text: async () => QUESTION, file: async () => null, paymentRequest: () => null,
    receiveText: async () => {}, receiveFile: async () => null, receivePaymentRequest: async () => {}, changed: () => {}, fetch: bucket.fetcher,
  });
}
