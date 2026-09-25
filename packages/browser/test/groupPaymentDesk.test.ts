import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, type GhostLink, type Payment, type PaymentRequest, type PaymentResult } from "@ghostly/core";
import { PaymentDesk, type DeskLightning } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import type { StoredMessage } from "../src/shared/types";
import { resetDb } from "./fakes";
// covers: groups.payments.member, groups.payments.group-request

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
beforeEach(() => resetDb());

/**
 * Payments in a group at the desk (WISP 9xx § Payments): a member's payment goes over the edge to that member
 * and nowhere else, and a request to the whole group is paid once — the first valid payment settles it, a later
 * token is refused before anything is redeemed (its payer takes it back), and every member's copy closes.
 */

const MINT = "https://testnut.cashu.space";
const OTHER_MINT = "https://mint.elsewhere";
type Frame = Record<string, unknown>;

interface Member {
  name: string;
  desk: PaymentDesk;
  wallet: { receiveToken: ReturnType<typeof vi.fn>; createToken: ReturnType<typeof vi.fn>; view: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn> };
  lightning: { createInvoice: ReturnType<typeof vi.fn>; quote: ReturnType<typeof vi.fn>; pay: ReturnType<typeof vi.fn> };
  /** This member's edges: link id → the member at the other end. */
  edges: Map<string, string>;
  messages: StoredMessage[];
  sent: { linkId: string; kind: string; frame: Frame }[];
}

/**
 * Members of one group ("g") joined by edges. An edge is one link id on each side (`AB` on A's, `BA` on B's).
 * Frames are queued and delivered by `settle()`, in order; `down` edges drop them.
 */
class World {
  readonly members = new Map<string, Member>();
  readonly down = new Set<string>();
  private queue: (() => Promise<unknown>)[] = [];

  add(name: string): Member {
    const edges = new Map<string, string>();
    const sent: Member["sent"] = [];
    const deliver = (linkId: string, kind: string, frame: Frame, run: (peer: Member, back: string) => Promise<unknown>) => {
      sent.push({ linkId, kind, frame });
      const peer = this.members.get(edges.get(linkId)!)!;
      if (this.down.has(linkId)) return;
      this.queue.push(() => run(peer, `${peer.name}${name}`));
    };
    const link = (linkId: string) => ({
      isDataLinkOpen: true, supportsPayments: true, supportsArkPayments: false, supportsBarkPayments: false, supportsBitcoinPayments: false, supportsUsdtPayments: false,
      requirePaymentSupport: async () => {}, allowsPayment: (m: string) => m === "cashu" || m === "lightning", paymentEnabled: (m: string) => m === "cashu" || m === "lightning",
      sendPaymentRequest: async (frame: PaymentRequest) => deliver(linkId, "req", frame as unknown as Frame, (peer, back) => peer.desk.onPaymentRequest(back, structuredClone(frame))),
      sendPayment: async (frame: Payment) => deliver(linkId, "pay", frame as unknown as Frame, (peer, back) => peer.desk.onPayment(back, structuredClone(frame))),
      sendPaymentResult: (frame: PaymentResult) => deliver(linkId, "res", frame as unknown as Frame, (peer, back) => peer.desk.onPaymentResult(back, structuredClone(frame))),
      sendPaymentAsk: async () => {},
    });
    let tokens = 0;
    const wallet = {
      // Ecash from one mint; a token redeemed twice is "spent" (taking it back after the payee redeemed it).
      receiveToken: vi.fn(async (token: string) => ({ amount: Number(token.split("|")[2] ?? 100), mint: token.split("|")[1] ?? MINT })),
      createToken: vi.fn(async (amount: number, _mints: string[], _memo: string | undefined, outbox: (token: string, mint: string) => unknown) => {
        const token = `cashu|${MINT}|${amount}|${name}${++tokens}`; outbox(token, MINT); return { token, mint: MINT };
      }),
      view: vi.fn(async () => ({ mints: [{ url: MINT }] })),
      inspect: vi.fn((token: string) => ({ kind: "token", mint: token.split("|")[1], amount: Number(token.split("|")[2]), unit: "sat", accepted: true })),
    };
    const lightning = { createInvoice: vi.fn(async () => ({ invoice: `lnbc-${name}` })), quote: vi.fn(async () => ({ quote: "q", mint: MINT, amount: 100, feeReserve: 1 })), pay: vi.fn(async () => true) };
    const messages: StoredMessage[] = [];
    const desk = new PaymentDesk(wallet as unknown as CashuWallet, {
      getLink: linkId => edges.has(linkId) ? link(linkId) as unknown as GhostLink : null,
      groupOf: linkId => edges.has(linkId) ? "g" : undefined,
      groupLinks: group => group === "g" ? [...edges.keys()] : [],
      storeMessage: async message => { messages.push(message); },
      onChange: () => {},
      // The members try things out on the public test mint: their requests are Testnet's.
      defaultNetwork: () => "testnet",
    }, undefined, undefined, undefined, lightning as unknown as DeskLightning);
    const member: Member = { name, desk, wallet, lightning, edges, messages, sent };
    this.members.set(name, member);
    return member;
  }

  /** Joins every two members with an edge. */
  mesh(): void {
    const names = [...this.members.keys()];
    for (const a of names) for (const b of names) if (a !== b) this.members.get(a)!.edges.set(`${a}${b}`, b);
  }

  async settle(): Promise<void> {
    while (this.queue.length) await this.queue.shift()!();
  }
}

async function group(...names: string[]) {
  const world = new World();
  const members = names.map(n => world.add(n));
  world.mesh();
  for (const m of members) await m.desk.start();
  return { world, members };
}
const view = (m: Member, id: string) => m.desk.views()[id];

describe("a request to the whole group", () => {
  it("goes to every member over their own edge, as one request on one rail", async () => {
    const { world, members: [a] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, memo: "pizza", timestamp: 1, rail: "cashu" });
    expect(a.sent.filter(s => s.kind === "req").map(s => s.linkId).sort()).toEqual(["AB", "AC"]);
    // Ecash only: no invoice rides along, so nothing else can pay it too.
    for (const s of a.sent) expect(s.frame.endpoints).toEqual([[ENDPOINT.cashu, expect.any(String)]]);
    expect(view(a, paymentId)).toMatchObject({ linkId: "group:g", group: "g", kind: "request", direction: "out", state: "pending", mints: [MINT] });
    expect(a.lightning.createInvoice).not.toHaveBeenCalled();
    await world.settle();
    for (const name of ["B", "C"]) expect(view(world.members.get(name)!, paymentId)).toMatchObject({ linkId: `${name}A`, kind: "request", direction: "in", state: "pending", memo: "pizza" });
  });

  it("is paid once: the first ecash settles it everywhere, a second is refused unredeemed and its payer takes it back", async () => {
    const { world, members: [a, b, c] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "cashu" });
    await world.settle();
    // Both pay at once: both tokens are on their way before A has seen either.
    await Promise.all([b.desk.payRequest({ linkId: "BA", paymentId }), c.desk.payRequest({ linkId: "CA", paymentId })]);
    await world.settle();

    expect(view(a, paymentId).state).toBe("settled");
    // A redeemed exactly one token: B's, which arrived first.
    expect(a.wallet.receiveToken).toHaveBeenCalledTimes(1);
    expect(a.wallet.receiveToken.mock.calls[0][0]).toMatch(/\|B1$/);
    const paidByB = Object.values(b.desk.views()).find(p => p.kind === "payment" && p.requestId === paymentId)!;
    const refusedC = Object.values(c.desk.views()).find(p => p.kind === "payment" && p.requestId === paymentId)!;
    expect(paidByB.state).toBe("settled");
    expect(refusedC).toMatchObject({ state: "reclaimed", error: "Already paid by another member of the group" });
    expect(c.wallet.receiveToken).toHaveBeenCalledWith(expect.stringMatching(/\|C1$/), "reclaimed", undefined);
    // Every member's copy of the request is closed, the payer's and the others'.
    expect(view(b, paymentId).state).toBe("settled");
    expect(view(c, paymentId).state).toBe("settled");
    // The receipt that closed them went to both edges.
    expect(a.sent.filter(s => s.kind === "res" && s.frame.id === paymentId && s.frame.ok).map(s => s.linkId).sort()).toEqual(["AB", "AC"]);
  });

  it("two tokens arriving at the same moment, while the mint is slow: one is redeemed, the other refused", async () => {
    const { world, members: [a] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "cashu" });
    await world.settle();
    const slow = a.wallet.receiveToken.getMockImplementation()!;
    a.wallet.receiveToken.mockImplementation(async (token: string) => { await new Promise(r => setTimeout(r, 20)); return slow(token); });
    const token = (id: string, who: string): Payment => ({ id, timestamp: 2, requestId: paymentId, amount: { value: "100", asset: "sat" }, endpoint: [ENDPOINT.cashu, `cashu|${MINT}|100|${who}`] });
    await Promise.all([a.desk.onPayment("AB", token("pb", "B")), a.desk.onPayment("AC", token("pc", "C"))]);
    expect(a.wallet.receiveToken).toHaveBeenCalledTimes(1);
    expect(a.sent.filter(s => s.kind === "res" && (s.frame.id === "pb" || s.frame.id === "pc")).map(s => [s.frame.id, s.frame.ok]).sort())
      .toEqual([["pb", true], ["pc", false]]);
  });

  it("receipts are idempotent: B's token sent again is answered as paid, not redeemed again; the request closed stays closed", async () => {
    const { world, members: [a, b] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "cashu" });
    await world.settle();
    await b.desk.payRequest({ linkId: "BA", paymentId });
    await world.settle();
    const token = b.sent.find(s => s.kind === "pay")!.frame as unknown as Payment;
    await a.desk.onPayment("AB", token);
    await a.desk.onPayment("AB", token);
    expect(a.wallet.receiveToken).toHaveBeenCalledTimes(1);
    expect(a.sent.filter(s => s.kind === "res" && s.frame.id === token.id).map(s => s.frame.ok)).toEqual([true, true, true]);
    await a.desk.onPaymentResult("AB", { id: paymentId, ok: false });
    expect(view(a, paymentId).state).toBe("settled");
  });

  it("a token that would not settle it (too little, another mint) is refused before anything is redeemed", async () => {
    const { world, members: [a] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "cashu" });
    await world.settle();
    for (const [id, token] of [["p-short", `cashu|${MINT}|50|x`], ["p-mint", `cashu|${OTHER_MINT}|100|y`]] as const)
      await a.desk.onPayment("AC", { id, timestamp: 2, requestId: paymentId, amount: { value: "100", asset: "sat" }, endpoint: [ENDPOINT.cashu, token] });
    expect(a.wallet.receiveToken).not.toHaveBeenCalled();
    expect(a.sent.filter(s => s.kind === "res").map(s => [s.frame.id, s.frame.ok, s.frame.error])).toEqual([
      ["p-short", false, "This ecash does not pay the request: the amount or the mint differs"],
      ["p-mint", false, "This ecash does not pay the request: the amount or the mint differs"],
    ]);
    expect(view(a, paymentId).state).toBe("pending");
  });

  it("on Lightning: one invoice for everyone; paid once, it closes on every member and nobody can pay it again", async () => {
    const { world, members: [a, b, c] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "lightning" });
    expect(a.lightning.createInvoice).toHaveBeenCalledTimes(1);
    for (const s of a.sent) expect(s.frame.endpoints).toEqual([[ENDPOINT.bolt11, "lnbc-A"]]);
    await world.settle();
    await c.desk.payRequest({ linkId: "CA", paymentId, via: "lightning" });
    expect(view(c, paymentId)).toMatchObject({ state: "settled", paidHere: true });
    // A's own wallet sees its invoice paid.
    await a.desk.onLightningPaid({ paymentId, mint: MINT });
    await world.settle();
    expect(view(a, paymentId).state).toBe("settled");
    expect(view(b, paymentId).state).toBe("settled");
    await expect(b.desk.payRequest({ linkId: "BA", paymentId, via: "lightning" })).rejects.toThrow("no longer open");
    expect(b.lightning.pay).not.toHaveBeenCalled();
  });

  it("a member whose edge was down gets the request when it opens, and a request already paid is closed on their side instead", async () => {
    const { world, members: [a, b, c] } = await group("A", "B", "C");
    world.down.add("AC");
    const { paymentId } = await a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "cashu" });
    await world.settle();
    expect(view(c, paymentId)).toBeUndefined();
    world.down.delete("AC");
    await a.desk.replay("AC");
    await world.settle();
    expect(view(c, paymentId)).toMatchObject({ state: "pending", linkId: "CA" });

    await b.desk.payRequest({ linkId: "BA", paymentId });
    world.down.add("AC");
    await world.settle();
    expect(view(c, paymentId).state).toBe("pending");
    world.down.delete("AC");
    await a.desk.replay("AC");
    await world.settle();
    expect(view(c, paymentId).state).toBe("settled");
  });

  it("wants Cashu or Lightning, a mint for Cashu, and a whole amount", async () => {
    const { members: [a] } = await group("A", "B");
    await expect(a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "bitcoin" as never })).rejects.toThrow("Cashu or over Lightning");
    await expect(a.desk.requestFromGroup({ groupId: "g", amount: 0, timestamp: 1, rail: "cashu" })).rejects.toThrow();
    a.wallet.view.mockResolvedValue({ mints: [] });
    await expect(a.desk.requestFromGroup({ groupId: "g", amount: 100, timestamp: 1, rail: "cashu" })).rejects.toThrow("You have no Testnet Cashu wallet");
  });
});

describe("a payment with one member", () => {
  it("travels only on the edge to that member", async () => {
    const { world, members: [a, b, c] } = await group("A", "B", "C");
    const { paymentId } = await a.desk.request({ linkId: "AB", amount: 100, timestamp: 1, rail: "cashu" });
    await world.settle();
    expect(a.sent.map(s => s.linkId)).toEqual(["AB"]);
    expect(view(b, paymentId)).toMatchObject({ linkId: "BA", direction: "in" });
    expect(view(c, paymentId)).toBeUndefined();
    await b.desk.payRequest({ linkId: "BA", paymentId });
    await world.settle();
    expect(view(a, paymentId).state).toBe("settled");
    expect(c.sent).toEqual([]);
    // An edge's request is not a group's: another member's token for it is not accepted as payment.
    expect(view(a, paymentId).group).toBeUndefined();
  });

  it("a request made on a card carries only that card's way of paying", async () => {
    const { members: [a] } = await group("A", "B");
    await a.desk.request({ linkId: "AB", amount: 100, timestamp: 1, rail: "cashu" });
    await a.desk.request({ linkId: "AB", amount: 100, timestamp: 2, rail: "lightning" });
    await a.desk.request({ linkId: "AB", amount: 100, timestamp: 3 });
    const endpoints = a.sent.map(s => (s.frame.endpoints as [string, string][]).map(e => e[0]));
    expect(endpoints).toEqual([[ENDPOINT.cashu], [ENDPOINT.bolt11], [ENDPOINT.bolt11, ENDPOINT.cashu]]);
  });
});
