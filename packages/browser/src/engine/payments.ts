import type { UsdtWallet } from "./paymentAdapters/usdtWallet";
import { WALLET_NETWORKS, assertTokenUnits, formatPaymentAmount, sparkInvoiceDetails, validatePaymentTarget, walletNetworkOf, type SparkNetwork, type PaymentMethodName, type PaymentReview, type PaymentTarget, type WalletNetwork } from "@ghostly/core";
import { eachNetwork, perNetwork, type PerNetwork } from "./paymentAdapters/perNetwork";
import { crossNetwork, paymentNetwork } from "./paymentAdapters/walletInstances";
import { networkLabel } from "./paymentAdapters/modeGate";
import type { ArkWallet } from "./paymentAdapters/arkWallet";
import type { BarkWallet } from "./paymentAdapters/barkWallet";
import type { FedimintWallet } from "./paymentAdapters/fedimintWallet";
import {
  ENDPOINT,
  cashuRequestPayload,
  fedimintRequestPayload,
  findEndpoint,
  parseCashuRequestPayload,
  parseFedimintRequestPayload,
  randomBytes,
  toBase64Url,
  type GhostLink,
  type Payment,
  type PaymentAsk,
  type PaymentRequest,
  type PaymentResult,
} from "@ghostly/core";
import { STORES, store, wrap } from "../shared/idb";
import { isWorthlessMint, mintNetwork } from "../shared/mints";
import type { PaymentView, PendingMelt, StoredMessage, StoredPayment, StoredQuote } from "../shared/types";
import { assertAmount, type CashuWallet } from "./wallet";

/**
 * Payments in a chat. The protocol only carries requests, ecash and receipts
 * between the two peers; the wallet does the paying. Every outgoing token is
 * kept until the peer confirms it, so ecash a contact never redeemed can be
 * taken back.
 */
const UNIT = "sat";

/**
 * What the desk needs of a link: a chat's or an edge's GhostLink, or a member of a community group reached
 * through the group (see communityPay.ts).
 */
export type PaymentLink = Pick<GhostLink, "isDataLinkOpen" | "paymentEnabled" | "allowsPayment" | "supportsPayments" | "supportsArkPayments" | "supportsUsdtPayments"
  | "supportsBarkPayments" | "supportsBitcoinPayments" | "supportsFedimintPayments" | "supportsSparkPayments" | "requirePaymentSupport" | "sendPaymentRequest" | "sendPaymentAsk" | "sendPayment" | "sendPaymentResult">;

export interface PaymentDeskHost {
  getLink(linkId: string): PaymentLink | null;
  storeMessage(message: StoredMessage): Promise<void>;
  onChange(): void;
  /**
   * Store-and-forward (WISP 4xx): the ways of paying a request may name while the contact is away and
   * this device can hold it for them (null when it cannot), and holding the request itself.
   */
  heldPaymentMethods?(linkId: string): PaymentMethodName[] | null;
  /**
   * The chat is not live and nothing holds a request: the ways of paying a request may name that waits here
   * and goes when the chat is live ("Sends when live", WISP 400), or null when a request cannot wait.
   */
  waitingPaymentMethods?(linkId: string): PaymentMethodName[] | null;
  holdRequest?(linkId: string, request: PaymentRequest, messageId: string): Promise<void>;
  onReviewedPaymentResult?(id:string):Promise<void>;
  /** The group an edge link belongs to (WISP 9xx), for requests to a whole group. */
  groupOf?(linkId: string): string | undefined;
  /** The edge links of a group, to its other members, that exist. */
  groupLinks?(groupId: string): string[];
  /** A reviewed send the contact refused, whose ecash came back: its review is closed as failed. */
  onReviewedPaymentRefused?(id:string,reason:string):Promise<void>;
  /** The network of a request or a send that names none (a caller from before wallets had their own). Default: Mainnet. */
  defaultNetwork?(): WalletNetwork;
}

/**
 * Lightning as the desk needs it: the invoice a request carries, and paying a contact's invoice. The
 * engine hands it the active Lightning source; alone (tests), the desk uses the Cashu mints directly.
 */
export interface DeskLightning {
  createInvoice(amount: number, paymentId: string): Promise<{ invoice: string }>;
  /** `mint`: the Cashu mint that will pay, when it is one. */
  quote(invoice: string): Promise<{ quote: string; mint?: string; amount: number; feeReserve: number }>;
  /** True once paid, false while pending. Throws only when the sats did not go out. */
  pay(quote: { quote: string; mint?: string }, note: string, paymentId: string): Promise<boolean>;
  /** Asks the source (and the mints) about our open invoices now: a contact said it paid one from another wallet. */
  check?(): Promise<void>;
}
export const mintLightning = (wallet: CashuWallet, network?: WalletNetwork): DeskLightning => ({
  createInvoice: (amount, paymentId) => wallet.receiveLightning(amount, paymentId, network),
  quote: (invoice) => wallet.quoteInvoice(invoice, network),
  pay: (quote, note, paymentId) => wallet.payQuote(quote.quote, quote.mint!, note, paymentId),
});

const newId = () => toBase64Url(randomBytes(12));

/** Whole sats only: that is all ecash in `sat` can represent. */
function parseSats(value: string, asset: string): number | null {
  if (asset !== UNIT || !/^[1-9]\d{0,8}$/.test(value)) return null;
  return Number(value);
}

/**
 * On-chain Bitcoin as the desk needs it (the engine's BitcoinService, through the active on-chain source).
 */
export interface DeskBitcoin {
  /** Where to be paid: a fresh address of the active source, as a request carries it. */
  requestTarget(): Promise<PaymentTarget>;
  /**
   * A transaction of the active source that pays this target at least `amount`, and is none of `claimed`;
   * `hint` is the txid the contact said it paid with. Undefined while there is none.
   */
  received(target: PaymentTarget, amount: number, claimed: ReadonlySet<string>, hint?: string): Promise<{ txid: string; confirmations: number } | undefined>;
}

/** Spark as the desk needs it (the engine's SparkWallet): an invoice per request, and the wallet's own receives. */
export interface DeskSpark {
  /** Open (connected) now: requests can be made and receipts looked up. */
  ready(): boolean;
  /** Where to be paid for one request: a Spark invoice of this amount, made for it. */
  requestTarget(amount: number, memo?: string): Promise<PaymentTarget>;
  /** A completed receive on this request's invoice of at least `amount`, and none of `claimed`: its transfer id. */
  received(target: PaymentTarget, amount: number, since: number, claimed: ReadonlySet<string>): Promise<string | undefined>;
  /** Asks Spark for what arrived. */
  sync(): Promise<void>;
}

/** Paying in ecash failed before any token existed, so nothing reached the contact and Lightning is safe to try. */
class NoEcashError extends Error {}

const arkSats=(network:string)=>network==="bitcoin"?"sats":"test sats";
type AskMethod = "arkade" | "usdt" | "bark" | "bitcoin" | "spark" | "fedimint";
const ENDPOINT_OF: Record<Exclude<AskMethod, "usdt" | "fedimint">, string> = { arkade: ENDPOINT.arkade, bark: ENDPOINT.bark, bitcoin: ENDPOINT.bitcoin, spark: ENDPOINT.spark };
/** A `pay` frame that carries no receipt, only "I paid this from another wallet: look now". */
const CHECK_PAYLOAD = JSON.stringify({ check: true });
const isCheck = (payload: string) => { try { return JSON.parse(payload)?.check === true; } catch { return false; } };
const RAIL_NAME: Record<AskMethod, string> = { arkade: "Ark", usdt: "USDT", bark: "Bark", bitcoin: "on-chain Bitcoin", fedimint: "Fedimint", spark: "Spark" };
/** Both sides allow this way of paying on the open data link. */
const allows = (link: PaymentLink, method: AskMethod) => method === "arkade" ? link.supportsArkPayments : method === "bark" ? link.supportsBarkPayments : method === "bitcoin" ? link.supportsBitcoinPayments : method === "fedimint" ? link.supportsFedimintPayments : method === "spark" ? link.supportsSparkPayments : link.supportsUsdtPayments;
/** Federation ecash is counted in msats; a chat counts whole sats. */
const fedimintSats = (msats: number) => Math.floor(msats / 1000);
/** A wallet for both networks (tests, older callers), or one per network. */
type Each<T extends object> = T | PerNetwork<T>;
/** The distinct wallets of a per-network set (one object may stand for both). */
const distinct = <T>(each: PerNetwork<T>): T[] => [...new Set(WALLET_NETWORKS.map((n) => each[n]))];
export class PaymentDesk {
  private readonly payments = new Map<string, StoredPayment>();
  private readonly paying = new Map<string, Promise<void>>();
  private readonly receiving = new Map<string, Promise<void>>();
  private readonly reclaims = new Map<string, Promise<void>>();
  private checkingArk=false;
  private checkingUsdt=false;
  private checkingBark=false;
  private checkingBitcoin=false;
  private readonly redeeming = new Map<string, Promise<void>>();
  private checkingSpark=false;

  /** Each network's wallets: a request, a payment and a receipt all go through the wallet of their own network. */
  private readonly ark?: PerNetwork<ArkWallet>;
  private readonly usdt?: PerNetwork<UsdtWallet>;
  private readonly bark?: PerNetwork<BarkWallet>;
  private readonly lightning: PerNetwork<DeskLightning>;
  private readonly bitcoin?: PerNetwork<DeskBitcoin>;
  private readonly fedimint?: PerNetwork<FedimintWallet>;
  private readonly spark?: PerNetwork<DeskSpark>;

  constructor(
    private readonly wallet: CashuWallet,
    private readonly host: PaymentDeskHost,
    ark?: Each<ArkWallet>,
    usdt?: Each<UsdtWallet>,
    bark?: Each<BarkWallet>,
    lightning?: Each<DeskLightning>,
    bitcoin?: Each<DeskBitcoin>,
    fedimint?: Each<FedimintWallet>,
    spark?: Each<DeskSpark>,
  ) {
    this.ark = ark && eachNetwork(ark); this.usdt = usdt && eachNetwork(usdt); this.bark = bark && eachNetwork(bark);
    this.lightning = lightning ? eachNetwork(lightning) : perNetwork((network) => mintLightning(wallet, network));
    this.bitcoin = bitcoin && eachNetwork(bitcoin); this.fedimint = fedimint && eachNetwork(fedimint); this.spark = spark && eachNetwork(spark);
  }

  private defaultNetwork(): WalletNetwork { return this.host.defaultNetwork?.() ?? "mainnet"; }
  /** The Fedimint wallet that joined this federation, whichever network it is on. */
  private fedimintOf(federation: string | undefined): FedimintWallet | undefined {
    return federation && this.fedimint ? distinct(this.fedimint).find((w) => w.federation(federation)) : undefined;
  }

  async start(): Promise<void> {
    const stored = await wrap<StoredPayment[]>((await store(STORES.payments, "readonly")).getAll());
    for (const payment of stored) this.payments.set(payment.id, payment);
  }

  views(): Record<string, PaymentView> {
    // The token is money: it stays with the peer and never reaches a page.
    return Object.fromEntries([...this.payments].map(([id, { token: _token, ...view }]) => [id, view]));
  }

  async forgetLink(linkId: string): Promise<void> {
    const paymentStore = await store(STORES.payments, "readwrite");
    for (const payment of [...this.payments.values()]) {
      // Ecash the peer has not taken yet is still the user's; keep it reclaimable.
      if (payment.linkId !== linkId || (payment.token && (payment.state === "pending" || payment.state === "failed"))) continue;
      this.payments.delete(payment.id);
      void wrap(paymentStore.delete(payment.id));
    }
  }

  // -- what the user does --------------------------------------------------------

  async send(params: { linkId: string; amount: number; memo?: string; timestamp: number; network?: WalletNetwork }): Promise<{ paymentId: string }> {
    assertAmount(params.amount);
    const link = this.requireLink(params.linkId);
    // Reach the peer before taking ecash out of the wallet.
    await link.requirePaymentSupport();
    if (!link.allowsPayment("cashu")) throw new Error("Cashu is off in this chat");
    const paymentId = await this.sendEcash(link, { ...params, network: params.network ?? this.defaultNetwork() });
    return { paymentId };
  }

  /** `rail`: a Cashu request carries only ecash, a Lightning one only an invoice; without it, whatever the chat allows. */
  async request(params: { linkId: string; amount: number; memo?: string; timestamp: number; method?: "cashu" | AskMethod; ask?: string; rail?: "cashu" | "lightning"; network?: WalletNetwork }): Promise<{ paymentId: string }> {
    const network = params.network ?? this.defaultNetwork();
    const mine = (label: string) => `You have no ${networkLabel(network)} ${label} wallet: create one in Wallet → New`;
    if(params.method === "usdt")assertTokenUnits(params.amount);else assertAmount(params.amount);
    const link = this.requireLink(params.linkId);
    // A Cashu/Lightning request that can be held for an away contact needs no session; anything else does.
    const held = !link.isDataLinkOpen ? this.host.heldPaymentMethods?.(params.linkId) ?? null : null;
    const waiting = !link.isDataLinkOpen && !held && (!params.method || params.method === "cashu") ? this.host.waitingPaymentMethods?.(params.linkId) ?? null : null;
    if ((!held && !waiting) || (params.method && params.method !== "cashu")) await link.requirePaymentSupport();

    const id = newId();
    const memo = params.memo?.trim().slice(0, 140) || undefined;
    if (params.method === "usdt") {
      if(!link.supportsUsdtPayments || !this.usdt)throw new Error("Both peers need USDT support on a connected data link");
      const usdt=this.usdt[network];
      if(!usdt.configured)throw new Error(mine("USDT"));
      const target=await usdt.target();
      const unit=target.asset === "USDT" ? "usdt" : "testusdt";
      await this.save({id,linkId:params.linkId,kind:"request",direction:"out",amount:params.amount,unit,memo,state:"pending",createdAt:params.timestamp,target,ask:params.ask,network});
      await this.host.storeMessage({linkId:params.linkId,id:`me_${params.timestamp}`,text:`Requested ${formatPaymentAmount(params.amount,target.decimals)} ${target.asset}`,sender:"me",timestamp:params.timestamp,via:"datalink",paymentId:id});
      await link.sendPaymentRequest({id,timestamp:params.timestamp,amount:{value:String(params.amount),asset:unit},memo,endpoints:[[ENDPOINT.usdt,JSON.stringify(target)]],ask:params.ask,network});
      return {paymentId:id};
    }
    if (params.method === "arkade") {
      if (!link.supportsArkPayments || !this.ark) throw new Error("Both peers need the Ark payment capability on a connected data link");
      if (!this.ark[network].configured) throw new Error(mine("Ark"));
      const target = await this.ark[network].target();
      await this.save({id,linkId:params.linkId,kind:"request",direction:"out",amount:params.amount,unit:UNIT,memo,state:"pending",createdAt:params.timestamp,target,ask:params.ask,network});
      await this.host.storeMessage({linkId:params.linkId,id:`me_${params.timestamp}`,text:`Requested ${params.amount} ${arkSats(target.network)} on Ark`,sender:"me",timestamp:params.timestamp,via:"datalink",paymentId:id});
      await link.sendPaymentRequest({id,timestamp:params.timestamp,amount:{value:String(params.amount),asset:UNIT},memo,endpoints:[[ENDPOINT.arkade,JSON.stringify(target)]],ask:params.ask,network});
      return {paymentId:id};
    }
    if (params.method === "bark") {
      if (!link.supportsBarkPayments || !this.bark) throw new Error("Both peers need Bark on a connected data link");
      if (!this.bark[network].configured) throw new Error(mine("Bark"));
      // A fresh address for this request only: what arrives on it is what pays it.
      const target = await this.bark[network].target();
      await this.save({id,linkId:params.linkId,kind:"request",direction:"out",amount:params.amount,unit:UNIT,memo,state:"pending",createdAt:params.timestamp,target,ask:params.ask,network});
      await this.host.storeMessage({linkId:params.linkId,id:`me_${params.timestamp}`,text:`Requested ${params.amount} ${arkSats(target.network)} on Bark`,sender:"me",timestamp:params.timestamp,via:"datalink",paymentId:id});
      await link.sendPaymentRequest({id,timestamp:params.timestamp,amount:{value:String(params.amount),asset:UNIT},memo,endpoints:[[ENDPOINT.bark,JSON.stringify(target)]],ask:params.ask,network});
      return {paymentId:id};
    }
    if (params.method === "fedimint") {
      if (!link.supportsFedimintPayments || !this.fedimint) throw new Error("Both peers need Fedimint on a connected data link");
      const fedimint = this.fedimint[network];
      const federations = fedimint.requestFederations();
      if (!federations.length) throw new Error(`Join a federation first (Wallet → New → ${networkLabel(network)} Fedimint)`);
      // A contact in another federation pays the invoice instead: made by one of ours, through its gateway.
      const invoiceFederation = link.allowsPayment("lightning") ? fedimint.invoiceFederation() : undefined;
      const invoice = invoiceFederation ? (await fedimint.createInvoice(invoiceFederation, params.amount, memo ?? "Ghostly request", id)).invoice : undefined;
      const test = fedimint.federation(federations[0])?.network !== "bitcoin";
      await this.save({id,linkId:params.linkId,kind:"request",direction:"out",amount:params.amount,unit:UNIT,memo,state:"pending",createdAt:params.timestamp,federations,invoice,federation:invoiceFederation,ask:params.ask,network});
      await this.host.storeMessage({linkId:params.linkId,id:`me_${params.timestamp}`,text:`Requested ${params.amount.toLocaleString()} ${test ? "test sats" : "sats"} on Fedimint`,sender:"me",timestamp:params.timestamp,via:"datalink",paymentId:id});
      await link.sendPaymentRequest({id,timestamp:params.timestamp,amount:{value:String(params.amount),asset:UNIT},memo,ask:params.ask,network,
        endpoints:[[ENDPOINT.fedimint,fedimintRequestPayload(federations)],...(invoice ? [[ENDPOINT.bolt11,invoice] as [string,string]] : [])]});
      return {paymentId:id};
    }
    if (params.method === "spark") {
      if (!link.supportsSparkPayments || !this.spark) throw new Error("Both peers need Spark on a connected data link");
      // A Spark invoice for this request only: what arrives on it is what pays it.
      const target = await this.spark[network].requestTarget(params.amount, memo);
      await this.save({id,linkId:params.linkId,kind:"request",direction:"out",amount:params.amount,unit:UNIT,memo,state:"pending",createdAt:params.timestamp,target,ask:params.ask,network});
      await this.host.storeMessage({linkId:params.linkId,id:`me_${params.timestamp}`,text:`Requested ${params.amount} ${arkSats(target.network)} on Spark`,sender:"me",timestamp:params.timestamp,via:"datalink",paymentId:id});
      await link.sendPaymentRequest({id,timestamp:params.timestamp,amount:{value:String(params.amount),asset:UNIT},memo,endpoints:[[ENDPOINT.spark,JSON.stringify(target)]],ask:params.ask,network});
      return {paymentId:id};
    }
    if (params.method === "bitcoin") {
      if (!link.supportsBitcoinPayments || !this.bitcoin) throw new Error("Both peers need on-chain Bitcoin on a connected data link");
      // A fresh address for this request only: what arrives on it is what pays it.
      const target = await this.bitcoin[network].requestTarget();
      await this.save({id,linkId:params.linkId,kind:"request",direction:"out",amount:params.amount,unit:UNIT,memo,state:"pending",createdAt:params.timestamp,target,ask:params.ask,network});
      await this.host.storeMessage({linkId:params.linkId,id:`me_${params.timestamp}`,text:`Requested ${params.amount} ${arkSats(target.network)} on-chain`,sender:"me",timestamp:params.timestamp,via:"datalink",paymentId:id});
      await link.sendPaymentRequest({id,timestamp:params.timestamp,amount:{value:String(params.amount),asset:UNIT},memo,endpoints:[[ENDPOINT.bitcoin,JSON.stringify(target)]],ask:params.ask,network});
      return {paymentId:id};
    }
    // Each way of paying goes in only if this chat allows it on both sides. While the contact is away and the
    // request can be held for them, "both sides" is what their app allowed at the last session.
    const known = held ?? waiting;
    const ecash = params.rail !== "lightning" && (known ? known.includes("cashu") && link.paymentEnabled("cashu") : link.allowsPayment("cashu"));
    const lightning = params.rail !== "cashu" && (known ? known.includes("lightning") && link.paymentEnabled("lightning") : link.allowsPayment("lightning"));
    if (!ecash && !lightning) throw new Error(params.rail ? `${params.rail === "cashu" ? "Cashu" : "Lightning"} is not allowed by both of you here` : held ? "Your contact allowed neither Cashu nor Lightning in this chat" : "Cashu and Lightning are off in this chat");
    const quote = lightning ? await this.lightning[network].createInvoice(params.amount, id) : undefined;
    // A request is in real sats or in test sats, never both: ecash from a test mint, worth nothing, must
    // never settle a request for real money. Only this network's mints are named.
    const own = (await this.wallet.view(network)).mints.map((m) => m.url);
    const mints = ecash ? own.filter((url) => isWorthlessMint(url) === (network === "testnet")) : [];
    if (!quote && !mints.length) throw new Error(mine("Cashu"));

    await this.save({
      id,
      linkId: params.linkId,
      kind: "request",
      direction: "out",
      amount: params.amount,
      unit: UNIT,
      memo,
      state: "pending",
      createdAt: params.timestamp,
      invoice: quote?.invoice,
      mints,
      network,
    });
    await this.host.storeMessage({
      linkId: params.linkId,
      id: `me_${params.timestamp}`,
      text: `⚡ Requested ${params.amount.toLocaleString()} ${network === "testnet" ? "test sats" : "sats"}`,
      sender: "me",
      timestamp: params.timestamp,
      via: held ? "hold" : "datalink",
      ...(held ? { delivery: "sending" as const } : waiting ? { delivery: "waiting" as const, deliveryError: "Sent when you are live." } : {}),
      paymentId: id,
    });
    const request: PaymentRequest = {
      id,
      timestamp: params.timestamp,
      amount: { value: String(params.amount), asset: UNIT },
      memo,
      // Anyone can pay the invoice from any Lightning wallet; a contact on one of these mints can pay in ecash.
      endpoints: [
        ...(quote ? [[ENDPOINT.bolt11, quote.invoice] as [string, string]] : []),
        ...(mints.length ? [[ENDPOINT.cashu, cashuRequestPayload(mints)] as [string, string]] : []),
      ],
      network,
    };
    if (held) await this.host.holdRequest!(params.linkId, request, `me_${params.timestamp}`);
    // A waiting request goes with the replay of pending requests when the session opens.
    else if (!waiting) await link.sendPaymentRequest(request);
    return { paymentId: id };
  }

  /**
   * A request to a whole group (WISP 9xx § Payments): one request, on one rail, sent to every member over their
   * edge; the first payment that settles it wins. One rail only, because each enforces "once" by itself: a
   * Lightning invoice can be paid once, and ecash is checked here before it is redeemed (a later token is refused
   * unredeemed, so its payer takes it back). Two rails at once would let an invoice and a token both pay it.
   */
  async requestFromGroup(params: { groupId: string; amount: number; memo?: string; timestamp: number; rail: "cashu" | "lightning"; network?: WalletNetwork }): Promise<{ paymentId: string }> {
    assertAmount(params.amount);
    if (params.rail !== "cashu" && params.rail !== "lightning") throw new Error("A request to the group is paid in Cashu or over Lightning");
    const network = params.network ?? this.defaultNetwork();
    const id = newId();
    const memo = params.memo?.trim().slice(0, 140) || undefined;
    const quote = params.rail === "lightning" ? await this.lightning[network].createInvoice(params.amount, id) : undefined;
    const own = (await this.wallet.view(network)).mints.map((m) => m.url);
    const mints = params.rail === "cashu" ? own.filter((url) => isWorthlessMint(url) === (network === "testnet")) : [];
    if (params.rail === "cashu" && !mints.length) throw new Error(`You have no ${networkLabel(network)} Cashu wallet: create one in Wallet → New`);
    const linkId = `group:${params.groupId}`;
    await this.save({ id, linkId, group: params.groupId, kind: "request", direction: "out", amount: params.amount, unit: UNIT, memo, state: "pending", createdAt: params.timestamp, invoice: quote?.invoice, mints, network });
    await this.host.storeMessage({ linkId, id: `me_${params.timestamp}`, text: `⚡ Requested ${params.amount.toLocaleString()} sats from the group`, sender: "me", timestamp: params.timestamp, via: "datalink", paymentId: id });
    // Members whose edge is down get it when it opens (replay).
    for (const edge of this.host.groupLinks?.(params.groupId) ?? []) await this.sendGroupRequest(edge, this.payments.get(id)!).catch(() => {});
    return { paymentId: id };
  }

  /** A request to the group, on one member's edge, as long as that member takes its rail. */
  private async sendGroupRequest(linkId: string, request: StoredPayment): Promise<void> {
    const link = this.host.getLink(linkId);
    if (!link?.supportsPayments) return;
    const endpoints: [string, string][] = request.invoice
      ? (link.allowsPayment("lightning") ? [[ENDPOINT.bolt11, request.invoice]] : [])
      : (link.allowsPayment("cashu") && request.mints?.length ? [[ENDPOINT.cashu, cashuRequestPayload(request.mints)]] : []);
    if (!endpoints.length) return;
    await link.sendPaymentRequest({ id: request.id, timestamp: request.createdAt, amount: { value: String(request.amount), asset: UNIT }, memo: request.memo, endpoints, network: paymentNetwork(request) });
  }

  /** This link may pay this request of ours: its own chat, or, for a request to a group, any edge of that group. */
  private owns(request: StoredPayment, linkId: string): boolean {
    return request.linkId === linkId || (!!request.group && this.host.groupOf?.(linkId) === request.group);
  }

  /**
   * Why a token cannot pay a request to the group, checked before anything is redeemed: already paid, or it would
   * not settle it (too little, a mint the request did not name). Undefined when it can.
   */
  private refuseForGroup(request: StoredPayment, payment: Payment): string | undefined {
    if (request.state !== "pending") return "Already paid by another member of the group";
    const token = this.wallet.inspect?.(payment.endpoint[1]);
    if (token && token.kind === "token" && (token.amount < request.amount || !(request.mints ?? []).includes(token.mint)))
      return "This ecash does not pay the request: the amount or the mint differs";
    return undefined;
  }

  /** Pays a contact's request: ecash when we share a mint with funds, Lightning from any of our mints otherwise. */
  payRequest(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number; network?: WalletNetwork }): Promise<void> {
    const key = `${params.linkId}:${params.paymentId}`;
    const running = this.paying.get(key);
    if (running) return running;
    const operation = this.payRequestOnce(params).finally(() => this.paying.delete(key));
    this.paying.set(key, operation);
    return operation;
  }

  private async payRequestOnce(params: { linkId: string; paymentId: string; via?: "lightning"; maxFee?: number; network?: WalletNetwork }): Promise<void> {
    const request = this.payments.get(params.paymentId);
    if (!request || request.kind !== "request" || request.direction !== "in" || request.linkId !== params.linkId) {
      throw new Error("Unknown payment request");
    }
    // Paid only by a wallet of the request's own network: a test card never settles a request for real money.
    const network = paymentNetwork(request);
    if (params.network && params.network !== network) throw new Error(crossNetwork(params.network, network));
    if (request.target) throw new Error("Review and explicitly approve this payment before sending");
    if (request.state !== "pending") throw new Error("This request is no longer open");
    if (request.lightningPending) throw new Error("A Lightning payment for this request is still pending");
    // Ecash already sent for it is waiting on the contact's answer; paying again would pay twice.
    const inFlight = [...this.payments.values()].some(
      (p) => p.kind === "payment" && p.direction === "out" && p.requestId === request.id && p.state !== "reclaimed" && p.state !== "failed",
    );
    if (inFlight) throw new Error("You already paid this request");
    const link = this.requireLink(params.linkId);
    await link.requirePaymentSupport();
    const lightning = !!request.invoice && link.allowsPayment("lightning");
    // The person reviewed a Lightning payment: that is what is paid, never ecash in its place.
    if (params.via === "lightning" && !lightning) throw new Error("This request cannot be paid over Lightning in this chat");
    // A Fedimint request names no mint: ecash of a shared federation goes through a review, anything else is its invoice.
    if (params.via !== "lightning" && link.allowsPayment("cashu") && !request.federations) {
      try {
        await this.sendEcash(link, {
          linkId: params.linkId,
          amount: request.amount,
          timestamp: Date.now(),
          requestId: request.id,
          mints: request.mints ?? [],
          network,
        });
        return;
      } catch (error) {
        // Lightning only when no ecash left the wallet: a token that exists may already be the contact's.
        if (!lightning || !(error instanceof NoEcashError)) throw error;
      }
    } else if (!lightning) throw new Error("No way of paying this request is allowed in this chat");

    const quote = await this.lightning[network].quote(request.invoice!);
    if (quote.amount !== request.amount) throw new Error("The invoice does not match the requested amount");
    // Never above the ceiling the person approved, when they set one.
    const feeLimit = Math.min(Math.max(10, Math.ceil(request.amount * 0.03)), params.maxFee ?? Infinity);
    if (quote.feeReserve > feeLimit) throw new Error(`The Lightning fee (${quote.feeReserve} sats) is too high`);
    // Marked before the mint is asked to pay, so a pending payment is never paid a second time.
    await this.save({ ...this.current(request), lightningPending: true, paidHere: true, error: undefined });
    let paid: boolean;
    try {
      paid = await this.lightning[network].pay(quote, request.memo ?? "Paid a contact's request", request.id);
    } catch (error) {
      // The wallet throws only when the sats did not go out.
      await this.save({ ...this.current(request), lightningPending: undefined });
      throw error;
    }
    // Still pending (or its answer lost): the source settles it later, through onLightningResolved.
    if (paid) await this.save({ ...this.current(request), state: "settled", mint: quote.mint, lightningPending: undefined });
  }

  /** Takes back ecash the peer never redeemed. If they did redeem it, the mint says so and the payment is settled. */
  reclaim(paymentId: string): Promise<void> {
    // One at a time per payment: a second redeem of the same token fails "spent" and would call it settled.
    let running = this.reclaims.get(paymentId);
    if (!running) {
      running = this.reclaimOnce(paymentId).finally(() => this.reclaims.delete(paymentId));
      this.reclaims.set(paymentId, running);
    }
    return running;
  }

  private async reclaimOnce(paymentId: string): Promise<void> {
    const payment = this.payments.get(paymentId);
    if (payment?.target?.method === "fedimint" && payment.direction === "out" && payment.kind === "payment") {
      const fedimint = this.fedimintOf(payment.federation);
      if (!fedimint || !payment.federation || !payment.fedimintOp) throw new Error("Nothing to take back");
      const state = await fedimint.takeBack(payment.federation, payment.fedimintOp);
      if (state === "pending") throw new Error("The federation has not answered yet: try again in a moment");
      const current = this.current(payment);
      if (state === "canceled") await this.save({ ...current, state: "reclaimed", token: undefined });
      // Redeemed by someone: the contact took it. Only a payment still waiting on them becomes settled.
      else if (current.state === "pending") await this.save({ ...current, state: "settled", token: undefined });
      return;
    }
    if (!payment?.token || payment.direction !== "out") throw new Error("Nothing to reclaim");
    try {
      await this.wallet.receiveToken(payment.token, "reclaimed", payment.memo);
      await this.save({ ...this.current(payment), state: "reclaimed", token: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/spent/i.test(message)) throw error;
      // Spent by someone else: the contact took it. Only a payment still waiting on them becomes settled.
      const current = this.current(payment);
      if (current.state === "pending") await this.save({ ...current, state: "settled", token: undefined });
    }
  }

  // -- what the peer does ----------------------------------------------------------

  /** Asks this side made to pay, until the contact answers with a request (or two minutes pass). */
  private readonly asks = new Map<string, { linkId: string; amount: number; method: AskMethod; network: WalletNetwork; expiresAt: number }>();
  private readonly lastAskFrom = new Map<string, number>();

  /**
   * Paying without a request (Ark, USDT): the contact's app is asked for an address, and answers with an
   * ordinary request carrying this ask's id. Nothing is paid here: the answer is reviewed and approved.
   */
  async ask(params: { linkId: string; amount: number; method: AskMethod; memo?: string; timestamp: number; network?: WalletNetwork }): Promise<{ askId: string }> {
    const network = params.network ?? this.defaultNetwork();
    if (params.method === "usdt") assertTokenUnits(params.amount); else assertAmount(params.amount);
    const link = this.requireLink(params.linkId);
    await link.requirePaymentSupport();
    if (!allows(link, params.method)) throw new Error(`Your contact does not accept ${RAIL_NAME[params.method]} in this chat`);
    const askId = newId();
    this.asks.set(askId, { linkId: params.linkId, amount: params.amount, method: params.method, network, expiresAt: Date.now() + 2 * 60_000 });
    const memo = params.memo?.trim().slice(0, 140) || undefined;
    await link.sendPaymentAsk({ id: askId, timestamp: params.timestamp, amount: { value: String(params.amount), asset: params.method === "usdt" ? "usdtbase" : UNIT }, method: params.method, memo, network });
    return { askId };
  }

  /** The ask a request answers, only if this side made it: same chat, way of paying and amount, still fresh. */
  private answering(linkId: string, request: PaymentRequest, method: AskMethod, amount: number): string | undefined {
    const ask = request.ask ? this.asks.get(request.ask) : undefined;
    // An answer on the other network is not what was asked: it is an ordinary request, not paid by the ask's card.
    if (!ask || ask.linkId !== linkId || ask.method !== method || ask.amount !== amount || ask.expiresAt < Date.now() || (request.network && request.network !== ask.network)) return undefined;
    this.asks.delete(request.ask!);
    return request.ask;
  }

  /**
   * The contact wants to pay this side: answer with a request, as if Request had been pressed. Bounded: one
   * ask every 3 seconds per chat, and five unanswered asked-for requests at most.
   */
  async onPaymentAsk(linkId: string, ask: PaymentAsk): Promise<void> {
    const link = this.host.getLink(linkId);
    if (!link) return;
    const now = Date.now();
    if (now - (this.lastAskFrom.get(linkId) ?? 0) < 3_000) return;
    this.lastAskFrom.set(linkId, now);
    const open = [...this.payments.values()].filter((p) => p.linkId === linkId && p.kind === "request" && p.direction === "out" && p.state === "pending" && p.ask).length;
    if (open >= 5 || !/^[1-9]\d{0,15}$/.test(ask.amount.value)) return;
    if (ask.amount.asset !== (ask.method === "usdt" ? "usdtbase" : UNIT)) return;
    if (!allows(link, ask.method)) return;
    // Answered from this side's wallet of the network the contact pays from (older apps say none: the default).
    await this.request({ linkId, amount: Number(ask.amount.value), method: ask.method, memo: ask.memo, timestamp: now, ask: ask.id, network: ask.network ?? this.defaultNetwork() }).catch(() => {});
  }

  /** A pending request of ours, as it went on the wire: what a held copy is rebuilt from. Cashu and Lightning only. */
  requestFor(paymentId: string): PaymentRequest | null {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.kind !== "request" || payment.direction !== "out" || payment.target || payment.federations) return null;
    return { id: payment.id, timestamp: payment.createdAt, amount: { value: String(payment.amount), asset: payment.unit }, memo: payment.memo, ask: payment.ask, network: paymentNetwork(payment),
      endpoints: [...(payment.invoice ? [[ENDPOINT.bolt11, payment.invoice] as [string, string]] : []), ...(payment.mints?.length ? [[ENDPOINT.cashu, cashuRequestPayload(payment.mints)] as [string, string]] : [])] };
  }

  /** `held`: picked up from the contact's storage while it was away (WISP 4xx): only what this device allows counts, and only Cashu or Lightning. */
  async onPaymentRequest(linkId: string, request: PaymentRequest, held = false): Promise<void> {
    if (this.payments.has(request.id)) return;
    if (held && (findEndpoint(request.endpoints, ENDPOINT.usdt) || findEndpoint(request.endpoints, ENDPOINT.arkade) || findEndpoint(request.endpoints, ENDPOINT.bark) || findEndpoint(request.endpoints, ENDPOINT.bitcoin) || findEndpoint(request.endpoints, ENDPOINT.fedimint) || findEndpoint(request.endpoints, ENDPOINT.spark))) return;
    if(findEndpoint(request.endpoints,ENDPOINT.usdt))return this.receiveUsdtRequest(linkId,request);
    const amount = parseSats(request.amount.value, request.amount.asset);
    const link = this.host.getLink(linkId);
    if (amount === null) {
      link?.sendPaymentResult({ id: request.id, ok: false, error: "Only whole amounts in sats are supported" });
      return;
    }
    let target: PaymentTarget | undefined;
    let federations: string[] | undefined;
    const arkPayload=findEndpoint(request.endpoints,ENDPOINT.arkade), barkPayload=findEndpoint(request.endpoints,ENDPOINT.bark), bitcoinPayload=findEndpoint(request.endpoints,ENDPOINT.bitcoin), fedimintPayload=findEndpoint(request.endpoints,ENDPOINT.fedimint), sparkPayload=findEndpoint(request.endpoints,ENDPOINT.spark);
    if (fedimintPayload) {
      if(!link?.supportsFedimintPayments)return;
      federations=parseFedimintRequestPayload(fedimintPayload);
      if(!federations.length)return;
      // Ecash when we share a federation (the one we hold most in); the invoice, through any Lightning source, otherwise.
      const ours=new Map((this.fedimint ? distinct(this.fedimint) : []).flatMap(w=>w.view.federations).filter(f=>f.status==="ready").map(f=>[f.id,f.balance]));
      const shared=federations.filter(id=>ours.has(id)).sort((a,b)=>ours.get(b)!-ours.get(a)!);
      if(shared.length)target=this.fedimintOf(shared[0])!.target(shared[0],request.id);
    } else if (arkPayload) {
      if(!link?.supportsArkPayments)return;
      try {target=validatePaymentTarget(JSON.parse(arkPayload));if(target.method!=="arkade")return;} catch {return;}
    } else if (barkPayload) {
      if(!link?.supportsBarkPayments)return;
      try {target=validatePaymentTarget(JSON.parse(barkPayload));if(target.method!=="bark")return;} catch {return;}
    } else if (bitcoinPayload) {
      if(!link?.supportsBitcoinPayments)return;
      try {target=validatePaymentTarget(JSON.parse(bitcoinPayload));if(target.method!=="bitcoin")return;} catch {return;}
    } else if (sparkPayload) {
      if(!link?.supportsSparkPayments)return;
      // Only an invoice: a bare Spark address cannot tell this request's payment from any other.
      // Only an invoice for exactly this amount, in sats: what is asked is what the invoice asks.
      try {target=validatePaymentTarget(JSON.parse(sparkPayload));const asked=target.method==="spark" ? sparkInvoiceDetails(target.address,target.network as SparkNetwork) : undefined;if(!asked || asked.token || asked.amount!==amount)return;} catch {return;}
    }
    // Keep only the ways of paying this chat allows; a request with none left is dropped.
    const allowed = (method: "lightning" | "cashu") => held ? !!link?.paymentEnabled(method) : !!link?.allowsPayment(method);
    const invoice = allowed("lightning") ? findEndpoint(request.endpoints, ENDPOINT.bolt11) : undefined;
    const mints = allowed("cashu") ? parseCashuRequestPayload(findEndpoint(request.endpoints, ENDPOINT.cashu) ?? "") : [];
    if (!target && !invoice && !mints.length && !federations) return;
    await this.save({
      target,
      federations,
      ask: federations ? this.answering(linkId, request, "fedimint", amount) : target?.method === "arkade" || target?.method === "bark" || target?.method === "bitcoin" || target?.method === "spark" ? this.answering(linkId, request, target.method, amount) : undefined,
      id: request.id,
      linkId,
      kind: "request",
      direction: "in",
      amount,
      unit: UNIT,
      memo: request.memo,
      state: "pending",
      createdAt: request.timestamp,
      invoice,
      mints,
      // What the contact said, else what it carries (older apps say nothing).
      network: request.network ?? paymentNetwork({ target, mints, invoice }),
    });
    await this.host.storeMessage({
      linkId,
      id: `peer_${request.timestamp}`,
      text: `⚡ Requested ${amount.toLocaleString()} sats`,
      sender: "peer",
      timestamp: request.timestamp,
      via: held ? "hold" : "datalink",
      paymentId: request.id,
    });
  }

  onPayment(linkId: string, payment: Payment): Promise<void> {
    // Payments of one request to a group, from several members, one after the other: the first settles it, the
    // others then find it paid and are refused before anything is redeemed.
    const key = payment.requestId && this.payments.get(payment.requestId)?.group ? `request:${payment.requestId}` : payment.id;
    const running = this.receiving.get(key);
    // Serialise even a collision from a different link, then re-check ownership.
    const operation = (running ?? Promise.resolve()).catch(() => {}).then(() => this.receivePayment(linkId, payment));
    this.receiving.set(key, operation);
    return operation.finally(() => { if (this.receiving.get(key) === operation) this.receiving.delete(key); });
  }

  private async receivePayment(linkId: string, payment: Payment): Promise<void> {
    // An invoice sent back is not money: it is the contact saying it paid our invoice from another wallet.
    if(payment.endpoint[0]===ENDPOINT.bolt11) { await this.receiveCheck(linkId,payment); return; }
    if(payment.endpoint[0]===ENDPOINT.usdt) { await this.receiveUsdt(linkId,payment); return; }
    if(payment.endpoint[0]===ENDPOINT.arkade) { await this.receiveArk(linkId,payment); return; }
    if(payment.endpoint[0]===ENDPOINT.bark) { await this.receiveBark(linkId,payment); return; }
    if(payment.endpoint[0]===ENDPOINT.bitcoin) { await this.receiveBitcoin(linkId,payment); return; }
    if(payment.endpoint[0]===ENDPOINT.fedimint) { await this.receiveFedimint(linkId,payment); return; }
    if(payment.endpoint[0]===ENDPOINT.spark) { await this.receiveSpark(linkId,payment); return; }
    const link = this.host.getLink(linkId);
    const known = this.payments.get(payment.id);
    if (known && (known.linkId !== linkId || known.direction !== "in" || known.kind !== "payment")) {
      // Another link's id. Answering from its record would tell this contact about that one.
      link?.sendPaymentResult({ id: payment.id, ok: false, error: "Unknown payment" });
      return;
    }
    if (known) {
      // A retransmission: say again what happened, redeem nothing twice.
      link?.sendPaymentResult({ id: payment.id, ok: known.state === "settled", credited: String(known.amount), error: known.error });
      return;
    }

    if (!link?.allowsPayment("cashu")) {
      // Not redeemed: the token stays the contact's, and they can take it back.
      link?.sendPaymentResult({ id: payment.id, ok: false, error: "Cashu is off in this chat" });
      return;
    }
    const forGroup = payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if (forGroup?.group && forGroup.kind === "request" && forGroup.direction === "out" && this.owns(forGroup, linkId)) {
      const refused = this.refuseForGroup(forGroup, payment);
      // Not redeemed either: the member takes it back.
      if (refused) { link.sendPaymentResult({ id: payment.id, ok: false, error: refused }); return; }
    }
    const [identifier, token] = payment.endpoint;
    try {
      if (identifier !== ENDPOINT.cashu) throw new Error("Unsupported payment method");
      if (parseSats(payment.amount.value, payment.amount.asset) === null) throw new Error("Unsupported amount");
      const record = (amount: number, mint: string): StoredPayment => ({
        id: payment.id,
        linkId,
        kind: "payment",
        direction: "in",
        amount,
        unit: UNIT,
        memo: payment.memo,
        state: "settled",
        createdAt: payment.timestamp,
        mint,
        requestId: payment.requestId,
      });
      // Ecash from the public test mint is worthless and is taken in; a real mint the user did not pick is refused.
      const { amount, mint } = await this.wallet.receiveToken(token, "ecash-in", payment.memo, { addTestMint: true, payment: record });
      // The payment record and received proofs were committed in one transaction.
      await this.save(record(amount, mint));
      // It settles our request only in full and in ecash from a mint the request named. Anything less is
      // received, and the request stays open.
      const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
      if (
        request?.kind === "request" &&
        request.direction === "out" &&
        this.owns(request, linkId) &&
        request.state === "pending" &&
        amount >= request.amount &&
        (request.mints ?? []).includes(mint) &&
        (!isWorthlessMint(mint) || (request.mints ?? []).every(isWorthlessMint))
      ) {
        if (request.group) await this.settleRequest(request, { mint });
        else await this.save({ ...request, state: "settled", mint });
      }
      await this.host.storeMessage({
        linkId,
        id: `peer_${payment.timestamp}`,
        text: `⚡ ${amount.toLocaleString()} ${isWorthlessMint(mint) ? "test sats" : "sats"}`,
        sender: "peer",
        timestamp: payment.timestamp,
        via: "datalink",
        paymentId: payment.id,
      });
      link?.sendPaymentResult({ id: payment.id, ok: true, credited: String(amount) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      link?.sendPaymentResult({ id: payment.id, ok: false, error: reason });
      // Said once in the chat (same id on a retransmission), so a refusal is never silent.
      const sats = parseSats(payment.amount.value, payment.amount.asset);
      try { await this.host.storeMessage({ linkId, id: `peer_${payment.timestamp}_refused`, text: `Could not receive ${sats === null ? "a payment" : `${sats.toLocaleString()} sats`}: ${reason}`, sender: "peer", timestamp: payment.timestamp, via: "datalink" }); } catch { /* the refusal already went to the contact */ }
    }
  }

  async onPaymentResult(linkId: string, result: PaymentResult): Promise<void> {
    const payment = this.payments.get(result.id);
    if (payment?.target?.method === "fedimint" && payment.linkId === linkId && payment.direction === "out" && payment.kind === "payment") {
      if (payment.state !== "pending") return;
      if (!result.ok) {
        // Refused (a federation they did not join, Fedimint off): the notes come straight back.
        await this.save({ ...payment, error: result.error ?? "The payment was refused" });
        await this.reclaim(payment.id).catch(() => {});
        if (this.current(payment).state === "reclaimed") await this.host.onReviewedPaymentRefused?.(payment.id, result.error ?? "The payment was refused");
        return;
      }
      // The contact redeemed them: the notes are theirs now, and the copy kept here is worth nothing.
      await this.save({ ...payment, state: "settled", token: undefined, error: undefined });
      const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
      if (request?.linkId === linkId && request.state === "pending") await this.save({ ...request, state: "settled" });
      void Promise.resolve(this.host.onReviewedPaymentResult?.(payment.id)).catch(() => {});
      return;
    }
    if(payment?.target?.method==="cashu" && payment.linkId===linkId && payment.direction==="out"){
      if(!result.ok && payment.state==="pending"){
        // Refused: take the token back instead of offering it again, which would be refused again.
        await this.save({...payment,error:result.error ?? "The payment was refused"});
        await this.reclaim(payment.id).catch(()=>{});
        if(this.current(payment).state==="reclaimed")await this.host.onReviewedPaymentRefused?.(payment.id,result.error ?? "The payment was refused");
        return;
      }
      // Not awaited: this runs in the chat's inbound queue, and reconciling can wait on the approval that
      // is itself waiting for this very result. Every later frame of the chat would stall behind it.
      void Promise.resolve(this.host.onReviewedPaymentResult?.(payment.id)).catch(() => {});
      return;
    }
    if (!payment || payment.linkId !== linkId || payment.state !== "pending") return;

    if (payment.kind === "request") {
      // Only the payee can declare a request paid, and only about a request it sent us. It says so once its
      // own wallet saw the money (its source, its chain, its Ark server), however the request was paid.
      if (payment.direction === "in" && result.ok) await this.save({ ...payment, state: "settled", lightningPending: undefined });
      return;
    }
    // A payment with a target reconciles through its own adapter, never on the contact's word.
    if (payment.target || payment.direction !== "out") return;

    if (result.ok) {
      await this.save({ ...payment, state: "settled", token: undefined });
      const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
      if (request?.state === "pending") await this.save({ ...request, state: "settled" });
      return;
    }
    // Refused (a mint they do not use, for instance): the ecash comes straight back.
    await this.save({ ...payment, error: result.error ?? "The payment was refused" });
    await this.reclaim(payment.id).catch(async () => {
      await this.save({ ...this.payments.get(payment.id)!, state: "failed" });
    });
  }

  /** The Lightning source saw one of our invoices paid: if it was a chat request, tell the contact who paid it. */
  async onLightningPaid(op: { paymentId?: string; mint?: string }): Promise<void> {
    const request = op.paymentId ? this.payments.get(op.paymentId) : undefined;
    if (!request || request.state !== "pending") return;
    await this.settleRequest(request, { mint: op.mint });
  }

  /**
   * A request of ours is paid: our own wallet saw the money. The contact is told, so its bubble turns
   * Paid by itself, whatever wallet it paid from.
   */
  private async settleRequest(request: StoredPayment, extra: Partial<StoredPayment> = {}): Promise<void> {
    await this.save({ ...this.current(request), ...extra, state: "settled" });
    // A request to a group closes on every member's copy: nobody else pays it.
    const links = request.group ? this.host.groupLinks?.(request.group) ?? [] : [request.linkId];
    for (const linkId of links) this.host.getLink(linkId)?.sendPaymentResult({ id: request.id, ok: true });
  }

  // -- paid from another wallet -------------------------------------------------------

  private readonly lastCheck = new Map<string, number>();
  private readonly lastCheckFrom = new Map<string, number>();

  /**
   * "I paid it from another wallet": the contact's app is asked to look at its wallet now. Nothing here
   * marks anything paid; the request settles when the payee's wallet sees the money, with or without this.
   */
  async checkPayment(params: { linkId: string; paymentId: string }): Promise<void> {
    const request = this.payments.get(params.paymentId);
    if (!request || request.kind !== "request" || request.direction !== "in" || request.linkId !== params.linkId) throw new Error("Unknown payment request");
    if (request.state !== "pending") return;
    const endpoint: [string, string] | undefined = request.target
      ? request.target.method === "fedimint" ? request.invoice ? [ENDPOINT.bolt11, request.invoice] : undefined
      : request.target.method === "usdt" || request.target.method === "cashu" ? undefined : [ENDPOINT_OF[request.target.method], CHECK_PAYLOAD]
      : request.invoice ? [ENDPOINT.bolt11, request.invoice] : undefined;
    if (!endpoint) throw new Error("This request cannot be paid from another wallet");
    const now = Date.now();
    if (now - (this.lastCheck.get(request.id) ?? 0) < 5_000) return;
    this.lastCheck.set(request.id, now);
    const link = this.requireLink(params.linkId);
    await link.sendPayment({ id: newId(), timestamp: now, requestId: request.id, amount: { value: String(request.amount), asset: UNIT }, endpoint });
  }

  /**
   * The contact says it paid one of our requests from another wallet: our wallet is asked now, and it alone
   * decides. A request already paid is said so again (the first answer may have been lost). Bounded: one
   * look every 3 seconds per request.
   */
  private async receiveCheck(linkId: string, payment: Payment): Promise<void> {
    const link = this.host.getLink(linkId);
    const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if (!link || !request || request.kind !== "request" || request.direction !== "out" || !this.owns(request, linkId)) return;
    const rail = request.target ? request.target.method : request.invoice ? "lightning" : undefined;
    if (!rail || rail === "usdt" || rail === "cashu" || rail === "fedimint" || payment.endpoint[0] !== (rail === "lightning" ? ENDPOINT.bolt11 : ENDPOINT_OF[rail])) return;
    if (request.state === "settled") { link.sendPaymentResult({ id: request.id, ok: true }); return; }
    const now = Date.now();
    if (now - (this.lastCheckFrom.get(request.id) ?? 0) < 3_000) return;
    this.lastCheckFrom.set(request.id, now);
    try {
      if (rail === "lightning") await this.lightning[paymentNetwork(request)].check?.();
      else if (rail === "bitcoin") await this.reconcileBitcoinReceipts();
      else if (rail === "bark") await this.reconcileBarkReceipts();
      else if (rail === "spark") await this.reconcileSparkReceipts();
      else await this.reconcileArkReceipts();
    } catch { /* the wallet could not be asked right now: the regular checks go on */ }
  }

  /** A Lightning payment of a contact's request that was left pending (or unknown) settled. */
  async onLightningResolved(op: { paymentId?: string; mint?: string }, paid: boolean): Promise<void> {
    const found = op.paymentId ? this.payments.get(op.paymentId) : undefined;
    if (found?.kind !== "request" || found.direction !== "in") return;
    const request = { ...found, lightningPending: undefined };
    if (paid) await this.save(request.state === "pending" ? { ...request, state: "settled", mint: op.mint } : request);
    else await this.save({ ...request, error: "The Lightning payment did not go through" });
  }

  onQuotePaid(quote: StoredQuote): Promise<void> { return this.onLightningPaid(quote); }
  onMeltResolved(melt: PendingMelt, paid: boolean): Promise<void> { return this.onLightningResolved(melt, paid); }

  private async receiveUsdtRequest(linkId:string,request:PaymentRequest) {
    if(!this.host.getLink(linkId)?.supportsUsdtPayments)return;
    let target:PaymentTarget;
    try {target=validatePaymentTarget(JSON.parse(findEndpoint(request.endpoints,ENDPOINT.usdt)!));}catch{return;}
    const unit=target.asset==='USDT'?'usdt':'testusdt';
    if(target.method!=='usdt'||request.amount.asset!==unit||!/^[1-9]\d{0,15}$/.test(request.amount.value))return;
    const amount=Number(request.amount.value);if(!Number.isSafeInteger(amount))return;
    await this.save({id:request.id,linkId,kind:'request',direction:'in',amount,unit,target,memo:request.memo,state:'pending',createdAt:request.timestamp,ask:this.answering(linkId,request,'usdt',amount)});
    await this.host.storeMessage({linkId,id:`peer_${request.timestamp}`,text:`Requested ${formatPaymentAmount(amount,target.decimals)} ${target.asset}`,sender:'peer',timestamp:request.timestamp,via:'datalink',paymentId:request.id});
  }
  async recordUsdt(review:PaymentReview) {
    if(review.method!=='usdt'||!review.linkId||!review.txid||!['submitted','settled','failed','unknown'].includes(review.state))return;
    const link=this.requireLink(review.linkId),unit=review.asset==='USDT'?'usdt':'testusdt';
    await this.save({id:review.id,linkId:review.linkId,kind:'payment',direction:'out',amount:review.amount,unit,state:review.state==='settled'?'settled':review.state==='failed'?'failed':'pending',error:review.error,createdAt:review.createdAt,requestId:review.requestId,target:review,txid:review.txid});
    if(review.state==='settled'&&review.requestId){const request=this.payments.get(review.requestId);if(request?.linkId===review.linkId)await this.save({...request,state:'settled'});}
    await this.host.storeMessage({linkId:review.linkId,id:`me_${review.createdAt}`,text:`${formatPaymentAmount(review.amount,review.decimals)} ${review.asset}`,sender:'me',timestamp:review.createdAt,via:'datalink',paymentId:review.id});
    if(link.supportsUsdtPayments&&review.state!=='failed')await link.sendPayment({id:review.id,timestamp:review.createdAt,requestId:review.requestId,amount:{value:String(review.amount),asset:unit},endpoint:[ENDPOINT.usdt,JSON.stringify({txid:review.txid})]});
  }
  private async receiveUsdt(linkId:string,payment:Payment) {
    const request=payment.requestId?this.payments.get(payment.requestId):undefined;
    if(!this.host.getLink(linkId)?.supportsUsdtPayments||request?.target?.method!=='usdt'||request.linkId!==linkId||request.direction!=='out'||request.kind!=='request'||payment.amount.asset!==request.unit||payment.amount.value!==String(request.amount))return;
    const existing=this.payments.get(payment.id);
    if(existing && (existing.direction!=='in'||existing.linkId!==linkId||existing.requestId!==request.id))return;
    let txid:string;try{txid=JSON.parse(payment.endpoint[1]).txid;}catch{return;}
    if(typeof txid!=='string'||!/^0x[a-fA-F0-9]{64}$/.test(txid)||existing?.state==='settled')return;
    // One transaction pays one request, however its hash is spelled.
    txid=txid.toLowerCase();
    if([...this.payments.values()].some(p=>p.txid?.toLowerCase()===txid&&(p.linkId!==linkId||(p.kind==='request'?p.id!==request.id:p.requestId!==request.id))))return;
    await this.save({id:payment.id,linkId,kind:'payment',direction:'in',amount:request.amount,unit:request.unit,state:'pending',createdAt:payment.timestamp,target:request.target,requestId:request.id,txid});
    await this.host.storeMessage({linkId,id:`peer_${payment.timestamp}`,text:`${formatPaymentAmount(request.amount,request.target.decimals)} ${request.target.asset} — checking chain`,sender:'peer',timestamp:payment.timestamp,via:'datalink',paymentId:payment.id});
    await this.reconcileUsdtReceipts();
  }
  async reconcileUsdtReceipts() {
    if(this.checkingUsdt||!this.usdt)return;
    this.checkingUsdt=true;
    try {
      for(const payment of this.payments.values()) {
        if(payment.kind!=='payment'||payment.direction!=='in'||payment.state!=='pending'||!payment.txid||payment.target?.method!=='usdt')continue;
        // Its own network's wallet reads the chain: the other's is not on it.
        const adapter=this.usdt[walletNetworkOf(payment.target.network)].adapter;if(!adapter)continue;
        const result=await adapter.receipt(payment.txid,{...payment.target,amount:payment.amount}).catch(()=>null);
        if(!result?.settled&&!result?.failed)continue;
        await this.save({...payment,state:result.settled?'settled':'failed',error:result.error});
        if(result.settled){const request=payment.requestId?this.payments.get(payment.requestId):undefined;if(request?.linkId===payment.linkId)await this.save({...request,state:'settled',txid:payment.txid});}
      }
    } finally {this.checkingUsdt=false;}
  }
  payment(id:string) { return this.payments.get(id); }
  async recordArk(review:PaymentReview):Promise<void> {
    if(review.method!=="arkade")return;
    if(!review.linkId || !review.txid || review.state!=="settled")return;
    const link=this.requireLink(review.linkId);
    const record:StoredPayment={id:review.id,linkId:review.linkId,kind:"payment",direction:"out",amount:review.amount,unit:UNIT,state:"settled",createdAt:review.createdAt,requestId:review.requestId,target:review,txid:review.txid};
    await this.save(record);
    if(review.requestId){const request=this.payments.get(review.requestId);if(request?.linkId===review.linkId)await this.save({...request,state:"settled"});}
    await this.host.storeMessage({linkId:review.linkId,id:`me_${review.createdAt}`,text:`${review.amount} ${arkSats(review.network)} on Ark`,sender:"me",timestamp:review.createdAt,via:"datalink",paymentId:review.id});
    // Receipt is replayable; it never causes another wallet spend.
    if(link.supportsArkPayments)await link.sendPayment({id:review.id,timestamp:review.createdAt,requestId:review.requestId,amount:{value:String(review.amount),asset:UNIT},endpoint:[ENDPOINT.arkade,JSON.stringify({txid:review.txid})]});
  }
  async recordCashu(review:PaymentReview,token:string):Promise<void> {
    if(!review.linkId || review.method!=="cashu")throw new Error("Cashu chat recipient missing");
    const link=this.requireLink(review.linkId);
    await link.requirePaymentSupport();
    const existing=await wrap<StoredPayment|undefined>((await store(STORES.payments,"readonly")).get(review.id));
    if(!existing || existing.linkId!==review.linkId || existing.requestId!==review.requestId)throw new Error("Cashu outbox does not match the reviewed payment");
    this.payments.set(existing.id,existing);
    this.host.onChange();
    await this.host.storeMessage({linkId:review.linkId,id:`me_${review.createdAt}`,text:`${review.amount} sats via Cashu`,sender:"me",timestamp:review.createdAt,via:"datalink",paymentId:review.id});
    await link.sendPayment({id:review.id,timestamp:review.createdAt,requestId:review.requestId,amount:{value:String(review.amount),asset:UNIT},memo:review.memo,endpoint:[ENDPOINT.cashu,token]});
  }
  async confirmReviewedCashu(review:PaymentReview):Promise<void> {
    if(review.method!=="cashu" || review.state!=="settled")return;
    const payment=this.payments.get(review.id) ?? await wrap<StoredPayment|undefined>((await store(STORES.payments,"readonly")).get(review.id));
    // Ecash we took back is spent too, by us: the mint saying "spent" then is not the contact being paid.
    if(!payment || payment.linkId!==review.linkId || payment.state==="reclaimed")return;
    await this.save({...payment,state:"settled",token:undefined});
    const request=payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if(request?.linkId===payment.linkId)await this.save({...request,state:"settled"});
  }
  private async receiveArk(linkId:string,payment:Payment):Promise<void> {
    if(isCheck(payment.endpoint[1])){await this.receiveCheck(linkId,payment);return;}
    const link=this.host.getLink(linkId),request=payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if(!link?.supportsArkPayments || !request?.target || request.linkId!==linkId || request.direction!=="out" || request.kind!=="request")return;
    const existing=this.payments.get(payment.id);
    if(existing && (existing.linkId!==linkId || existing.direction!=="in" || existing.requestId!==request.id))return;
    if(parseSats(payment.amount.value,payment.amount.asset)!==request.amount)return;
    let txid:string;try {txid=JSON.parse(payment.endpoint[1]).txid;}catch{return;}
    if([...this.payments.values()].some(p=>p.txid===txid && (p.linkId!==linkId || (p.kind==="request" ? p.id!==request.id : p.requestId!==request.id))))return;
    if(typeof txid!=="string" || !/^[a-f0-9]{64}$/.test(txid) || existing?.state==="settled")return;
    await this.save({id:payment.id,linkId,kind:"payment",direction:"in",amount:request.amount,unit:UNIT,state:"pending",createdAt:payment.timestamp,target:request.target,requestId:request.id,txid});
    await this.host.storeMessage({linkId,id:`peer_${payment.timestamp}`,text:`${request.amount} ${arkSats(request.target.network)} on Ark — checking provider`,sender:"peer",timestamp:payment.timestamp,via:"datalink",paymentId:payment.id});
    await this.reconcileArkReceipts();
  }
  /**
   * An Ark request is paid when a virtual output of at least the amount reached the address made for it,
   * whoever sent it: with the contact's receipt (its txid, verified), or without one, through the indexer.
   */
  async reconcileArkReceipts():Promise<void> {
    if(this.checkingArk || !this.ark || !distinct(this.ark).some(w=>w.adapter))return;
    this.checkingArk=true;
    try {
      for(const request of [...this.payments.values()]) {
        if(request.kind!=="request" || request.direction!=="out" || request.state!=="pending" || request.target?.method!=="arkade")continue;
        const adapter=this.ark[walletNetworkOf(request.target.network)].adapter;
        if(!adapter || request.target.provider!==adapter.config.provider || request.target.network!==adapter.config.network)continue;
        const claimed=new Set([...this.payments.values()].filter(p=>p.target?.method==="arkade" && p.kind==="request" && p.id!==request.id && p.txid).map(p=>p.txid!));
        const txid=await adapter.received(request.target.address,request.amount,request.createdAt,claimed).catch(()=>undefined);
        if(!txid)continue;
        await this.settleRequest(request,{txid});
        for(const payment of this.payments.values())if(payment.kind==="payment" && payment.direction==="in" && payment.requestId===request.id && payment.state==="pending")await this.save({...payment,state:"settled",txid});
      }
      for(const payment of this.payments.values()) {
        if(payment.kind!=="payment" || payment.direction!=="in" || payment.state!=="pending" || !payment.txid || payment.target?.method!=="arkade")continue;
        const adapter=this.ark[walletNetworkOf(payment.target.network)].adapter;
        if(!adapter || payment.target.provider!==adapter.config.provider || payment.target.network!==adapter.config.network)continue;
        if(!await adapter.verifyReceipt(payment.txid,payment.target.address,payment.amount).catch(()=>false))continue;
        await this.save({...payment,state:"settled"});
        const request=payment.requestId ? this.payments.get(payment.requestId) : undefined;
        if(request?.linkId===payment.linkId && request.state==="pending")await this.settleRequest(request,{txid:payment.txid});
      }
    } finally {this.checkingArk=false;}
  }

  /** Our Bark payment went out: said in the chat, and the contact is told (a hint; their wallet is the proof). */
  async recordBark(review:PaymentReview):Promise<void> {
    if(review.method!=="bark" || !review.linkId || review.state!=="settled")return;
    const link=this.requireLink(review.linkId);
    await this.save({id:review.id,linkId:review.linkId,kind:"payment",direction:"out",amount:review.amount,unit:UNIT,state:"settled",createdAt:review.createdAt,requestId:review.requestId,target:review,txid:review.txid});
    if(review.requestId){const request=this.payments.get(review.requestId);if(request?.linkId===review.linkId)await this.save({...request,state:"settled"});}
    await this.host.storeMessage({linkId:review.linkId,id:`me_${review.createdAt}`,text:`${review.amount} ${arkSats(review.network)} on Bark`,sender:"me",timestamp:review.createdAt,via:"datalink",paymentId:review.id});
    // Replayable; it never causes another spend.
    if(link.supportsBarkPayments)await link.sendPayment({id:review.id,timestamp:review.createdAt,requestId:review.requestId,amount:{value:String(review.amount),asset:UNIT},endpoint:[ENDPOINT.bark,JSON.stringify({txid:review.txid})]});
  }
  /** The contact says it paid one of our Bark requests. Recorded as pending until our own wallet shows it. */
  private async receiveBark(linkId:string,payment:Payment):Promise<void> {
    if(isCheck(payment.endpoint[1])){await this.receiveCheck(linkId,payment);return;}
    const link=this.host.getLink(linkId),request=payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if(!link?.supportsBarkPayments || request?.target?.method!=="bark" || request.linkId!==linkId || request.direction!=="out" || request.kind!=="request")return;
    const existing=this.payments.get(payment.id);
    if(existing && (existing.linkId!==linkId || existing.direction!=="in" || existing.requestId!==request.id))return;
    if(existing || parseSats(payment.amount.value,payment.amount.asset)!==request.amount)return;
    await this.save({id:payment.id,linkId,kind:"payment",direction:"in",amount:request.amount,unit:UNIT,state:request.state==="settled"?"settled":"pending",createdAt:payment.timestamp,target:request.target,requestId:request.id,txid:request.txid});
    await this.host.storeMessage({linkId,id:`peer_${payment.timestamp}`,text:`${request.amount} ${arkSats(request.target.network)} on Bark${request.state==="settled"?"":" — checking wallet"}`,sender:"peer",timestamp:payment.timestamp,via:"datalink",paymentId:payment.id});
    await this.reconcileBarkReceipts();
  }
  /**
   * A Bark request is paid when this wallet received, on the address made for it, at least the amount asked,
   * after asking. It settles with or without the contact's receipt, and one receive pays one request.
   */
  async reconcileBarkReceipts():Promise<void> {
    if(this.checkingBark || !this.bark || !distinct(this.bark).some(w=>w.adapter))return;
    this.checkingBark=true;
    try {
      const open=[...this.payments.values()].filter(r=>r.kind==="request" && r.direction==="out" && r.state==="pending" && r.target?.method==="bark");
      for(const wallet of distinct(this.bark))if(open.some(r=>walletNetworkOf(r.target!.network)===wallet.network))await wallet.adapter?.sync().catch(()=>{});
      for(const request of open) {
        if(request.kind!=="request" || request.direction!=="out" || request.state!=="pending" || request.target?.method!=="bark")continue;
        const adapter=this.bark[walletNetworkOf(request.target.network)].adapter;
        if(!adapter || request.target.provider!==adapter.config.provider || request.target.network!==adapter.config.network)continue;
        const claimed=new Set([...this.payments.values()].filter(p=>p.target?.method==="bark" && p.kind==="request" && p.txid).map(p=>p.txid!));
        const txid=await adapter.received(request.target.address,request.amount,request.createdAt,claimed).catch(()=>undefined);
        if(!txid)continue;
        await this.settleRequest(request,{txid});
        for(const payment of this.payments.values())if(payment.kind==="payment" && payment.direction==="in" && payment.requestId===request.id && payment.state==="pending")await this.save({...payment,state:"settled",txid});
      }
    } finally {this.checkingBark=false;}
  }

  /**
   * Our on-chain payment is out (broadcast) or confirmed: said in the chat once, and the contact is told the
   * txid (a hint; their own wallet is the proof). The request it answers is paid only once it confirms.
   */
  async recordBitcoin(review:PaymentReview):Promise<void> {
    if(review.method!=="bitcoin" || !review.linkId || !review.txid || !["submitted","settled","unknown","failed"].includes(review.state))return;
    const known=this.payments.get(review.id);
    if(known && (known.linkId!==review.linkId || known.kind!=="payment" || known.direction!=="out"))return;
    // Failed after it went out (another transaction spent its coins): only what was recorded is updated.
    if(review.state==="failed"){ if(known && known.state!=="failed")await this.save({...known,state:"failed",error:review.error}); return; }
    const state=review.state==="settled" ? "settled" : "pending";
    if(known?.state===state && known.txid===review.txid)return;
    await this.save({id:review.id,linkId:review.linkId,kind:"payment",direction:"out",amount:review.amount,unit:UNIT,state,createdAt:review.createdAt,requestId:review.requestId,target:review,txid:review.txid});
    if(state==="settled" && review.requestId){const request=this.payments.get(review.requestId);if(request?.linkId===review.linkId)await this.save({...request,state:"settled",txid:review.txid});}
    if(!known)await this.host.storeMessage({linkId:review.linkId,id:`me_${review.createdAt}`,text:`${review.amount} ${arkSats(review.network)} on-chain`,sender:"me",timestamp:review.createdAt,via:"datalink",paymentId:review.id});
    // Replayable; it never causes another spend.
    const link=this.host.getLink(review.linkId);
    if(link?.supportsBitcoinPayments)await link.sendPayment({id:review.id,timestamp:review.createdAt,requestId:review.requestId,amount:{value:String(review.amount),asset:UNIT},endpoint:[ENDPOINT.bitcoin,JSON.stringify({txid:review.txid})]});
  }
  /** The contact says it paid one of our on-chain requests. Pending until our own wallet sees it confirmed. */
  private async receiveBitcoin(linkId:string,payment:Payment):Promise<void> {
    if(isCheck(payment.endpoint[1])){await this.receiveCheck(linkId,payment);return;}
    const link=this.host.getLink(linkId),request=payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if(!link?.supportsBitcoinPayments || request?.target?.method!=="bitcoin" || request.linkId!==linkId || request.direction!=="out" || request.kind!=="request")return;
    const existing=this.payments.get(payment.id);
    if(existing && (existing.linkId!==linkId || existing.direction!=="in" || existing.requestId!==request.id))return;
    if(existing || parseSats(payment.amount.value,payment.amount.asset)!==request.amount)return;
    let hint:unknown;try {hint=JSON.parse(payment.endpoint[1]).txid;}catch{return;}
    if(typeof hint!=="string" || !/^[0-9a-f]{64}$/.test(hint))return;
    const settled=request.state==="settled";
    await this.save({id:payment.id,linkId,kind:"payment",direction:"in",amount:request.amount,unit:UNIT,state:settled?"settled":"pending",createdAt:payment.timestamp,target:request.target,requestId:request.id,txid:settled?request.txid:hint});
    await this.host.storeMessage({linkId,id:`peer_${payment.timestamp}`,text:`${request.amount} ${arkSats(request.target.network)} on-chain${settled?"":" — waiting for a confirmation"}`,sender:"peer",timestamp:payment.timestamp,via:"datalink",paymentId:payment.id});
    await this.reconcileBitcoinReceipts();
  }
  /**
   * An on-chain request is paid when this wallet's source has a confirmed transaction paying the address made
   * for it at least the amount asked. It settles with or without the contact's receipt; one transaction pays
   * one request.
   */
  async reconcileBitcoinReceipts():Promise<void> {
    if(this.checkingBitcoin || !this.bitcoin)return;
    this.checkingBitcoin=true;
    try {
      for(const request of [...this.payments.values()]) {
        if(request.kind!=="request" || request.direction!=="out" || request.state!=="pending" || request.target?.method!=="bitcoin")continue;
        const claimed=new Set([...this.payments.values()].filter(p=>p.target?.method==="bitcoin" && p.kind==="request" && p.id!==request.id && p.txid).map(p=>p.txid!));
        const receipt=[...this.payments.values()].find(p=>p.kind==="payment" && p.direction==="in" && p.requestId===request.id && p.linkId===request.linkId);
        const seen=await this.bitcoin[walletNetworkOf(request.target.network)].received(request.target,request.amount,claimed,receipt?.txid).catch(()=>undefined);
        if(!seen || seen.confirmations<1)continue;
        await this.settleRequest(request,{txid:seen.txid});
        for(const payment of this.payments.values())if(payment.kind==="payment" && payment.direction==="in" && payment.requestId===request.id && payment.state==="pending")await this.save({...payment,state:"settled",txid:seen.txid});
      }
    } finally {this.checkingBitcoin=false;}
  }

  // -- Fedimint ------------------------------------------------------------------------

  /** What the Fedimint adapter writes through: the payment before the notes exist, then the notes, then the chat. */
  readonly fedimintPublisher = {
    payment: (id: string) => this.payments.get(id),
    journal: async (review: PaymentReview) => {
      if (!review.linkId) throw new Error("Fedimint ecash goes to a contact in a chat");
      const known = this.payments.get(review.id);
      if (known) return;
      await this.save({ id: review.id, linkId: review.linkId, kind: "payment", direction: "out", amount: review.amount, unit: UNIT, memo: review.memo, state: "pending", createdAt: review.createdAt, requestId: review.requestId, target: review, federation: review.provider });
    },
    publish: async (review: PaymentReview, notes: string, operationId: string) => {
      const known = this.payments.get(review.id);
      if (!known || known.linkId !== review.linkId) throw new Error("The Fedimint payment is not in the journal");
      // Written down first: from here on these notes are the only copy of that money.
      await this.save({ ...known, token: notes, fedimintOp: operationId });
      await this.host.storeMessage({ linkId: review.linkId!, id: `me_${review.createdAt}`, text: `${review.amount.toLocaleString()} ${review.network === "bitcoin" ? "sats" : "test sats"} on Fedimint`, sender: "me", timestamp: review.createdAt, via: "datalink", paymentId: review.id });
      await this.sendFedimint(this.payments.get(review.id)!);
    },
    republish: async (review: PaymentReview) => { const known = this.payments.get(review.id); if (known?.token && known.state === "pending") await this.sendFedimint(known); },
    withdrawn: async (review: PaymentReview, reason: string) => {
      const known = this.payments.get(review.id);
      if (known && known.state === "pending") await this.save({ ...known, state: reason.startsWith("Redeemed") ? "settled" : "reclaimed", token: undefined, error: reason.startsWith("Redeemed") ? undefined : reason });
    },
  };

  private async sendFedimint(payment: StoredPayment): Promise<void> {
    const link = this.host.getLink(payment.linkId);
    if (!link?.supportsFedimintPayments || !payment.token) return;
    await link.sendPayment({ id: payment.id, timestamp: payment.createdAt, requestId: payment.requestId, amount: { value: String(payment.amount), asset: UNIT }, memo: payment.memo, endpoint: [ENDPOINT.fedimint, payment.token] });
  }

  /**
   * Notes from the contact. Redeemed only when they are of a federation we joined and this chat allows Fedimint;
   * otherwise refused unredeemed, and the contact takes them back. Written down (with the notes) before redeeming:
   * an interrupted redeem is finished from the journal, never lost.
   */
  private async receiveFedimint(linkId: string, payment: Payment): Promise<void> {
    const link = this.host.getLink(linkId);
    const known = this.payments.get(payment.id);
    if (known && (known.linkId !== linkId || known.direction !== "in" || known.kind !== "payment")) { link?.sendPaymentResult({ id: payment.id, ok: false, error: "Unknown payment" }); return; }
    if (known) {
      // A retransmission: say again what happened, or finish what an interruption left.
      if (known.state === "pending" && known.token) await this.finishRedeem(known);
      const now = this.current(known);
      if (now.state !== "pending") link?.sendPaymentResult({ id: payment.id, ok: now.state === "settled", credited: now.state === "settled" ? String(now.amount) : undefined, error: now.error });
      return;
    }
    const refuse = async (reason: string) => {
      link?.sendPaymentResult({ id: payment.id, ok: false, error: reason });
      try { await this.host.storeMessage({ linkId, id: `peer_${payment.timestamp}_refused`, text: `Could not receive Fedimint ecash: ${reason}`, sender: "peer", timestamp: payment.timestamp, via: "datalink" }); } catch { /* the refusal already went to the contact */ }
    };
    if (!link?.allowsPayment("fedimint")) { await refuse("Fedimint is off in this chat"); return; }
    if (!this.fedimint) { await refuse("This app has no Fedimint wallet"); return; }
    if (parseSats(payment.amount.value, payment.amount.asset) === null) { await refuse("Unsupported amount"); return; }
    const notes = payment.endpoint[1];
    // The wallet that joined the notes' federation takes them, whichever network it is on.
    let found: Awaited<ReturnType<FedimintWallet["inspectNotes"]>> = null;
    for (const wallet of distinct(this.fedimint)) { found = await wallet.inspectNotes(notes).catch(() => null); if (found) break; }
    if (!found) { await refuse("These notes are from a federation I have not joined"); return; }
    const amount = fedimintSats(found.amountMsats);
    if (amount < 1) { await refuse("These notes are worth less than a sat"); return; }
    const network = this.fedimintOf(found.federation)?.federation(found.federation)?.network;
    await this.save({ id: payment.id, linkId, kind: "payment", direction: "in", amount, unit: UNIT, memo: payment.memo, state: "pending", createdAt: payment.timestamp, requestId: payment.requestId, federation: found.federation, token: notes });
    await this.host.storeMessage({ linkId, id: `peer_${payment.timestamp}`, text: `⚡ ${amount.toLocaleString()} ${network === "bitcoin" ? "sats" : "test sats"} on Fedimint`, sender: "peer", timestamp: payment.timestamp, via: "datalink", paymentId: payment.id });
    await this.finishRedeem(this.payments.get(payment.id)!);
  }

  /** Redeems the notes of an incoming payment (once at a time), settles it, and tells the contact. */
  private finishRedeem(payment: StoredPayment): Promise<void> {
    let running = this.redeeming.get(payment.id);
    if (!running) {
      running = this.redeemOnce(payment.id).finally(() => this.redeeming.delete(payment.id));
      this.redeeming.set(payment.id, running);
    }
    return running;
  }
  private async redeemOnce(id: string): Promise<void> {
    const payment = this.payments.get(id);
    const fedimint = this.fedimintOf(payment?.federation);
    if (!payment?.token || !payment.federation || payment.state !== "pending" || !fedimint) return;
    let state: string | undefined;
    try {
      if (payment.fedimintOp) state = await fedimint.redeemState(payment.federation, payment.fedimintOp, 60_000);
      else {
        const redeemed = await fedimint.redeemNotes(payment.federation, payment.token, payment.id);
        await this.save({ ...this.current(payment), fedimintOp: redeemed.operationId });
        state = redeemed.state;
      }
    } catch (error) {
      // The federation could not be asked: the notes stay in the journal, and the next retransmission (or start) tries again.
      await this.save({ ...this.current(payment), error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const link = this.host.getLink(payment.linkId);
    if (state === "failed") {
      await this.save({ ...this.current(payment), state: "failed", token: undefined, error: "These notes were already redeemed" });
      link?.sendPaymentResult({ id, ok: false, error: "These notes were already redeemed" });
      return;
    }
    if (state !== "done") return;
    await this.save({ ...this.current(payment), state: "settled", token: undefined, error: undefined });
    // It settles our request only in full, in ecash of a federation the request named.
    const request = payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if (request?.kind === "request" && request.direction === "out" && request.linkId === payment.linkId && request.state === "pending" && payment.amount >= request.amount && (request.federations ?? []).includes(payment.federation!)) {
      await this.save({ ...request, state: "settled", federation: payment.federation });
    }
    link?.sendPaymentResult({ id, ok: true, credited: String(payment.amount) });
  }

  /** At start: incoming notes an interruption left unredeemed are redeemed now. */
  async resumeFedimint(): Promise<void> {
    for (const payment of [...this.payments.values()]) {
      if (payment.kind === "payment" && payment.direction === "in" && payment.state === "pending" && payment.token && payment.federation) await this.finishRedeem(payment).catch(() => {});
    }
  }

  /** Our Spark payment went out: said in the chat, and the contact is told (a hint; their wallet is the proof). */
  async recordSpark(review:PaymentReview):Promise<void> {
    if(review.method!=="spark" || !review.linkId || review.state!=="settled")return;
    const known=this.payments.get(review.id);
    if(known?.state==="settled")return;
    if(known && (known.linkId!==review.linkId || known.kind!=="payment" || known.direction!=="out"))return;
    const link=this.requireLink(review.linkId);
    await this.save({id:review.id,linkId:review.linkId,kind:"payment",direction:"out",amount:review.amount,unit:UNIT,state:"settled",createdAt:review.createdAt,requestId:review.requestId,target:review,txid:review.txid});
    if(review.requestId){const request=this.payments.get(review.requestId);if(request?.linkId===review.linkId)await this.save({...request,state:"settled",txid:review.txid});}
    await this.host.storeMessage({linkId:review.linkId,id:`me_${review.createdAt}`,text:`${review.amount} ${arkSats(review.network)} on Spark`,sender:"me",timestamp:review.createdAt,via:"datalink",paymentId:review.id});
    // Replayable; it never causes another spend.
    if(link.supportsSparkPayments)await link.sendPayment({id:review.id,timestamp:review.createdAt,requestId:review.requestId,amount:{value:String(review.amount),asset:UNIT},endpoint:[ENDPOINT.spark,JSON.stringify({id:review.txid})]});
  }
  /** The contact says it paid one of our Spark requests. Recorded as pending until our own wallet shows it. */
  private async receiveSpark(linkId:string,payment:Payment):Promise<void> {
    if(isCheck(payment.endpoint[1])){await this.receiveCheck(linkId,payment);return;}
    const link=this.host.getLink(linkId),request=payment.requestId ? this.payments.get(payment.requestId) : undefined;
    if(!link?.supportsSparkPayments || request?.target?.method!=="spark" || request.linkId!==linkId || request.direction!=="out" || request.kind!=="request")return;
    const existing=this.payments.get(payment.id);
    if(existing && (existing.linkId!==linkId || existing.direction!=="in" || existing.requestId!==request.id))return;
    if(existing || parseSats(payment.amount.value,payment.amount.asset)!==request.amount)return;
    const settled=request.state==="settled";
    await this.save({id:payment.id,linkId,kind:"payment",direction:"in",amount:request.amount,unit:UNIT,state:settled?"settled":"pending",createdAt:payment.timestamp,target:request.target,requestId:request.id,txid:request.txid});
    await this.host.storeMessage({linkId,id:`peer_${payment.timestamp}`,text:`${request.amount} ${arkSats(request.target.network)} on Spark${settled?"":" — checking wallet"}`,sender:"peer",timestamp:payment.timestamp,via:"datalink",paymentId:payment.id});
    await this.reconcileSparkReceipts();
  }
  /**
   * A Spark request is paid when this wallet completed a receive on the invoice made for it, of at least the amount
   * asked. It settles with or without the contact's receipt, and one transfer pays one request.
   */
  async reconcileSparkReceipts():Promise<void> {
    const spark=this.spark;
    if(this.checkingSpark || !spark || !distinct(spark).some(s=>s.ready()))return;
    this.checkingSpark=true;
    try {
      const open=[...this.payments.values()].filter(r=>r.kind==="request" && r.direction==="out" && r.state==="pending" && r.target?.method==="spark");
      const networks=new Set(open.map(r=>walletNetworkOf(r.target!.network)));
      for(const network of networks)if(spark[network].ready())await spark[network].sync().catch(()=>{});
      for(const request of open) {
        const current=this.current(request);
        if(current.state!=="pending" || !current.target)continue;
        const wallet=spark[walletNetworkOf(current.target.network)];
        if(!wallet.ready())continue;
        const claimed=new Set([...this.payments.values()].filter(p=>p.target?.method==="spark" && p.kind==="request" && p.txid).map(p=>p.txid!));
        const id=await wallet.received(current.target,current.amount,current.createdAt,claimed).catch(()=>undefined);
        if(!id)continue;
        await this.settleRequest(current,{txid:id});
        for(const payment of this.payments.values())if(payment.kind==="payment" && payment.direction==="in" && payment.requestId===current.id && payment.state==="pending")await this.save({...payment,state:"settled",txid:id});
      }
    } finally {this.checkingSpark=false;}
  }

  // -- internals -------------------------------------------------------------------

  private async sendEcash(
    link: PaymentLink,
    params: { linkId: string; amount: number; memo?: string; timestamp: number; requestId?: string; mints?: string[]; network?: WalletNetwork },
  ): Promise<string> {
    const id = newId();
    const memo = params.memo?.trim().slice(0, 140) || undefined;
    const record = (token: string, mint: string): StoredPayment => ({
      id,
      linkId: params.linkId,
      kind: "payment",
      direction: "out",
      amount: params.amount,
      unit: UNIT,
      memo,
      state: "pending",
      createdAt: params.timestamp,
      mint,
      token,
      requestId: params.requestId,
      network: mintNetwork(mint),
    });
    let token: string;
    try {
      // Written down in the same transaction that takes the ecash out of the wallet: from here on the
      // token is the only copy of that money.
      const created = await this.wallet.createToken(params.amount, params.mints, memo, record, params.network);
      token = created.token;
      this.payments.set(id, record(created.token, created.mint));
    } catch (error) {
      throw new NoEcashError(error instanceof Error ? error.message : String(error));
    }
    this.host.onChange();
    await this.host.storeMessage({
      linkId: params.linkId,
      id: `me_${params.timestamp}`,
      text: `⚡ ${params.amount.toLocaleString()} sats`,
      sender: "me",
      timestamp: params.timestamp,
      via: "datalink",
      paymentId: id,
    });

    try {
      await link.sendPayment({
        id,
        timestamp: params.timestamp,
        requestId: params.requestId,
        amount: { value: String(params.amount), asset: UNIT },
        memo,
        endpoint: [ENDPOINT.cashu, token],
      });
    } catch (error) {
      await this.reclaim(id).catch(() => {});
      throw error;
    }
    return id;
  }

  /** Re-send the same pending token/id, never make a second spend after a lost receipt. */
  /** A request of ours that was never sent (it waited for live): closed, so no replay sends it. */
  async withdraw(id: string): Promise<void> {
    const payment = this.payments.get(id);
    if (payment?.kind !== "request" || payment.direction !== "out" || payment.state !== "pending") return;
    await this.save({ ...payment, state: "failed" });
  }

  async replay(linkId: string): Promise<void> {
    const link = this.host.getLink(linkId);
    if (!link?.supportsPayments) return;
    // Our open requests to this edge's group reach the member now; one already paid is closed on their side.
    const group = this.host.groupOf?.(linkId);
    if (group) for (const request of this.payments.values()) {
      if (request.group !== group || request.kind !== "request" || request.direction !== "out") continue;
      if (request.state === "pending") await this.sendGroupRequest(linkId, request);
      else if (request.state === "settled") link.sendPaymentResult({ id: request.id, ok: true });
    }
    for (const payment of this.payments.values()) {
      if (payment.linkId !== linkId || payment.direction !== "out" || this.reclaims.has(payment.id)) continue;
      if(payment.target?.method==='usdt') {
        if(!link.supportsUsdtPayments)continue;
        if(payment.kind==='request'&&payment.state==='pending'&&payment.target.expiresAt>Date.now())await link.sendPaymentRequest({id:payment.id,timestamp:payment.createdAt,amount:{value:String(payment.amount),asset:payment.unit},memo:payment.memo,endpoints:[[ENDPOINT.usdt,JSON.stringify(payment.target)]],ask:payment.ask});
        else if(payment.kind==='payment'&&payment.txid&&payment.state!=='failed')await link.sendPayment({id:payment.id,timestamp:payment.createdAt,requestId:payment.requestId,amount:{value:String(payment.amount),asset:payment.unit},endpoint:[ENDPOINT.usdt,JSON.stringify({txid:payment.txid})]});
        continue;
      }
      if (payment.target?.method === "bark") {
        if(!link.supportsBarkPayments)continue;
        if(payment.kind==="request" && payment.state==="pending" && payment.target.expiresAt>Date.now())await link.sendPaymentRequest({id:payment.id,timestamp:payment.createdAt,amount:{value:String(payment.amount),asset:UNIT},memo:payment.memo,endpoints:[[ENDPOINT.bark,JSON.stringify(payment.target)]],ask:payment.ask});
        else if(payment.kind==="payment" && payment.state==="settled")await link.sendPayment({id:payment.id,timestamp:payment.createdAt,requestId:payment.requestId,amount:{value:String(payment.amount),asset:UNIT},endpoint:[ENDPOINT.bark,JSON.stringify({txid:payment.txid})]});
        continue;
      }
      if (payment.target?.method === "fedimint" || payment.federations) {
        if(!link.supportsFedimintPayments)continue;
        if(payment.kind==="payment" && payment.state==="pending" && payment.token)await this.sendFedimint(payment);
        else if(payment.kind==="request" && payment.state==="pending" && payment.federations?.length)await link.sendPaymentRequest({id:payment.id,timestamp:payment.createdAt,amount:{value:String(payment.amount),asset:UNIT},memo:payment.memo,ask:payment.ask,
          endpoints:[[ENDPOINT.fedimint,fedimintRequestPayload(payment.federations)],...(payment.invoice && link.allowsPayment("lightning") ? [[ENDPOINT.bolt11,payment.invoice] as [string,string]] : [])]});
        continue;
      }
      if (payment.target?.method === "spark") {
        if(!link.supportsSparkPayments)continue;
        if(payment.kind==="request" && payment.state==="pending" && payment.target.expiresAt>Date.now())await link.sendPaymentRequest({id:payment.id,timestamp:payment.createdAt,amount:{value:String(payment.amount),asset:UNIT},memo:payment.memo,endpoints:[[ENDPOINT.spark,JSON.stringify(payment.target)]],ask:payment.ask});
        else if(payment.kind==="payment" && payment.state==="settled")await link.sendPayment({id:payment.id,timestamp:payment.createdAt,requestId:payment.requestId,amount:{value:String(payment.amount),asset:UNIT},endpoint:[ENDPOINT.spark,JSON.stringify({id:payment.txid})]});
        continue;
      }
      if (payment.target?.method === "bitcoin") {
        if(!link.supportsBitcoinPayments)continue;
        if(payment.kind==="request" && payment.state==="pending" && payment.target.expiresAt>Date.now())await link.sendPaymentRequest({id:payment.id,timestamp:payment.createdAt,amount:{value:String(payment.amount),asset:UNIT},memo:payment.memo,endpoints:[[ENDPOINT.bitcoin,JSON.stringify(payment.target)]],ask:payment.ask});
        else if(payment.kind==="payment" && payment.txid && payment.state!=="failed")await link.sendPayment({id:payment.id,timestamp:payment.createdAt,requestId:payment.requestId,amount:{value:String(payment.amount),asset:UNIT},endpoint:[ENDPOINT.bitcoin,JSON.stringify({txid:payment.txid})]});
        continue;
      }
      if (payment.target?.method === "arkade") {
        if(!link.supportsArkPayments)continue;
        if(payment.kind==="request" && payment.state==="pending" && payment.target.expiresAt>Date.now())await link.sendPaymentRequest({id:payment.id,timestamp:payment.createdAt,amount:{value:String(payment.amount),asset:UNIT},memo:payment.memo,endpoints:[[ENDPOINT.arkade,JSON.stringify(payment.target)]],ask:payment.ask});
        else if(payment.kind==="payment" && payment.txid && payment.state==="settled")await link.sendPayment({id:payment.id,timestamp:payment.createdAt,requestId:payment.requestId,amount:{value:String(payment.amount),asset:UNIT},endpoint:[ENDPOINT.arkade,JSON.stringify({txid:payment.txid})]});
        continue;
      }
      if(payment.state !== "pending")continue;
      if (payment.kind === "payment" && payment.token) await link.sendPayment({
        id: payment.id, timestamp: payment.createdAt, requestId: payment.requestId,
        amount: { value: String(payment.amount), asset: UNIT }, memo: payment.memo, endpoint: [ENDPOINT.cashu, payment.token],
      });
      else if (payment.kind === "request" && (payment.invoice || payment.mints?.length)) await link.sendPaymentRequest({
        id: payment.id, timestamp: payment.createdAt, amount: { value: String(payment.amount), asset: UNIT }, memo: payment.memo, network: paymentNetwork(payment),
        endpoints: [...(payment.invoice ? [[ENDPOINT.bolt11, payment.invoice] as [string, string]] : []), ...(payment.mints?.length ? [[ENDPOINT.cashu, cashuRequestPayload(payment.mints)] as [string, string]] : [])],
      });
    }
  }

  private requireLink(linkId: string): PaymentLink {
    const link = this.host.getLink(linkId);
    if (!link) throw new Error("You are offline");
    return link;
  }

  /** The latest copy: anything awaited in between may have changed the record. */
  private current(payment: StoredPayment): StoredPayment {
    return this.payments.get(payment.id) ?? payment;
  }

  private async save(payment: StoredPayment): Promise<void> {
    this.payments.set(payment.id, payment);
    await wrap((await store(STORES.payments, "readwrite")).put(payment));
    this.host.onChange();
  }
}
