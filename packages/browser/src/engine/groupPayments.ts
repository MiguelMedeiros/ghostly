import { MEMBER_KEY } from "@ghostly/core";
import { isWorthlessMint } from "../shared/mints";
import type { GroupPayFrame, GroupPayNote, GroupPayRail, PaymentView, StoredMessage } from "../shared/types";

/**
 * Payments in a group (WISP 9xx § Payments). The money, the invoice and the receipts travel only on the edge
 * between the two members, as they would on a 1:1 chat (the PaymentDesk does that part, with the edge's link as
 * the chat). What the rest of the group learns is a `group-pay` note, sent by each side about its own part over
 * every edge: who pays whom, how much, over what, and how it stands. A note is believed only from the member it
 * is about: the payee says a request is open or paid, the payer that it sent.
 */

const RAILS: readonly GroupPayRail[] = ["cashu", "lightning", "arkade", "bark", "bitcoin", "usdt", "fedimint"];
const STATES: readonly GroupPayNote["state"][] = ["open", "sent", "paid", "closed"];
/** How settled a note is: a note only ever moves forward, and paid is final. */
const RANK: Record<GroupPayNote["state"], number> = { open: 0, sent: 1, closed: 2, paid: 3 };
const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Notes of mine sent again to a member whose edge opens. */
const RESEND = 32;
export const NOTE_ID = (id: string) => `gpay:${id}`;

/** A `group-pay` frame, strictly: anything else is dropped. */
export function parseGroupPay(raw: unknown, groupId: string): GroupPayFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.t !== "group-pay" || f.g !== groupId || typeof f.id !== "string" || !ID.test(f.id)) return null;
  if (f.k !== "req" && f.k !== "pay") return null;
  if (typeof f.f !== "string" || !(MEMBER_KEY.test(f.f) || (f.f === "*" && f.k === "req"))) return null;
  if (typeof f.to !== "string" || !MEMBER_KEY.test(f.to) || f.to === f.f) return null;
  if (typeof f.v !== "string" || !/^[1-9]\d{0,17}$/.test(f.v)) return null;
  if (typeof f.u !== "string" || !/^[a-z]{1,12}$/.test(f.u)) return null;
  if (!Number.isInteger(f.d) || (f.d as number) < 0 || (f.d as number) > 18) return null;
  if (!RAILS.includes(f.r as GroupPayRail) || !STATES.includes(f.st as GroupPayNote["state"])) return null;
  if (!Number.isSafeInteger(f.ts)) return null;
  if (f.m !== undefined && (typeof f.m !== "string" || f.m.length > 140)) return null;
  if (f.by !== undefined && (typeof f.by !== "string" || !MEMBER_KEY.test(f.by))) return null;
  if ((f.x !== undefined && f.x !== 1) || (f.a !== undefined && f.a !== 1)) return null;
  return { t: "group-pay", g: groupId, id: f.id, k: f.k, f: f.f, to: f.to, v: f.v, u: f.u, d: f.d as number, r: f.r as GroupPayRail,
    ...(f.x ? { x: 1 as const } : {}), ...(f.m ? { m: f.m as string } : {}), ...(f.a ? { a: 1 as const } : {}), ts: f.ts as number, st: f.st as GroupPayNote["state"], ...(f.by ? { by: f.by as string } : {}) };
}

/**
 * Whether `author` may say this. A request's state (open, paid, closed) is the payee's to say; a member who paid
 * it says so about itself (`sent`, `by` = itself), and takes that back (`closed`) when its payment came back. A
 * payment without a request: the payer says it sent it (or took it back), the payee that it was paid. Whoever a
 * note names must be in the group.
 */
export function mayAuthor(frame: GroupPayFrame, author: string, members: ReadonlySet<string>): boolean {
  if (!members.has(author) || !members.has(frame.to) || (frame.f !== "*" && !members.has(frame.f)) || (frame.by && !members.has(frame.by))) return false;
  if (frame.by && (frame.by === frame.to || (frame.f !== "*" && frame.by !== frame.f))) return false;
  if (frame.k === "req") {
    if (author === frame.to) return frame.st !== "sent";
    return (frame.st === "sent" || frame.st === "closed") && author === frame.by && (frame.f === "*" || frame.f === author);
  }
  if (frame.st === "paid") return author === frame.to;
  return (frame.st === "sent" || frame.st === "closed") && author === frame.f;
}

const fieldsOf = (frame: GroupPayFrame): Omit<GroupPayNote, "state" | "by" | "claims" | "mine"> => ({
  id: frame.id, kind: frame.k === "req" ? "request" : "payment", from: frame.f, to: frame.to, amount: frame.v, unit: frame.u, decimals: frame.d, rail: frame.r,
  ...(frame.x ? { test: true } : {}), ...(frame.m ? { memo: frame.m } : {}), ...(frame.a ? { ask: true } : {}), createdAt: frame.ts,
});

/**
 * The note after `author` said `frame`, or undefined when that changes nothing (or may not be believed). What a
 * payment is (who, how much, over what) is its initiator's to say: the payee's for a request, the payer's for a
 * payment; anyone else's description only stands in until the initiator's arrives. States only move forward.
 */
export function mergeGroupPay(current: GroupPayNote | undefined, frame: GroupPayFrame, author: string, members: ReadonlySet<string>): GroupPayNote | undefined {
  if (!mayAuthor(frame, author, members)) return undefined;
  const initiator = frame.k === "req" ? frame.to : frame.f;
  const fields = fieldsOf(frame);
  if (current && (current.kind !== fields.kind || current.to !== fields.to)) return undefined;
  let next: GroupPayNote = current ? { ...current } : { ...fields, state: "open" };
  // Until the initiator's own note arrives, a claim's description stands in for it.
  if (author === initiator) next = { ...next, ...fields };
  if (frame.k === "req" && author !== frame.to) {
    // A payer's word about its own payment: a claim, not the request's state.
    const claims = frame.st === "sent" ? [...new Set([...(next.claims ?? []), author])].sort() : (next.claims ?? []).filter(k => k !== author);
    next = claims.length ? { ...next, claims } : (({ claims: _, ...rest }) => rest)(next);
  } else if (RANK[frame.st] > RANK[next.state]) next = { ...next, state: frame.st };
  if (frame.st === "paid" && frame.by) next = { ...next, by: frame.by };
  // An invoice does not say who paid it: when exactly one member says they did, that is who.
  if (next.state === "paid" && !next.by && next.from === "*" && next.claims?.length === 1) next = { ...next, by: next.claims[0] };
  if (next.state === "paid" && next.from !== "*" && !next.by) next = { ...next, by: next.from };
  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
}

/** Where a desk record sits in a group, if it does: the group, and the member at the other end (none for a request to all). */
export interface Placement { groupId: string; me: string; peer?: string }

const railOf = (p: PaymentView): GroupPayRail =>
  p.target ? (p.target.method === "cashu" ? "cashu" : p.target.method) : p.invoice && !p.mints?.length && !p.mint ? "lightning" : "cashu";
const testOf = (p: PaymentView): boolean => p.target
  ? (p.target.method === "cashu" ? p.target.network === "cashu-test" : p.target.method === "usdt" ? p.unit === "testusdt" : p.target.network !== "bitcoin")
  : p.mint ? isWorthlessMint(p.mint) : p.mints?.length ? p.mints.every(isWorthlessMint) : false;

/**
 * What this device says about one of its own payments in a group, or null when it says nothing (not a group's,
 * or nothing to say yet). `all` is every desk record, to find a request's payments and whether this device paid it.
 */
export function authoredNote(p: PaymentView, at: Placement, all: readonly PaymentView[], current?: GroupPayNote, memberOf: (linkId: string) => string | undefined = () => undefined): GroupPayFrame | null {
  const base = { t: "group-pay" as const, g: at.groupId, id: p.id, v: String(p.amount), u: p.unit, d: p.target?.method === "usdt" ? p.target.decimals ?? 6 : 0, r: railOf(p),
    ...(testOf(p) ? { x: 1 as const } : {}), ...(p.memo ? { m: p.memo.slice(0, 140) } : {}), ...(p.ask ? { a: 1 as const } : {}), ts: p.createdAt };
  if (p.kind === "request" && p.direction === "out") {
    // Mine to be paid: open until paid, and who paid it when my wallet knows (ecash comes in on the payer's edge).
    const from = p.group ? "*" : at.peer;
    if (!from) return null;
    const payment = all.find(x => x.kind === "payment" && x.direction === "in" && x.requestId === p.id && x.state === "settled");
    const by = !p.group ? from : payment ? memberOf(payment.linkId) : current?.claims?.length === 1 ? current.claims[0] : undefined;
    const st = p.state === "settled" ? "paid" : p.state === "failed" || p.state === "reclaimed" ? "closed" : "open";
    return { ...base, k: "req", f: from, to: at.me, st, ...(st === "paid" && by ? { by } : {}) };
  }
  if (!at.peer) return null;
  if (p.kind === "request" && p.direction === "in") {
    // Someone's request: I say I paid it once my payment is out (ecash sent, a reviewed payment, an invoice paid
    // here), and take that back when it came back. Nothing while I have not paid it.
    const paid = (p.paidHere && (p.lightningPending || p.state === "settled"))
      || all.some(x => x.kind === "payment" && x.direction === "out" && x.requestId === p.id && (x.state === "pending" || x.state === "settled"));
    const said = current?.mine?.k === "req" && current.mine.by === at.me && current.mine.st === "sent";
    if (!paid && !said) return null;
    return { ...base, k: "req", f: current && current.from === "*" ? "*" : at.me, to: at.peer, st: paid ? "sent" : "closed", by: at.me };
  }
  // A payment that answers a request is said through the request, above.
  if (p.kind === "payment" && p.requestId) return null;
  if (p.kind === "payment" && p.direction === "out") return { ...base, k: "pay", f: at.me, to: at.peer, st: p.state === "failed" || p.state === "reclaimed" ? "closed" : "sent" };
  if (p.kind === "payment" && p.direction === "in" && p.state === "settled") return { ...base, k: "pay", f: at.peer, to: at.me, st: "paid" };
  return null;
}



export interface GroupPaymentsHost {
  /** Every payment record this device keeps. */
  payments(): PaymentView[];
  /** The group and member of an edge link. */
  edgeOf(linkId: string): { groupId: string; member: string } | undefined;
  /** Member key → edge link id, for the edges of a group that exist. */
  edges(groupId: string): Map<string, string>;
  /** My member key in a group, and who is in it; undefined when I am not in it. */
  membership(groupId: string): { me: string; members: ReadonlySet<string> } | undefined;
  /** Sends on an edge; throws when it is down. */
  send(linkId: string, frame: object): void;
  /** The group's history, for the notes already kept. */
  messages(groupId: string): Promise<StoredMessage[]>;
  /** Writes (or rewrites) a line of the group's history. */
  putMessage(message: StoredMessage): Promise<void>;
}

export class GroupPayments {
  private readonly notes = new Map<string, Map<string, GroupPayNote>>();
  private queue = Promise.resolve();

  constructor(private readonly host: GroupPaymentsHost) {}

  /** A `group-pay` frame from the member an edge is pinned to. */
  receive(groupId: string, author: string, raw: unknown): Promise<void> {
    return this.run(async () => {
      const frame = parseGroupPay(raw, groupId), membership = this.host.membership(groupId);
      if (!frame || !membership) return;
      const notes = await this.load(groupId);
      const next = mergeGroupPay(notes.get(frame.id), frame, author, membership.members);
      if (next) await this.write(groupId, membership.me, next);
      // A single claim may name who paid my request to the group.
      await this.author();
    });
  }

  /** Says what changed about this device's own payments in groups. The engine calls it whenever payments change. */
  sync(): Promise<void> { return this.run(() => this.author()); }

  /** An edge came up: the member hears again what I said lately, in case it missed it. */
  edgeReady(groupId: string, linkId: string): Promise<void> {
    return this.run(async () => {
      const mine = [...(await this.load(groupId)).values()].filter(n => n.mine).sort((a, b) => b.createdAt - a.createdAt).slice(0, RESEND);
      for (const note of mine.reverse()) { try { this.host.send(linkId, note.mine!); } catch { return; } }
    });
  }

  private run(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private async author(): Promise<void> {
    const all = this.host.payments();
    // Once per group per pass: a device may keep many payments, in few groups.
    const known = new Map<string, ReturnType<GroupPaymentsHost["membership"]>>();
    const membership = (groupId: string) => { if (!known.has(groupId)) known.set(groupId, this.host.membership(groupId)); return known.get(groupId); };
    for (const p of all) {
      const at = this.placement(p, membership);
      if (!at) continue;
      const notes = await this.load(at.groupId);
      const current = notes.get(p.id);
      const frame = authoredNote(p, at, all, current, linkId => this.host.edgeOf(linkId)?.member);
      if (!frame || JSON.stringify(frame) === JSON.stringify(current?.mine)) continue;
      const merged = mergeGroupPay(current, frame, at.me, membership(at.groupId)!.members) ?? current;
      if (!merged) continue;
      await this.write(at.groupId, at.me, { ...merged, mine: frame });
      for (const linkId of this.host.edges(at.groupId).values()) { try { this.host.send(linkId, frame); } catch { /* sent again when that edge opens */ } }
    }
  }

  private placement(p: PaymentView, membership: GroupPaymentsHost["membership"]): Placement | undefined {
    if (p.group) { const m = membership(p.group); return m ? { groupId: p.group, me: m.me } : undefined; }
    const edge = this.host.edgeOf(p.linkId);
    if (!edge) return undefined;
    const m = membership(edge.groupId);
    return m ? { groupId: edge.groupId, me: m.me, peer: edge.member } : undefined;
  }

  private async load(groupId: string): Promise<Map<string, GroupPayNote>> {
    let notes = this.notes.get(groupId);
    if (!notes) {
      notes = new Map((await this.host.messages(groupId)).filter(m => m.groupPay).map(m => [m.groupPay!.id, m.groupPay!]));
      this.notes.set(groupId, notes);
    }
    return notes;
  }

  private async write(groupId: string, me: string, note: GroupPayNote): Promise<void> {
    this.notes.get(groupId)?.set(note.id, note);
    const initiator = note.kind === "request" ? note.to : note.from;
    await this.host.putMessage({ linkId: `group:${groupId}`, id: NOTE_ID(note.id), text: summary(note), sender: initiator === me ? "me" : "peer", member: initiator,
      timestamp: note.createdAt, via: "datalink", groupPay: note });
  }
}

/** A plain line for previews and old views; the group page draws the note itself. */
function summary(note: GroupPayNote): string {
  const amount = note.decimals ? `${note.amount} base units of ${note.unit}` : `${Number(note.amount).toLocaleString()} ${note.test ? "test sats" : "sats"}`;
  return note.kind === "request" ? `⚡ Requested ${amount}` : `⚡ Sent ${amount}`;
}
