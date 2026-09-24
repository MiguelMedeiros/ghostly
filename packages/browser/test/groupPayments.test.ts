import { describe, expect, it } from "vitest";
import { GroupPayments, authoredNote, mayAuthor, mergeGroupPay, parseGroupPay, type GroupPaymentsHost, type Placement } from "../src/engine/groupPayments";
import type { GroupPayFrame, GroupPayNote, PaymentView, StoredMessage } from "../src/shared/types";
// covers: groups.payments.member, groups.payments.group-request, groups.payments.notes

/**
 * What a group sees of payments between its members (WISP 9xx § Payments): `group-pay` notes, believed only from
 * the member they are about, merged forward only, and said by each device about its own part.
 */

const key = (c: string) => c.repeat(52);
const A = key("a"), B = key("b"), C = key("c"), D = key("d"), X = key("x");
const members = new Set([A, B, C, D]);
const note = (patch: Partial<GroupPayFrame> = {}): GroupPayFrame => ({ t: "group-pay", g: "g1", id: "req-00001", k: "req", f: B, to: A, v: "100", u: "sat", d: 0, r: "cashu", ts: 1, st: "open", ...patch });
const pay = (patch: Partial<PaymentView> & { id: string }): PaymentView => ({ linkId: "AB", kind: "request", direction: "out", amount: 100, unit: "sat", state: "pending", createdAt: 1, ...patch });

describe("parseGroupPay: strict, or dropped", () => {
  it("keeps a well-formed note for this group", () => {
    expect(parseGroupPay(note({ m: "pizza", x: 1 }), "g1")).toEqual(note({ m: "pizza", x: 1 }));
  });
  it.each<[string, Record<string, unknown>]>([
    ["another group", { g: "g2" }], ["an unknown kind", { k: "gift" }], ["a bad id", { id: "x" }], ["a bad key", { to: "nope" }],
    ["paying oneself", { f: A }], ["everyone paying a payment", { k: "pay", f: "*" }], ["a zero amount", { v: "0" }], ["a fractional amount", { v: "1.5" }],
    ["an unknown rail", { r: "paypal" }], ["an unknown state", { st: "maybe" }], ["a long memo", { m: "x".repeat(141) }], ["a bad payer claim", { by: "x" }],
    ["too many decimals", { d: 19 }], ["no timestamp", { ts: "now" }], ["a flag that is not 1", { x: true }],
  ])("drops %s", (_, patch) => {
    expect(parseGroupPay({ ...note(), ...patch }, "g1")).toBeNull();
  });
  it("drops what is not a group-pay frame", () => {
    for (const raw of [null, "x", { t: "group-msg" }]) expect(parseGroupPay(raw, "g1")).toBeNull();
  });
});

describe("mayAuthor: a note is believed only from the member it is about", () => {
  it("a request's state is the payee's to say", () => {
    for (const st of ["open", "paid", "closed"] as const) {
      expect(mayAuthor(note({ st }), A, members), st).toBe(true);
      expect(mayAuthor(note({ st }), B, members), `${st} from the payer`).toBe(false);
      expect(mayAuthor(note({ st }), C, members), `${st} from a bystander`).toBe(false);
    }
    // The payee does not claim to have paid itself.
    expect(mayAuthor(note({ st: "sent", by: A }), A, members)).toBe(false);
  });
  it("a payer says only that it paid (or took that back), about itself", () => {
    expect(mayAuthor(note({ st: "sent", by: B }), B, members)).toBe(true);
    expect(mayAuthor(note({ st: "closed", by: B }), B, members)).toBe(true);
    expect(mayAuthor(note({ st: "sent", by: C }), C, members), "someone else's request to B").toBe(false);
    expect(mayAuthor(note({ f: "*", st: "sent", by: C }), C, members), "a request to the group").toBe(true);
    expect(mayAuthor(note({ f: "*", st: "sent", by: C }), D, members), "a claim for someone else").toBe(false);
  });
  it("a payment without a request: sent or taken back by the payer, paid by the payee", () => {
    const p = (st: GroupPayFrame["st"]) => note({ k: "pay", f: B, to: A, st });
    expect(mayAuthor(p("sent"), B, members)).toBe(true);
    expect(mayAuthor(p("closed"), B, members)).toBe(true);
    expect(mayAuthor(p("paid"), A, members)).toBe(true);
    expect(mayAuthor(p("paid"), B, members)).toBe(false);
    expect(mayAuthor(p("sent"), A, members)).toBe(false);
  });
  it("names only members, and never names the payee as its own payer", () => {
    expect(mayAuthor(note({ to: X }), X, members)).toBe(false);
    expect(mayAuthor(note({ f: X }), A, members)).toBe(false);
    expect(mayAuthor(note({ f: "*", st: "paid", by: X }), A, members)).toBe(false);
    expect(mayAuthor(note({ f: "*", st: "paid", by: A }), A, members)).toBe(false);
    expect(mayAuthor(note({ st: "paid", by: C }), A, members), "paid by someone other than the payer named").toBe(false);
  });
});

describe("mergeGroupPay: forward only, the initiator describes it", () => {
  const merge = (current: GroupPayNote | undefined, frame: GroupPayFrame, author: string) => mergeGroupPay(current, frame, author, members);

  it("a request opens, is claimed, and is paid; paid is final", () => {
    const open = merge(undefined, note({ f: "*" }), A)!;
    expect(open).toMatchObject({ id: "req-00001", kind: "request", from: "*", to: A, amount: "100", state: "open" });
    const claimed = merge(open, note({ f: "*", st: "sent", by: C }), C)!;
    expect(claimed).toMatchObject({ state: "open", claims: [C] });
    const paid = merge(claimed, note({ f: "*", st: "paid", by: C }), A)!;
    expect(paid).toMatchObject({ state: "paid", by: C });
    expect(merge(paid, note({ f: "*", st: "open" }), A), "never back to open").toBeUndefined();
    expect(merge(paid, note({ f: "*", st: "closed" }), A), "nor closed").toBeUndefined();
  });

  it("an invoice does not say who paid: one claim names them, two do not", () => {
    const open = merge(undefined, note({ f: "*", r: "lightning" }), A)!;
    const one = merge(open, note({ f: "*", r: "lightning", st: "sent", by: C }), C)!;
    expect(merge(one, note({ f: "*", r: "lightning", st: "paid" }), A)).toMatchObject({ state: "paid", by: C });
    const two = merge(one, note({ f: "*", r: "lightning", st: "sent", by: D }), D)!;
    expect(two.claims).toEqual([C, D].sort());
    expect(merge(two, note({ f: "*", r: "lightning", st: "paid" }), A)!.by).toBeUndefined();
  });

  it("a payer takes its claim back when its payment came back", () => {
    const claimed = merge(merge(undefined, note({ f: "*" }), A), note({ f: "*", st: "sent", by: C }), C)!;
    const back = merge(claimed, note({ f: "*", st: "closed", by: C }), C)!;
    expect(back.claims).toBeUndefined();
    expect(back.state).toBe("open");
  });

  it("the payee's description wins over a claim that arrived first; nobody changes who is paid", () => {
    const early = merge(undefined, note({ f: "*", st: "sent", by: C, v: "999" }), C)!;
    expect(early).toMatchObject({ amount: "999", claims: [C] });
    const described = merge(early, note({ f: "*", v: "100", m: "pizza" }), A)!;
    expect(described).toMatchObject({ amount: "100", memo: "pizza", claims: [C], state: "open" });
    expect(merge(described, note({ to: B, f: A }), B), "another payee for the same id").toBeUndefined();
  });

  it("a direct payment: sent, then paid by the payee's word", () => {
    const sent = merge(undefined, note({ k: "pay", f: B, to: A, st: "sent", id: "pay-00001" }), B)!;
    expect(sent).toMatchObject({ kind: "payment", state: "sent" });
    expect(merge(sent, note({ k: "pay", f: B, to: A, st: "paid", id: "pay-00001" }), A)).toMatchObject({ state: "paid", by: B });
  });

  it("repeating what is known changes nothing (idempotent)", () => {
    const open = merge(undefined, note(), A)!;
    expect(merge(open, note(), A)).toBeUndefined();
  });
});

describe("authoredNote: what this device says about its own payments", () => {
  const atA: Placement = { groupId: "g1", me: A, peer: B };
  it("my request to one member: open, then paid by them", () => {
    const r = pay({ id: "req-00001", mints: ["https://testnut.cashu.space"] });
    expect(authoredNote(r, atA, [r])).toMatchObject({ k: "req", f: B, to: A, st: "open", r: "cashu", x: 1 });
    expect(authoredNote({ ...r, state: "settled" }, atA, [r])).toMatchObject({ st: "paid", by: B });
  });
  it("my request to the group names who paid from the edge the ecash came on, or the only claim", () => {
    const r = pay({ id: "req-00001", linkId: "group:g1", group: "g1", mints: ["https://mint.real"], state: "settled" });
    const ecash = pay({ id: "p1", kind: "payment", direction: "in", requestId: r.id, state: "settled", linkId: "AC" });
    expect(authoredNote(r, { groupId: "g1", me: A }, [r, ecash], undefined, id => id === "AC" ? C : undefined)).toMatchObject({ f: "*", to: A, st: "paid", by: C });
    const invoice = { ...r, invoice: "lnbc1", mints: [] };
    expect(authoredNote(invoice, { groupId: "g1", me: A }, [invoice], { claims: [D] } as GroupPayNote)).toMatchObject({ r: "lightning", st: "paid", by: D });
    expect(authoredNote(invoice, { groupId: "g1", me: A }, [invoice], { claims: [C, D] } as GroupPayNote)!.by).toBeUndefined();
  });
  it("paying someone's request: nothing until paid, sent once paid, taken back when the ecash came back", () => {
    const atB: Placement = { groupId: "g1", me: B, peer: A };
    const r = pay({ id: "req-00001", direction: "in", linkId: "BA" });
    expect(authoredNote(r, atB, [r])).toBeNull();
    const out = pay({ id: "p1", kind: "payment", direction: "out", requestId: r.id, linkId: "BA", state: "pending" });
    const sent = authoredNote(r, atB, [r, out])!;
    expect(sent).toMatchObject({ k: "req", f: B, to: A, st: "sent", by: B });
    expect(authoredNote(out, atB, [r, out]), "said through the request").toBeNull();
    const current = { from: "*", mine: sent } as GroupPayNote;
    expect(authoredNote(r, atB, [r, { ...out, state: "reclaimed" }], current)).toMatchObject({ f: "*", st: "closed", by: B });
    expect(authoredNote({ ...r, paidHere: true, state: "settled" }, atB, [r])).toMatchObject({ st: "sent", by: B });
  });
  it("a payment without a request: sent by me, paid on the other side", () => {
    const out = pay({ id: "p1", kind: "payment", direction: "out", state: "pending" });
    expect(authoredNote(out, atA, [out])).toMatchObject({ k: "pay", f: A, to: B, st: "sent" });
    expect(authoredNote({ ...out, state: "reclaimed" }, atA, [out])).toMatchObject({ st: "closed" });
    const received = pay({ id: "p2", kind: "payment", direction: "in", state: "settled" });
    expect(authoredNote(received, atA, [received])).toMatchObject({ k: "pay", f: B, to: A, st: "paid" });
    expect(authoredNote({ ...received, state: "pending" }, atA, [received])).toBeNull();
  });
  it("USDT carries its decimals; on-chain says whether it is test money", () => {
    const usdt = pay({ id: "req-00002", unit: "testusdt", target: { method: "usdt", decimals: 6 } as PaymentView["target"] });
    expect(authoredNote(usdt, atA, [usdt])).toMatchObject({ u: "testusdt", d: 6, r: "usdt", x: 1 });
    const btc = pay({ id: "req-00003", target: { method: "bitcoin", network: "bitcoin" } as PaymentView["target"] });
    expect(authoredNote(btc, atA, [btc])).not.toHaveProperty("x");
  });
});

/** Two members' GroupPayments over a fake mesh: notes go on every edge; the group's history is a list. */
function world(names: Record<string, string>) {
  const history = new Map<string, StoredMessage[]>();
  const peers = new Map<string, { payments: PaymentView[]; engine: GroupPayments; sent: { to: string; frame: Record<string, unknown> }[]; down: Set<string> }>();
  for (const [me, key] of Object.entries(names)) {
    const sent: { to: string; frame: Record<string, unknown> }[] = [];
    const payments: PaymentView[] = [];
    const down = new Set<string>();
    const host: GroupPaymentsHost = {
      payments: () => payments,
      edgeOf: linkId => { const other = Object.entries(names).find(([n]) => linkId === `${me}${n}`); return other ? { groupId: "g1", member: other[1] } : undefined; },
      edges: () => new Map(Object.entries(names).filter(([n]) => n !== me).map(([n, k]) => [k, `${me}${n}`])),
      membership: () => ({ me: key, members: new Set(Object.values(names)) }),
      send: (linkId, frame) => { if (down.has(linkId)) throw new Error("down"); sent.push({ to: linkId, frame: frame as Record<string, unknown> }); },
      messages: async () => history.get(me) ?? [],
      putMessage: async message => { const list = (history.get(me) ?? []).filter(m => m.id !== message.id); history.set(me, [...list, message]); },
    };
    peers.set(me, { payments, engine: new GroupPayments(host), sent, down });
  }
  const deliver = async () => {
    for (const [from, peer] of peers) for (const { to, frame } of peer.sent.splice(0)) {
      const name = to.slice(from.length);
      await peers.get(name)!.engine.receive("g1", names[from], frame);
    }
  };
  const noteOf = (name: string, id: string) => history.get(name)?.find(m => m.groupPay?.id === id)?.groupPay;
  return { peers, deliver, noteOf, history };
}

describe("GroupPayments: every member hears it, the parties say it", () => {
  it("a request between A and B reaches C as a note, and turns paid when A's wallet says so", async () => {
    const { peers, deliver, noteOf, history } = world({ A, B, C });
    const request = pay({ id: "req-00001", linkId: "AB", mints: ["https://testnut.cashu.space"], memo: "lunch" });
    peers.get("A")!.payments.push(request);
    await peers.get("A")!.engine.sync();
    expect(peers.get("A")!.sent.map(s => s.to).sort()).toEqual(["AB", "AC"]);
    await deliver();
    expect(noteOf("C", "req-00001")).toMatchObject({ from: B, to: A, state: "open", memo: "lunch", test: true });
    expect(history.get("C")![0]).toMatchObject({ linkId: "group:g1", id: "gpay:req-00001", sender: "peer", member: A });

    // B pays: its app says so; A's wallet confirms.
    peers.get("B")!.payments.push({ ...request, linkId: "BA", direction: "in" }, pay({ id: "p1", kind: "payment", direction: "out", requestId: "req-00001", linkId: "BA" }));
    await peers.get("B")!.engine.sync();
    await deliver();
    expect(noteOf("C", "req-00001")).toMatchObject({ state: "open", claims: [B] });
    peers.get("A")!.payments[0] = { ...request, state: "settled" };
    await peers.get("A")!.engine.sync();
    await deliver();
    expect(noteOf("C", "req-00001")).toMatchObject({ state: "paid", by: B });
    // Saying the same again sends nothing.
    await peers.get("A")!.engine.sync();
    expect(peers.get("A")!.sent).toEqual([]);
  });

  it("a member whose edge was down hears the note when it opens", async () => {
    const { peers, deliver, noteOf } = world({ A, B, C });
    peers.get("A")!.down.add("AC");
    peers.get("A")!.payments.push(pay({ id: "req-00001", linkId: "AB" }));
    await peers.get("A")!.engine.sync();
    await deliver();
    expect(noteOf("C", "req-00001")).toBeUndefined();
    peers.get("A")!.down.delete("AC");
    await peers.get("A")!.engine.edgeReady("g1", "AC");
    await deliver();
    expect(noteOf("C", "req-00001")).toMatchObject({ state: "open", to: A });
  });

  it("a note from someone it is not about is not kept", async () => {
    const { peers, noteOf } = world({ A, B, C });
    await peers.get("C")!.engine.receive("g1", B, note({ st: "paid", by: B }));
    await peers.get("C")!.engine.receive("g1", B, { t: "group-pay", junk: true });
    expect(noteOf("C", "req-00001")).toBeUndefined();
  });
});
