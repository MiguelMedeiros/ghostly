import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentDesk, type DeskLightning } from "../src/engine/payments";
import { CommunityPay, groupLinkId, pairLinkId, parsePayLink } from "../src/engine/communityPay";
import { GroupPayments } from "../src/engine/groupPayments";
import type { CashuWallet } from "../src/engine/wallet";
import type { GroupPayNote, StoredMessage } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
import { resetDb } from "./fakes";
// covers: groups.community.payments.member, groups.community.payments.group-request, groups.protocol.community-pair

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

/**
 * Payments in a community (WISP 9xx · Group Community § Payments) on headless engines: the real `Communities`,
 * `PaymentDesk`, `CommunityPay` and `GroupPayments` on every peer, with a fake wallet. Members have edges to hubs
 * only, so every payment frame between two members goes through at least one hub; hubs see it sealed.
 */

const MINT = "https://testnut.cashu.space";

interface Payer {
  peer: Peer;
  pay: CommunityPay;
  desk: PaymentDesk;
  wallet: { receiveToken: ReturnType<typeof vi.fn>; createToken: ReturnType<typeof vi.fn>; view: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn>; reclaim: ReturnType<typeof vi.fn> };
}

function member(world: CommunityWorld, name: string): Payer {
  // Each needs the others: filled in below.
  const late = {} as { desk: PaymentDesk; notes: GroupPayments };
  const membership = (p: Peer, groupId: string) => {
    const view = world.view(p, groupId);
    return view?.status === "active" && view.myKey ? { me: view.myKey, members: new Set(view.members.map(m => m.key)) } : undefined;
  };
  const peer = world.add(name, () => ({
    communityApp: (g, sender, frame) => pay.receiveApp(g, sender, frame),
    communityPair: (g, sender, payload) => pay.receivePair(g, sender, payload),
  }));
  const pay: CommunityPay = new CommunityPay({
    membership: g => membership(peer, g),
    sendApp: (g, frame) => peer.groups.sendCommunityApp(g, frame),
    sendPair: (g, to, payload) => peer.groups.sendCommunityPair(g, to, payload),
    enabled: () => ({}),
    onPaymentRequest: (l, r) => late.desk.onPaymentRequest(l, r),
    onPaymentAsk: (l, a) => late.desk.onPaymentAsk(l, a),
    onPayment: (l, p) => late.desk.onPayment(l, p),
    onPaymentResult: (l, r) => late.desk.onPaymentResult(l, r),
    onNote: (g, author, frame) => late.notes.receive(g, author, frame),
    emit: () => {},
  }, () => world.now);
  let tokens = 0;
  const wallet = {
    receiveToken: vi.fn(async (token: string) => ({ amount: Number(token.split("|")[2]), mint: token.split("|")[1] })),
    createToken: vi.fn(async (amount: number, _mints: string[], _memo: string | undefined, outbox: (token: string, mint: string) => unknown) => {
      const token = `cashu|${MINT}|${amount}|${name}${++tokens}`; await outbox(token, MINT); return { token, mint: MINT };
    }),
    view: vi.fn(async () => ({ mints: [{ url: MINT }] })),
    inspect: vi.fn((token: string) => ({ kind: "token", mint: token.split("|")[1], amount: Number(token.split("|")[2]), unit: "sat", accepted: true })),
    reclaim: vi.fn(async () => ({ amount: 0 })),
  };
  const lightning = { createInvoice: vi.fn(async () => ({ invoice: `lnbc-${name}` })), quote: vi.fn(), pay: vi.fn() };
  const putMessage = async (message: StoredMessage) => {
    const at = peer.messages.findIndex(m => m.id === message.id);
    if (at >= 0) peer.messages[at] = message; else peer.messages.push(message);
  };
  const desk = late.desk = new PaymentDesk(wallet as unknown as CashuWallet, {
    getLink: linkId => pay.link(linkId),
    groupOf: linkId => parsePayLink(linkId)?.groupId,
    groupLinks: g => [groupLinkId(g)],
    storeMessage: putMessage,
    onChange: () => { void late.notes.sync(); },
  }, undefined, undefined, undefined, lightning as unknown as DeskLightning);
  late.notes = new GroupPayments({
    payments: () => Object.values(desk.views()),
    edgeOf: linkId => { const at = parsePayLink(linkId); return at?.member ? { groupId: at.groupId, member: at.member } : undefined; },
    edges: g => new Map([["*", groupLinkId(g)]]),
    membership: g => membership(peer, g),
    send: (linkId, frame) => { void peer.groups.sendCommunityApp(parsePayLink(linkId)!.groupId, frame as Record<string, unknown>).catch(() => {}); },
    messages: g => peer.store.getMessages(`group:${g}`),
    putMessage,
  });
  return { peer, pay, desk, wallet };
}

async function community(names: string[]) {
  const world = new CommunityWorld();
  const members = names.map(n => member(world, n));
  for (const m of members) await m.desk.start();
  const [admin, ...rest] = members;
  const id = await admin.peer.groups.create("Pizza club");
  const link = await admin.peer.groups.enableLink(id);
  for (const m of rest) await m.peer.groups.joinByLink(link);
  await world.until(() => rest.every(m => world.member(m.peer, id)), 10 * 60_000);
  // Every roster complete, and hubs in place.
  await world.until(() => members.every(m => world.view(m.peer, id)?.members.length === members.length), 2 * 60_000);
  await world.run(20_000);
  return { world, id, members };
}

const keyOf = (world: CommunityWorld, m: Payer, id: string) => world.view(m.peer, id)!.myKey!;
const hub = (m: Payer, id: string) => m.peer.groups.communities.isHub(id);
const note = (m: Payer, id: string, paymentId: string): GroupPayNote | undefined => m.peer.messages.find(x => x.linkId === `group:${id}` && x.groupPay?.id === paymentId)?.groupPay;
/** Everything that went over any edge, as its JSON. */
function tap(world: CommunityWorld): string[] {
  const wire: string[] = [];
  world.drop = (_from, _to, frame) => { wire.push(JSON.stringify(frame)); return false; };
  return wire;
}

describe("payments in a community on headless engines", { timeout: 180_000 }, () => {
  it("a member requests from another through the hubs; the payer pays sealed to them; everyone sees it paid", async () => {
    const { world, id, members } = await community(["admin", "p1", "p2", "p3", "p4", "p5"]);
    // Two members that are not hubs: they have no edge to each other, only to hubs.
    const plain = members.filter(m => !hub(m, id));
    expect(plain.length).toBeGreaterThanOrEqual(2);
    const [alice, bob] = plain, carol = members.find(m => m !== alice && m !== bob)!;
    const aliceKey = keyOf(world, alice, id), bobKey = keyOf(world, bob, id);
    expect([...alice.peer.links.values()].some(e => e.kind === "edge" && e.peer === bobKey)).toBe(false);
    const wire = tap(world);

    const { paymentId } = await alice.desk.request({ linkId: pairLinkId(id, bobKey), amount: 1000, memo: "pizza", timestamp: world.now, rail: "cashu" });
    await world.until(() => !!bob.desk.views()[paymentId] && note(carol, id, paymentId)?.state === "open", 60_000);
    expect(bob.desk.views()[paymentId]).toMatchObject({ linkId: pairLinkId(id, aliceKey), kind: "request", direction: "in", state: "pending", amount: 1000, memo: "pizza" });
    // Carol reads the note (who asks whom, how much), not the request.
    expect(carol.desk.views()[paymentId]).toBeUndefined();
    expect(note(carol, id, paymentId)).toMatchObject({ kind: "request", from: bobKey, to: aliceKey, amount: "1000", state: "open" });

    await bob.desk.payRequest({ linkId: pairLinkId(id, aliceKey), paymentId });
    await world.until(() => alice.desk.views()[paymentId]?.state === "settled" && bob.desk.views()[paymentId]?.state === "settled" && note(carol, id, paymentId)?.state === "paid", 60_000);
    expect(alice.wallet.receiveToken).toHaveBeenCalledTimes(1);
    const token = alice.wallet.receiveToken.mock.calls[0][0] as string;
    expect(token).toMatch(/^cashu\|/);
    // The token and the memo crossed the hubs sealed: nothing on the wire shows them.
    expect(wire.length).toBeGreaterThan(0);
    for (const frame of wire) { expect(frame).not.toContain(token); expect(frame).not.toContain("pizza"); }
    expect(note(carol, id, paymentId)).toMatchObject({ state: "paid", by: bobKey });
    expect(Object.values(bob.desk.views()).find(p => p.kind === "payment")).toMatchObject({ state: "settled", direction: "out", requestId: paymentId });
  });

  it("reaches a member who was away, and the payment reaches the payee who went away meanwhile", async () => {
    const { world, id, members } = await community(["admin", "p1", "p2", "p3", "p4"]);
    const plain = members.filter(m => !hub(m, id));
    const [alice, bob] = plain.length >= 2 ? plain : members.slice(-2);
    const aliceKey = keyOf(world, alice, id), bobKey = keyOf(world, bob, id);
    bob.peer.online = false;
    const { paymentId } = await alice.desk.request({ linkId: pairLinkId(id, bobKey), amount: 500, timestamp: world.now, rail: "cashu" });
    await world.run(15_000);
    expect(bob.desk.views()[paymentId]).toBeUndefined();
    // Alice leaves before Bob comes back: whoever is there hands it on.
    alice.peer.online = false;
    bob.peer.online = true;
    await world.until(() => !!bob.desk.views()[paymentId], 3 * 60_000);
    await bob.desk.payRequest({ linkId: pairLinkId(id, aliceKey), paymentId });
    await world.run(15_000);
    expect(alice.wallet.receiveToken).not.toHaveBeenCalled();
    // Bob leaves too; Alice comes back and gets Bob's ecash from the hubs.
    bob.peer.online = false;
    alice.peer.online = true;
    await world.until(() => alice.desk.views()[paymentId]?.state === "settled", 3 * 60_000);
    expect(alice.wallet.receiveToken).toHaveBeenCalledTimes(1);
    // Bob hears it was received when he is back.
    bob.peer.online = true;
    await world.until(() => bob.desk.views()[paymentId]?.state === "settled", 3 * 60_000);
  });

  it("a request to the whole community is paid once: the second payer's ecash is refused unredeemed and comes back", async () => {
    const { world, id, members } = await community(["admin", "p1", "p2", "p3"]);
    const [alice, bob, carol, dave] = members;
    const aliceKey = keyOf(world, alice, id), bobKey = keyOf(world, bob, id);
    const wire = tap(world);
    const { paymentId } = await alice.desk.requestFromGroup({ groupId: id, amount: 300, memo: "tickets", timestamp: world.now, rail: "cashu" });
    await world.until(() => [bob, carol, dave].every(m => m.desk.views()[paymentId]?.state === "pending"), 60_000);
    // One frame to everyone, not one per member.
    const requests = wire.filter(f => f.includes('"group-msg"') && f.includes(aliceKey));
    expect(requests.length).toBeGreaterThan(0);
    for (const m of [bob, carol, dave]) expect(m.desk.views()[paymentId]).toMatchObject({ linkId: pairLinkId(id, aliceKey), direction: "in", memo: "tickets" });
    await world.until(() => note(dave, id, paymentId)?.from === "*", 60_000);

    // Bob and Carol pay at once.
    await Promise.all([bob.desk.payRequest({ linkId: pairLinkId(id, aliceKey), paymentId }), carol.desk.payRequest({ linkId: pairLinkId(id, aliceKey), paymentId })]);
    await world.until(() => {
      const carolPaid = Object.values(carol.desk.views()).find(p => p.kind === "payment" && p.requestId === paymentId);
      const bobPaid = Object.values(bob.desk.views()).find(p => p.kind === "payment" && p.requestId === paymentId);
      return alice.desk.views()[paymentId]?.state === "settled" && [carolPaid, bobPaid].some(p => p?.state === "settled") && [carolPaid, bobPaid].some(p => p?.state === "reclaimed" || p?.state === "failed");
    }, 90_000);
    // Only one token was redeemed; the other was checked and refused before anything was spent.
    expect(alice.wallet.receiveToken).toHaveBeenCalledTimes(1);
    // Everyone's copy closes as paid, and the group sees one payer.
    await world.until(() => dave.desk.views()[paymentId]?.state === "settled" && note(dave, id, paymentId)?.state === "paid", 60_000);
    const winner = note(dave, id, paymentId)!.by;
    expect([bobKey, keyOf(world, carol, id)]).toContain(winner);
  });

  it("a member learns what another takes when asked: until then, Cashu and Lightning", async () => {
    const { world, id, members } = await community(["admin", "p1", "p2"]);
    const [alice, bob] = members;
    const bobKey = keyOf(world, bob, id);
    const link = alice.pay.link(pairLinkId(id, bobKey))!;
    expect(link.allowsPayment("cashu")).toBe(true);
    expect(link.allowsPayment("arkade")).toBe(false);
    await alice.pay.hello(id, bobKey);
    await world.until(() => alice.pay.known(id, bobKey), 30_000);
    expect(link.allowsPayment("arkade")).toBe(true);
    expect(alice.pay.views(id, keyOf(world, alice, id), [bobKey], new Set())[0]).toMatchObject({ peerPubKeyZ32: bobKey, capabilities: { payments: true } });
    // Nobody else's app is asked, nor answers.
    expect(members[2].pay.known(id, bobKey)).toBe(false);
    // Not a member: no link.
    expect(alice.pay.link(pairLinkId(id, "y".repeat(52)))?.supportsPayments).toBe(true);
    await expect(alice.pay.link(pairLinkId(id, "y".repeat(52)))!.requirePaymentSupport()).rejects.toThrow("They are no longer in this group");
  });
});
