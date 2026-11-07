import { MEMBER_KEY } from "@ghostly/core";
import { isWorthlessMint } from "../shared/mints";
import { paymentWireId } from "../shared/paymentIds";
import type { GroupPayFrame, GroupPayNote, GroupPayRail, GroupView, PaymentView, StoredMessage } from "../shared/types";

/**
 * Payments in a group (WISP 902 § Payments). The money, the invoice and the receipts travel only on the edge
 * between the two members, as they would on a 1:1 chat (the PaymentDesk does that part, with the edge's link as
 * the chat). What the rest of the group learns is a `group-pay` note, sent by each side about its own part over
 * every edge: who pays whom, how much, over what, and how it stands. A note is believed only from the member it
 * is about: the payee says a request is open or paid, the payer that it sent.
 */

const RAILS: readonly GroupPayRail[] = ["cashu", "lightning", "arkade", "bark", "bitcoin", "spark", "usdt", "fedimint"];
const STATES: readonly GroupPayNote["state"][] = ["open", "sent", "paid", "closed"];
/** How settled a note is: a note only ever moves forward, and paid is final. */
const RANK: Record<GroupPayNote["state"], number> = { open: 0, sent: 1, closed: 2, paid: 3 };
const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Notes of mine sent again to a member whose edge opens. */
const RESEND = 32;
/** Notes from others still waiting for their initiator, kept per group in memory only; the oldest go first. */
export const WAITING = 256;
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
 * note names must be in the group, but for the payee's `paid` naming a payer who left since: `known` (the note so
 * far) shows that payer was in the group when a note naming it was believed (its own `sent`, or the request or
 * payment made with it as the payer).
 */
export function mayAuthor(frame: GroupPayFrame, author: string, members: ReadonlySet<string>, known?: GroupPayNote): boolean {
  const left = (key: string) => frame.st === "paid" && author === frame.to && !!known && (known.from === key || (key === frame.by && !!known.claims?.includes(key)));
  const named = (key: string) => members.has(key) || left(key);
  if (!members.has(author) || !members.has(frame.to) || (frame.f !== "*" && !named(frame.f)) || (frame.by && !named(frame.by))) return false;
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

/** Whether `author`'s `frame` may count for the note kept so far: one about another payment under the same id never does. */
const believed = (current: GroupPayNote | undefined, frame: GroupPayFrame, author: string, members: ReadonlySet<string>): boolean =>
  mayAuthor(frame, author, members, current) && (!current || (current.kind === (frame.k === "req" ? "request" : "payment") && current.to === frame.to));

/**
 * The note after `author` said `frame`, or undefined when that changes nothing (or may not be believed). What a
 * payment is (who, how much, over what) is its initiator's to say: the payee's for a request, the payer's for a
 * payment; anyone else's description only stands in until the initiator's arrives. States only move forward.
 */
export function mergeGroupPay(current: GroupPayNote | undefined, frame: GroupPayFrame, author: string, members: ReadonlySet<string>): GroupPayNote | undefined {
  if (!believed(current, frame, author, members)) return undefined;
  const initiator = frame.k === "req" ? frame.to : frame.f;
  const fields = fieldsOf(frame);
  let next: GroupPayNote = current ? { ...current } : { ...fields, state: "open", ...(author === initiator ? {} : { undescribed: true as const }) };
  // Until the initiator's own note arrives, a claim's description stands in for it, on this device only: a note
  // still `undescribed` stays out of the group's history (GroupPayments.write), so no member is shown asking for or
  // sending what another member made up in their name.
  if (author === initiator) next = (({ undescribed: _, ...rest }) => rest)({ ...next, ...fields });
  if (frame.k === "req" && author !== frame.to) {
    // A payer's word about its own payment: a claim, not the request's state.
    const claims = frame.st === "sent" ? [...new Set([...(next.claims ?? []), author])].sort() : (next.claims ?? []).filter(k => k !== author);
    next = claims.length ? { ...next, claims } : (({ claims: _, ...rest }) => rest)(next);
  } else if (RANK[frame.st] > RANK[next.state]) next = { ...next, state: frame.st };
  if (frame.st === "paid" && frame.by) next = { ...next, by: frame.by };
  // An invoice does not say who paid it, so nobody's word names who did: a member's claim stays a claim, and a payee
  // that names someone (an older app took a lone claim for the payer) is not believed.
  if (next.from === "*" && next.rail === "lightning" && next.by) next = (({ by: _, ...rest }) => rest)(next);
  if (next.state === "paid" && next.from !== "*" && !next.by) next = { ...next, by: next.from };
  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
}

/** Where a desk record sits in a group, if it does: the group, and the member at the other end (none for a request to all). */
export interface Placement { groupId: string; me: string; peer?: string }

const federationOf = (p: PaymentView): string | undefined => p.federation ?? p.federations?.[0];
const railOf = (p: PaymentView): GroupPayRail =>
  p.target ? (p.target.method === "cashu" ? "cashu" : p.target.method) : federationOf(p) ? "fedimint" : p.invoice && !p.mints?.length && !p.mint ? "lightning" : "cashu";
/** Test money as the chat's bubble reads it (paymentIsTest): a target's chain, else the record's network, else a Fedimint federation's network, else its mints. */
const testOf = (p: PaymentView, federationNetwork: (federation: string) => string | undefined): boolean => {
  if (p.target) return p.target.method === "cashu" ? p.target.network === "cashu-test" : p.target.method === "usdt" ? p.unit === "testusdt" : p.target.network !== "bitcoin";
  if (p.network) return p.network === "testnet";
  const federation = federationOf(p);
  if (federation) { const network = federationNetwork(federation); return !!network && network !== "bitcoin"; }
  return p.mint ? isWorthlessMint(p.mint) : p.mints?.length ? p.mints.every(isWorthlessMint) : false;
};

/**
 * What this device says about one of its own payments in a group, or null when it says nothing (not a group's,
 * or nothing to say yet). `all` is the desk records to find a request's payments in (and whether this device paid it):
 * every record, or only that request's.
 */
export function authoredNote(p: PaymentView, at: Placement, all: readonly PaymentView[], current?: GroupPayNote, memberOf: (linkId: string) => string | undefined = () => undefined,
  federationNetwork: (federation: string) => string | undefined = () => undefined): GroupPayFrame | null {
  const base = { t: "group-pay" as const, g: at.groupId, id: paymentWireId(p.id), v: String(p.amount), u: p.unit, d: p.target?.method === "usdt" ? p.target.decimals ?? 6 : 0, r: railOf(p),
    ...(testOf(p, federationNetwork) ? { x: 1 as const } : {}), ...(p.memo ? { m: p.memo.slice(0, 140) } : {}), ...(p.ask ? { a: 1 as const } : {}), ts: p.createdAt };
  if (p.kind === "request" && p.direction === "out") {
    // Mine to be paid: open until paid, and who paid it when my wallet knows (ecash comes in on the payer's edge);
    // never from a member's claim, which is only its word.
    const from = p.group ? "*" : at.peer;
    if (!from) return null;
    const payment = all.find(x => x.kind === "payment" && x.direction === "in" && x.requestId === p.id && x.state === "settled");
    const by = !p.group ? from : payment ? memberOf(payment.linkId) : undefined;
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
  /**
   * My member key in a group, and who is in it; undefined when I am not in it. `since`: when this membership began
   * here (`paymentsMembership`), so that what I made in an earlier one under the same id is not said in this one.
   */
  membership(groupId: string): { me: string; members: ReadonlySet<string>; since?: number } | undefined;
  /** Sends on an edge; throws when it is down. */
  send(linkId: string, frame: object): void;
  /** The group's history, for the notes already kept. */
  messages(groupId: string): Promise<StoredMessage[]>;
  /** Writes (or rewrites) a line of the group's history. */
  putMessage(message: StoredMessage): Promise<void>;
  /** The network of a federation this device joined ("bitcoin" for real money), for a record that names only its federation. */
  federationNetwork?(federation: string): string | undefined;
}

/**
 * What GroupPayments needs of a group's view: my key and who is in it while I am an active member, and when this
 * membership began here (the group's row is made anew when I create it, am invited or join by its link, and goes
 * when I leave or forget it).
 */
export function paymentsMembership(view: Pick<GroupView, "status" | "myKey" | "members" | "createdAt"> | undefined): { me: string; members: ReadonlySet<string>; since: number } | undefined {
  return view?.status === "active" && view.myKey ? { me: view.myKey, members: new Set(view.members.map(m => m.key)), since: view.createdAt } : undefined;
}

/** The keys a note of mine names: one of them is mine as the member I was when I said it. */
const named = (frame: GroupPayFrame): string[] => [frame.f, frame.to, ...(frame.by ? [frame.by] : [])];

export class GroupPayments {
  private readonly notes = new Map<string, Map<string, GroupPayNote>>();
  /** Per group, the ids of others' notes still `undescribed`, oldest first. */
  private readonly waiting = new Map<string, Set<string>>();
  /** Counts the groups forgotten (`forget`): a pass under way asks again whether it is still in a group. */
  private forgotten = 0;
  /** Per group, how many times it was forgotten in this run: notes read from its history before that are not kept. */
  private readonly ends = new Map<string, number>();
  private queue = Promise.resolve();

  constructor(private readonly host: GroupPaymentsHost) {}

  /** A `group-pay` frame from the member an edge is pinned to. */
  receive(groupId: string, author: string, raw: unknown): Promise<void> {
    return this.run(async () => {
      const frame = parseGroupPay(raw, groupId), membership = this.host.membership(groupId);
      if (!frame || !membership) return;
      const notes = await this.load(groupId);
      const next = mergeGroupPay(notes.get(frame.id), frame, author, membership.members);
      if (next) await this.write(groupId, membership.me, next, notes);
    });
  }

  /** Says what changed about this device's own payments in groups. The engine calls it whenever payments change. */
  sync(): Promise<void> { return this.run(() => this.author()); }

  /** An edge came up: the member hears again what I said lately, in case it missed it. */
  edgeReady(groupId: string, linkId: string): Promise<void> {
    return this.run(async () => {
      const me = this.host.membership(groupId)?.me;
      if (!me) return;
      // Only what I said as the member I am now: a note kept from an earlier membership under this id names my old key.
      const mine = [...(await this.load(groupId)).values()].filter(n => n.mine && named(n.mine).includes(me)).sort((a, b) => b.createdAt - a.createdAt).slice(0, RESEND);
      for (const note of mine.reverse()) { try { this.host.send(linkId, note.mine!); } catch { return; } }
    });
  }

  /**
   * A group left or forgotten here (its history went with it; switching to another group under its id forgets it
   * first): what this run kept of its notes goes too. A later membership under the same id, mine again by its link or
   * another group's, starts with none of them.
   */
  forget(groupId: string): void {
    this.notes.delete(groupId);
    this.waiting.delete(groupId);
    this.ends.set(groupId, (this.ends.get(groupId) ?? 0) + 1);
    this.forgotten++;
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
    let forgotten = this.forgotten;
    const membership = (groupId: string) => {
      // A group left while this pass ran: asked again, so nothing more is said in it.
      if (forgotten !== this.forgotten) { known.clear(); forgotten = this.forgotten; }
      if (!known.has(groupId)) known.set(groupId, this.host.membership(groupId));
      return known.get(groupId);
    };
    // A request's payments, found once per pass: each request searching every record made a pass with 1,000 group
    // requests among 5,000 payments take 32 ms, on every payment change.
    const answers = new Map<string, PaymentView[]>();
    for (const x of all) if (x.requestId) { const list = answers.get(x.requestId); if (list) list.push(x); else answers.set(x.requestId, [x]); }
    for (const p of all) {
      const at = this.placement(p, membership);
      if (!at) continue;
      const notes = await this.load(at.groupId);
      const current = notes.get(paymentWireId(p.id));
      const frame = authoredNote(p, at, answers.get(p.id) ?? [], current, linkId => this.host.edgeOf(linkId)?.member, federation => this.host.federationNetwork?.(federation));
      if (!frame) continue;
      const members = membership(at.groupId)!.members;
      // What my own merge refuses is neither kept as said nor sent: every member would refuse it too, and say it
      // again when an edge opens. Said already, it is still merged once more: an older app kept it unmerged.
      if (!believed(current, frame, at.me, members)) continue;
      const next = mergeGroupPay(current, frame, at.me, members);
      if (!next && JSON.stringify(frame) === JSON.stringify(current?.mine)) continue;
      const merged = next ?? current;
      if (!merged) continue;
      if (!(await this.write(at.groupId, at.me, { ...merged, mine: frame }, notes))) continue;
      for (const linkId of this.host.edges(at.groupId).values()) { try { this.host.send(linkId, frame); } catch { /* sent again when that edge opens */ } }
    }
  }

  private placement(p: PaymentView, membership: GroupPaymentsHost["membership"]): Placement | undefined {
    // What I made before this membership began was made in an earlier one under the same id (left, forgotten, or
    // another group's): said now, it would come back under my new key, to members who never were in it. Only my own
    // records go by this: their date is this device's clock, as the membership's is; a received one bears its sender's.
    const current = (m: ReturnType<GroupPaymentsHost["membership"]>) => !!m && !(p.direction === "out" && m.since !== undefined && p.createdAt < m.since);
    if (p.group) { const m = membership(p.group); return current(m) ? { groupId: p.group, me: m!.me } : undefined; }
    const edge = this.host.edgeOf(p.linkId);
    if (!edge) return undefined;
    const m = membership(edge.groupId);
    return current(m) ? { groupId: edge.groupId, me: m!.me, peer: edge.member } : undefined;
  }

  private async load(groupId: string): Promise<Map<string, GroupPayNote>> {
    let notes = this.notes.get(groupId);
    if (!notes) {
      const ends = this.ends.get(groupId);
      notes = new Map((await this.host.messages(groupId)).filter(m => m.groupPay).map(m => [m.groupPay!.id, m.groupPay!]));
      // Forgotten while its history was read: what was read belongs to nobody now, and `write` keeps none of it.
      if (this.ends.get(groupId) === ends) this.notes.set(groupId, notes);
    }
    return notes;
  }

  /**
   * Keeps `note` in `notes` (the group's, as `load` gave them) and in the group's history; false when the group was
   * forgotten since they were loaded: nothing goes back into a history that is gone.
   */
  private async write(groupId: string, me: string, note: GroupPayNote, notes: Map<string, GroupPayNote>): Promise<boolean> {
    if (this.notes.get(groupId) !== notes) return false;
    notes.set(note.id, note);
    // Nothing removes a note nobody described, and any member can make up fresh ones: at most WAITING of them stay.
    // Mine are not counted (my own payments bound them), so others' cannot push them out.
    let waiting = this.waiting.get(groupId);
    if (note.undescribed && !note.mine) {
      if (!waiting) this.waiting.set(groupId, waiting = new Set());
      waiting.add(note.id);
      for (const id of waiting) { if (waiting.size <= WAITING) break; waiting.delete(id); notes.delete(id); }
    } else waiting?.delete(note.id);
    // Shown once the member it is about described it; what others said about it waits here until then.
    if (note.undescribed) return true;
    const initiator = note.kind === "request" ? note.to : note.from;
    await this.host.putMessage({ linkId: `group:${groupId}`, id: NOTE_ID(note.id), text: summary(note), sender: initiator === me ? "me" : "peer", member: initiator,
      timestamp: note.createdAt, via: "datalink", groupPay: note });
    return true;
  }
}

/** A plain line for previews and old views; the group page draws the note itself. */
function summary(note: GroupPayNote): string {
  const amount = note.decimals ? `${note.amount} base units of ${note.unit}` : `${Number(note.amount).toLocaleString()} ${note.test ? "test sats" : "sats"}`;
  return note.kind === "request" ? `⚡ Requested ${amount}` : `⚡ Sent ${amount}`;
}
