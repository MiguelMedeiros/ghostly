import {
  decodeControl, encodeControl,
  type ControlFrame, type Payment, type PaymentAsk, type PaymentMethodName, type PaymentRequest, type PaymentResult,
} from "@ghostly/core";
import type { LinkView } from "../shared/types";
import { pairLinkId, parsePayLink } from "../shared/payLinks";
import type { PaymentLink } from "./payments";

/**
 * Payments in community groups (WISP 9xx · Group Community § Payments). Members have no edge to each other: what
 * two members say about a payment (`pay-req`, `pay-ask`, `pay`, `pay-res`) is sealed to the other one inside a frame
 * the whole group carries (`CommunitySession.sendPair`), so hubs relay it and keep it for a member who was away
 * without being able to read it. A request to the whole group, and its "paid", go to everyone as an application
 * frame (`sendApp`), encrypted to the group like text.
 *
 * The PaymentDesk sees a link per member (`cpay:<group>:<member>`) and one for the group (`cpay:<group>`), which
 * send through the community instead of a data link: it pays, requests and receipts over them as over a chat.
 */

export const PAYMENT_METHODS: readonly PaymentMethodName[] = ["cashu", "lightning", "arkade", "usdt", "bark", "bitcoin"];
/** A member whose ways of paying are not known yet takes what every Ghostly app takes unless turned off. */
const DEFAULT_METHODS: ReadonlySet<PaymentMethodName> = new Set(["cashu", "lightning"]);
/** A member is asked again what it takes this long after it last said. */
const HELLO_AGAIN_MS = 60_000;
/** Answers to "what do you take" per member, at most this often. */
const ANSWER_EVERY_MS = 10_000;

export { groupLinkId, pairLinkId, parsePayLink } from "../shared/payLinks";

function methodsOf(raw: unknown): Set<PaymentMethodName> | undefined {
  if (!Array.isArray(raw) || raw.length > 16 || !raw.every(m => typeof m === "string")) return undefined;
  // A method this app does not know yet (a newer member) is left out, not a reason to drop the list.
  return new Set((raw as string[]).filter((m): m is PaymentMethodName => PAYMENT_METHODS.includes(m as PaymentMethodName)));
}

/** A payment frame from the wire, checked as a data link checks it. */
function control(raw: unknown): ControlFrame | null {
  if (!raw || typeof raw !== "object") return null;
  try { return decodeControl(JSON.stringify(raw)); } catch { return null; }
}

export interface CommunityPayHost {
  /** Is this a community group I am an active member of; my key in it and who else is. */
  membership(groupId: string): { me: string; members: ReadonlySet<string> } | undefined;
  sendApp(groupId: string, frame: Record<string, unknown>): Promise<void>;
  sendPair(groupId: string, to: string, payload: Record<string, unknown>): Promise<void>;
  /** The ways of paying this device allows in community groups. */
  enabled(): Partial<Record<PaymentMethodName, boolean>>;
  onPaymentRequest(linkId: string, request: PaymentRequest): Promise<void>;
  onPaymentAsk(linkId: string, ask: PaymentAsk): Promise<void>;
  onPayment(linkId: string, payment: Payment): Promise<void>;
  onPaymentResult(linkId: string, result: PaymentResult): Promise<void>;
  /** A `group-pay` note from a member, for GroupPayments. */
  onNote(groupId: string, author: string, frame: Record<string, unknown>): Promise<void>;
  emit(): void;
}

export class CommunityPay {
  /** Group → member → the ways of paying it last said it takes, and when. */
  private readonly theirs = new Map<string, Map<string, { methods: Set<PaymentMethodName>; at: number }>>();
  private readonly asked = new Map<string, number>();
  private readonly answered = new Map<string, number>();

  constructor(private readonly host: CommunityPayHost, private readonly clock: () => number = Date.now) {}

  paymentEnabled(method: PaymentMethodName): boolean { return this.host.enabled()[method] !== false; }
  mine(): PaymentMethodName[] { return PAYMENT_METHODS.filter(m => this.paymentEnabled(m)); }
  /** What a member takes: what it said, or Cashu and Lightning until it says. */
  methodsOf(groupId: string, member: string): ReadonlySet<PaymentMethodName> { return this.theirs.get(groupId)?.get(member)?.methods ?? DEFAULT_METHODS; }
  known(groupId: string, member: string): boolean { return !!this.theirs.get(groupId)?.get(member); }

  /** The desk's link for a `cpay:` id; null for anything else, or a group I am not in. */
  link(linkId: string): PaymentLink | null {
    const at = parsePayLink(linkId);
    if (!at || !this.host.membership(at.groupId)) return null;
    return at.member ? new PairLink(this, this.host, at.groupId, at.member) : new GroupLink(this, this.host, at.groupId);
  }

  /** The payment composer opened on a member: ask what it takes, unless it said lately. */
  async hello(groupId: string, member: string): Promise<void> {
    const at = this.theirs.get(groupId)?.get(member)?.at ?? 0, key = `${groupId}:${member}`, now = this.clock();
    if (now - at < HELLO_AGAIN_MS || now - (this.asked.get(key) ?? 0) < HELLO_AGAIN_MS) return;
    this.asked.set(key, now);
    await this.host.sendPair(groupId, member, { pm: this.mine(), hi: 1 });
  }

  /** A pair payload from a member, opened by the session: what it takes, and maybe a payment frame. */
  async receivePair(groupId: string, sender: string, payload: Record<string, unknown>): Promise<void> {
    const membership = this.host.membership(groupId);
    if (!membership?.members.has(sender)) return;
    this.learn(groupId, sender, payload.pm);
    const key = `${groupId}:${sender}`, now = this.clock();
    if (payload.hi === 1 && now - (this.answered.get(key) ?? 0) >= ANSWER_EVERY_MS) {
      this.answered.set(key, now);
      await this.host.sendPair(groupId, sender, { pm: this.mine() }).catch(() => {});
    }
    const frame = control(payload.f);
    if (!frame) return;
    const linkId = pairLinkId(groupId, sender);
    // As a data link does: only while this device takes some way of paying from them.
    if (!new PairLink(this, this.host, groupId, sender).supportsPayments) return;
    if (frame.t === "pay-req") await this.host.onPaymentRequest(linkId, { id: frame.id, timestamp: frame.ts, amount: { value: frame.v, asset: frame.u }, memo: frame.memo, endpoints: frame.e, ask: frame.a });
    else if (frame.t === "pay-ask") await this.host.onPaymentAsk(linkId, { id: frame.id, timestamp: frame.ts, amount: { value: frame.v, asset: frame.u }, method: frame.m, memo: frame.memo });
    else if (frame.t === "pay") await this.host.onPayment(linkId, { id: frame.id, timestamp: frame.ts, requestId: frame.rid, amount: { value: frame.v, asset: frame.u }, memo: frame.memo, endpoint: frame.e });
    else if (frame.t === "pay-res") await this.host.onPaymentResult(linkId, { id: frame.id, ok: frame.ok, credited: frame.v, error: frame.err });
  }

  /**
   * An application frame from a member: a note about a payment, a request to the whole group, or its result. A
   * request and a result reach the desk as from that member's link, so only what they may say about their own
   * request counts (the desk checks the link a record belongs to).
   */
  async receiveApp(groupId: string, sender: string, raw: Record<string, unknown>): Promise<void> {
    const membership = this.host.membership(groupId);
    if (!membership?.members.has(sender)) return;
    if (raw.t === "group-pay") { await this.host.onNote(groupId, sender, raw); return; }
    this.learn(groupId, sender, raw.pm);
    const { pm: _, ...rest } = raw;
    const frame = control(rest), linkId = pairLinkId(groupId, sender);
    if (!frame) return;
    if (frame.t === "pay-req") await this.host.onPaymentRequest(linkId, { id: frame.id, timestamp: frame.ts, amount: { value: frame.v, asset: frame.u }, memo: frame.memo, endpoints: frame.e });
    else if (frame.t === "pay-res" && frame.ok) await this.host.onPaymentResult(linkId, { id: frame.id, ok: true });
  }

  private learn(groupId: string, member: string, raw: unknown): void {
    const methods = methodsOf(raw);
    if (!methods) return;
    let group = this.theirs.get(groupId);
    if (!group) this.theirs.set(groupId, group = new Map());
    const before = group.get(member)?.methods;
    group.set(member, { methods, at: this.clock() });
    if (!before || [...before].join() !== [...methods].join()) this.host.emit();
  }

  /**
   * The links the group page and the payment bubbles look up (by the member's key): members whose ways of paying
   * are known, and those a payment of this device is with.
   */
  views(groupId: string, me: string, members: readonly string[], withPayments: ReadonlySet<string>): LinkView[] {
    const mine = Object.fromEntries(PAYMENT_METHODS.map(m => [m, this.paymentEnabled(m)])) as Record<PaymentMethodName, boolean>;
    return members.filter(key => key !== me && (this.known(groupId, key) || withPayments.has(key))).map(key => {
      const theirs = this.methodsOf(groupId, key);
      const methods = Object.fromEntries(PAYMENT_METHODS.map(m => [m, mine[m] && theirs.has(m)])) as Record<PaymentMethodName, boolean>;
      return {
        id: pairLinkId(groupId, key), myPubKeyZ32: me, peerPubKeyZ32: key, profile: "paired-chat/1", createdAt: 0,
        // The group carries it whenever someone is connected, and keeps it until then: always "open" to the desk.
        status: "online", dataLink: "open", peerOnline: false, peerLastSeenAt: 0, peerServices: null, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
        poll: { polling: false, nextAt: 0, interval: 0 },
        capabilities: { files: false, payments: Object.values(methods).some(Boolean), methods }, paymentMethods: mine,
      };
    });
  }
}

/** One member, through the group: frames sealed to them. */
class PairLink implements PaymentLink {
  constructor(private readonly pay: CommunityPay, private readonly host: CommunityPayHost, readonly groupId: string, readonly member: string) {}
  /** The group carries it now, or keeps it for them until they are back: never held elsewhere. */
  get isDataLinkOpen(): boolean { return true; }
  paymentEnabled(method: PaymentMethodName): boolean { return this.pay.paymentEnabled(method); }
  allowsPayment(method: PaymentMethodName): boolean { return this.paymentEnabled(method) && this.pay.methodsOf(this.groupId, this.member).has(method); }
  get supportsPayments(): boolean { return PAYMENT_METHODS.some(m => this.allowsPayment(m)); }
  get supportsArkPayments(): boolean { return this.allowsPayment("arkade"); }
  get supportsUsdtPayments(): boolean { return this.allowsPayment("usdt"); }
  get supportsBarkPayments(): boolean { return this.allowsPayment("bark"); }
  get supportsBitcoinPayments(): boolean { return this.allowsPayment("bitcoin"); }
  async requirePaymentSupport(): Promise<void> {
    if (!PAYMENT_METHODS.some(m => this.paymentEnabled(m))) throw new Error("Payments are turned off in this group.");
    if (!this.host.membership(this.groupId)?.members.has(this.member)) throw new Error("They are no longer in this group");
    if (!this.supportsPayments) throw new Error("They take no way of paying this device allows.");
  }
  private async send(frame: ControlFrame): Promise<void> {
    await this.host.sendPair(this.groupId, this.member, { pm: this.pay.mine(), f: JSON.parse(encodeControl(frame)) as Record<string, unknown> });
  }
  async sendPaymentRequest(r: PaymentRequest): Promise<void> {
    await this.requirePaymentSupport();
    await this.send({ t: "pay-req", id: r.id, ts: r.timestamp, v: r.amount.value, u: r.amount.asset, memo: r.memo, e: r.endpoints, a: r.ask });
  }
  async sendPaymentAsk(a: PaymentAsk): Promise<void> {
    await this.requirePaymentSupport();
    await this.send({ t: "pay-ask", id: a.id, ts: a.timestamp, v: a.amount.value, u: a.amount.asset, m: a.method, memo: a.memo });
  }
  async sendPayment(p: Payment): Promise<void> {
    await this.requirePaymentSupport();
    await this.send({ t: "pay", id: p.id, ts: p.timestamp, rid: p.requestId, v: p.amount.value, u: p.amount.asset, memo: p.memo, e: p.endpoint });
  }
  sendPaymentResult(r: PaymentResult): void {
    if (!this.supportsPayments) return;
    void this.send({ t: "pay-res", id: r.id, ok: r.ok, v: r.credited, err: r.error }).catch(() => {});
  }
}

/** Everyone in the group at once: a request anyone may pay, and "it is paid". Cashu and Lightning only. */
class GroupLink implements PaymentLink {
  constructor(private readonly pay: CommunityPay, private readonly host: CommunityPayHost, readonly groupId: string) {}
  get isDataLinkOpen(): boolean { return true; }
  paymentEnabled(method: PaymentMethodName): boolean { return this.pay.paymentEnabled(method); }
  allowsPayment(method: PaymentMethodName): boolean { return (method === "cashu" || method === "lightning") && this.paymentEnabled(method); }
  get supportsPayments(): boolean { return this.allowsPayment("cashu") || this.allowsPayment("lightning"); }
  get supportsArkPayments(): boolean { return false; }
  get supportsUsdtPayments(): boolean { return false; }
  get supportsBarkPayments(): boolean { return false; }
  get supportsBitcoinPayments(): boolean { return false; }
  async requirePaymentSupport(): Promise<void> {
    if (!this.supportsPayments) throw new Error("Payments are turned off in this group.");
    if (!this.host.membership(this.groupId)) throw new Error("You are not in this group");
  }
  async sendPaymentRequest(r: PaymentRequest): Promise<void> {
    await this.requirePaymentSupport();
    const frame = JSON.parse(encodeControl({ t: "pay-req", id: r.id, ts: r.timestamp, v: r.amount.value, u: r.amount.asset, memo: r.memo, e: r.endpoints })) as Record<string, unknown>;
    await this.host.sendApp(this.groupId, { ...frame, pm: this.pay.mine() });
  }
  async sendPaymentAsk(): Promise<void> { throw new Error("Choose one member to pay"); }
  async sendPayment(): Promise<void> { throw new Error("Choose one member to pay"); }
  sendPaymentResult(r: PaymentResult): void {
    // Only "paid" is said to everyone: a refusal concerns one payer, who hears it on its own.
    if (r.ok) void this.host.sendApp(this.groupId, { t: "pay-res", id: r.id, ok: true }).catch(() => {});
  }
}
