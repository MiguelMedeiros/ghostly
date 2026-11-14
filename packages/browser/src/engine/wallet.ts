import type {
  GetInfoResponse,
  MeltPreview,
  MeltProofsResponse,
  MeltQuoteBolt11Response,
  NetworkError as CashuNetworkError,
  OutputData,
  Proof,
  ProofLike,
  RequestFn,
  RequestOptions,
  SerializedOutputData,
  SerializedSwapPreview,
  SwapPreview,
  Wallet,
} from "@cashu/cashu-ts";
import { STORES, newestWalletTx, openDb, store, transact, wrap, committed } from "../shared/idb";
import { openRow, openRows, proofKey, RowSeals, sealRow, sealedStore } from "./sealedRows";
import { hasDataKey } from "./dataKey";
import { LIMITS, PaymentPreflightError, decodeBolt11, engineError, engineText, stripHidden, type PaymentReview, type WalletNetwork } from "@ghostly/core";
import { CASHU_REQUEST_TIMEOUT_MS, MELT_REQUEST_TIMEOUT_MS, SWAP_SETTLED_MS, keysetRefused, mintFailed, mintRefused } from "./paymentAdapters/cashu";
import { AskBackoff } from "./askBackoff";
import { INVOICE_PACE, nextInvoiceAsk } from "./invoicePace";
import { BITCOIN_INVOICE_ON_TESTNET, fakesLightning, isTestMint, mintNetwork, mintUrlSpelling, paysItsOwnInvoices } from "../shared/mints";
import type {
  CashuInspection,
  MintInfoView,
  MintView,
  PendingMelt,
  PendingSwap,
  StoredPayment,
  StoredProof,
  StoredQuote,
  WalletTx,
  WalletTxKind,
  WalletView,
} from "../shared/types";

/**
 * The peer's Cashu wallet. Ecash is custodial: the mint holds the sats and the
 * proofs in IndexedDB are the claim on them. The user picks the mints; ecash
 * from any other mint is refused, because accepting a token means trusting
 * whoever issued it.
 *
 * Secrets are random, so there is no seed to restore from yet. `exportTokens`
 * is the backup, and balances are meant to stay pocket-money sized.
 *
 * Every swap is written down before the mint is asked (`PendingSwap`, or the payment intent of a reviewed payment),
 * with its blinded outputs and their secrets: the mint signs those outputs and no others, and its signatures can be
 * asked for again (NUT-09) at any time.
 */
const UNIT = "sat";
/**
 * cdk-mintd 0.17 writes NUT-05's `amountless` beside the method, not under its `options` as 0.18 does, and cashu-ts reads
 * `options` only: such a mint would be taken for one that refuses an invoice with no amount, and never sent the amount.
 */
const saysAmountlessBeside = (method: object): boolean => (method as { amountless?: unknown }).amountless === true;
function amountlessUnderOptions(info: GetInfoResponse): GetInfoResponse {
  const moved = info.nuts[5].methods.map((method) => (saysAmountlessBeside(method) ? { ...method, options: { ...method.options, amountless: true } } : method));
  return { ...info, nuts: { ...info.nuts, 5: { ...info.nuts[5], methods: moved } } };
}
/**
 * An invoice from the mint, with `label` as its description when the mint says it takes one. NUT-04's `description` is
 * optional: cashu-ts refuses to ask a mint that leaves it out for an invoice with one, and the label is only a label.
 */
const mintInvoice = (wallet: Wallet, amount: number, label: string) =>
  wallet.createMintQuoteBolt11(amount, wallet.getMintInfo().supportsNut04Description?.("bolt11", UNIT) === false ? undefined : label);
/** A Lightning payment can stay in flight for minutes or hours; the mint is asked again this often. */
const MELT_POLL_MS = 30_000;
/** Once its request can no longer land, a payment still pending is asked twice as late each time, up to this. */
const MELT_SLOW_POLL_MS = 1_800_000;
const MAX_AMOUNT = 1_000_000;
/** How long "Get test coins" waits for the test mint to mark its invoice paid before saying the coins come later. */
const TEST_COINS_WAIT_MS = 30_000;
const HISTORY_SHOWN = 100;
/** How long before a mint that could not say which restored ecash is spent is asked again. */
const RESTORED_POLL_MS = 60_000;
/** Asked twice as late each time it still cannot say, up to this. */
const RESTORED_SLOW_POLL_MS = 1_800_000;
/** How long before a mint that could not say where a swap stands is asked again. */
const SWAP_POLL_MS = 30_000;
/** The same, for a swap that holds nothing any more or whose mint cannot give signatures back: asked now and then. */
const SWAP_SLOW_POLL_MS = 600_000;
/** How long a swap whose inputs were given back is still asked about, in case the mint made it after all. */
const SWAP_WATCH_MS = 3_600_000;
/** How many proofs of tokens refused as spent are remembered. */
const SPENT_KEPT = 1_000;
/** The most coins `sendCoins` makes for one token. */
const MAX_SEND_COINS = 64;
/** `abandoned`: the mint proved the swap never happened (`reviewedCashuNeverSwapped`); it is never sent again. */
/**
 * `attemptEndedAt`: when the approval's swap failed with no answer. `abandoned`: the mint proved the swap never
 * happened (`reviewedCashuNeverSwapped`); it is never sent again.
 */
export interface CashuPrepared {mint:string;swap:SerializedSwapPreview;token?:string;attemptEndedAt?:number;abandoned?:boolean;
  /** The mint answered that it signed none of the outputs while an input read spent: something else spent that ecash. */
  spentElsewhere?:boolean}

/**
 * Cashu's library (174 KiB) loads with the wallet's first use of a mint or a token, not with the app's start. A mint's
 * redirect is refused on every request, not only on those with a body as the library does: `normalizeMintUrl` alone
 * says where the wallet's requests go.
 */
const loadCashu = () => import("@cashu/cashu-ts").then((cashu) => {
  cashu.setGlobalRequestOptions({ redirect: "error" });
  return cashu;
});

// SDK 4.x preview.fees covers input swap fees, despite its declaration saying
// it includes the recipient fee. includeFees(true) also tops up send outputs.
// Derive everything leaving this wallet beyond the requested amount instead.
async function reviewedCashuFee(preview: SwapPreview): Promise<number> {
  const { Amount } = await loadCashu();
  const inputs = preview.inputs.reduce((sum, proof) => sum + Amount.from(proof.amount).toNumber(), 0);
  const change = (preview.keepOutputs ?? []).reduce((sum, output) => sum + Amount.from(output.blindedMessage.amount).toNumber(), 0);
  const fee = inputs - change - preview.amount.toNumber();
  if (!Number.isSafeInteger(fee) || fee < 0) throw new Error("Invalid Cashu prepared fee");
  return fee;
}

/**
 * The mint was asked for a swap and has not answered. The swap is written down: the wallet asks the mint where it
 * stands until it knows, then stores what it brought or frees what it held. Nothing is known to have failed.
 */
export class SwapUnsettledError extends Error {
  constructor(readonly swap: PendingSwap, readonly cause?: unknown) {
    const host = new URL(swap.mint).host;
    super(swap.kind === "receive"
      ? `${host} has not answered yet. The ecash is added to your wallet as soon as it does.`
      : `${host} has not answered yet. The payment was not made. The sats set aside for it return to your wallet a few minutes after the mint answers.`);
    this.name = "SwapUnsettledError";
  }
}

/**
 * A redeem the mint refused again after its outputs were made anew on its keyset: the wallet's own words for it, as a
 * contact is told when the mint never made a redeem (`PaymentDesk.onSwapSettled`). The token stays unspent.
 */
const MINT_DID_NOT_CONFIRM = "The mint did not confirm the ecash";

/**
 * Where a written-down swap stands at its mint. `never`: the mint signed none of its outputs. `gone`: the inputs it
 * reads spent all the same. `final`: nothing can change that (a refusal, or inputs spent by something else); without
 * it the swap is only overdue, and stays watched after its inputs are given back. `open`: not known yet; `slow`, a
 * mint that cannot give signatures back; `idle`, a mint that answers and has done nothing with it so far; `pending`,
 * inputs the mint reads pending.
 */
type SwapOutcome =
  | { state: "done"; keep: Proof[]; send: Proof[] }
  | { state: "never"; gone: Set<string>; final: boolean }
  | { state: "open"; slow?: boolean; idle?: boolean; pending?: boolean };

/** How many of the times melts and swaps wrote down a wallet keeps on the monotonic clock (`CashuWallet.passed`). */
const WRITTEN_KEPT = 1_000;

const swapOf = (swap: PendingSwap) => swap.swap as SerializedSwapPreview;

export function normalizeMintUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw engineError("invalidMintUrl");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw engineError("mintNotHttps");
  return mintUrlSpelling(url.href);
}

export function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter an amount in sats");
  // Written the English way whatever the browser's own (errorText.ts reads the amount back to say it in the app's language).
  if (amount > MAX_AMOUNT) throw new Error(`Amounts above ${MAX_AMOUNT.toLocaleString("en-US")} sats are not supported`);
}

/** Stored proofs are plain objects (amounts as numbers), which is what the library calls ProofLike. */
const asProofLike = (proofs: StoredProof[]) => proofs as unknown as ProofLike[];

const total = (proofs: { amount: number }[]) => proofs.reduce((sum, p) => sum + p.amount, 0);

const sats = (proofs: Proof[]) => total(proofs.map((p) => ({ amount: p.amount.toNumber() })));

/**
 * Whether `split` can take `amount` out of `proofs`, as it does: coins that add up exactly with the fee their receiver
 * pays to redeem them, or a swap whose inputs also pay the mint's fee for taking them in. Asks nothing of the mint.
 */
/** Whether exact coins go as one token a payment frame carries: a wallet of many small coins can add up in hundreds. */
const inOneFrame = (encode: typeof import("@cashu/cashu-ts").getEncodedToken, mint: string) => (send: Proof[]) =>
  encode({ mint, proofs: send, unit: UNIT }).length <= LIMITS.maxPaymentEndpointChars;

/**
 * The coins a swap makes to send `amount` with the fee their receiver pays to redeem them: the fewest sats whose coins,
 * less that fee, are exactly `amount`. cashu-ts' includeFees adds coins for the fee that can be worth more than it, and
 * the contact is credited more than was sent. Undefined at a mint that charges nothing for coins, or when no such
 * coins are found up to what cashu-ts would make: its own choice is used then.
 */
function sendCoins(wallet: Wallet, amount: number): number[] | undefined {
  const included = wallet.getFeesToInclude(amount).toNumber();
  if (included === 0) return undefined;
  const keyset = wallet.getKeyset();
  const fee = (coins: number) => wallet.getFeesForKeyset(coins, keyset.id).toNumber();
  const sizes = Object.keys(keyset.keys).map(Number).filter((size) => size > 0).sort((a, b) => b - a);
  const coinsOf = (value: number, among = sizes) => {
    const coins: number[] = [];
    for (const size of among) while (value >= size) { coins.push(size); value -= size; }
    return value === 0 ? coins : undefined;
  };
  for (let value = amount; value <= amount + included; value++) {
    let coins = coinsOf(value);
    // Fewer coins than the sats over `amount` pay for: the largest coin split in smaller ones until they do, if ever.
    while (coins && coins.length <= MAX_SEND_COINS && fee(coins.length) < value - amount) {
      const [largest, ...rest] = coins;
      const parts = coinsOf(largest, sizes.filter((size) => size < largest));
      coins = parts && [...parts, ...rest].sort((a, b) => b - a);
    }
    if (coins && coins.length <= MAX_SEND_COINS && fee(coins.length) === value - amount) return coins;
  }
  return undefined;
}

function fitsAt(wallet: Wallet, proofs: StoredProof[], amount: number): boolean {
  return outlayAt(wallet, proofs, amount) !== undefined;
}

/**
 * The sats `split` takes out of the wallet for `amount`, the mint's fees for the coins it takes in included, as `fitsAt`
 * works it out: undefined when it cannot. `inOneFrame`: whether exact coins fit in one token, as `split` asks of them.
 */
function outlayAt(wallet: Wallet, proofs: StoredProof[], amount: number, inOneFrame = (_send: Proof[]) => true): number | undefined {
  try {
    const { send } = wallet.sendOffline(amount, asProofLike(proofs), { includeFees: true, exactMatch: true });
    if (send.length > 0 && sats(send) === amount + wallet.getFeesForProofs(send).toNumber() && inOneFrame(send)) return sats(send);
  } catch {
    // no exact coins: a swap makes them
  }
  try {
    const coins = sendCoins(wallet, amount);
    const outputs = coins ? coins.reduce((sum, coin) => sum + coin, 0) : amount + wallet.getFeesToInclude(amount).toNumber();
    const { send } = wallet.selectProofsToSend(asProofLike(proofs), outputs, true);
    const taken = outputs + wallet.getFeesForProofs(send).toNumber();
    return send.length > 0 && sats(send) >= taken ? taken : undefined;
  } catch {
    return undefined;
  }
}

/** The most `fitsAt` takes out of `proofs` with `extra` on top (a Lightning fee reserve): 0 when nothing fits. */
function roomAt(wallet: Wallet, proofs: StoredProof[], extra = 0): number {
  // Every coin as it is, less what the mint charges to take them all in: nothing sends more.
  const most = total(proofs) - wallet.getFeesForProofs(asProofLike(proofs)).toNumber() - extra;
  if (most <= 0 || fitsAt(wallet, proofs, most + extra)) return Math.max(0, most);
  let low = 0;
  let high = most - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsAt(wallet, proofs, middle + extra)) low = middle;
    else high = middle - 1;
  }
  return low;
}

const MINT_QUOTE_MISMATCH = "The mint quoted another amount than this invoice's. Nothing was paid.";
/** A melt quote that is not for this invoice (`invoice` lower case, as `decodeBolt11` gives it) and its amount. */
const quoteMismatch = (quote: MeltQuoteBolt11Response, invoice: string, amount: number) =>
  quote.request.trim().toLowerCase().replace(/^lightning:/, "") !== invoice || quote.amount.toNumber() !== amount;

const toStored = (mint: string, p: Proof, reserved?: boolean): StoredProof => ({
  mint,
  id: p.id,
  amount: p.amount.toNumber(),
  secret: p.secret,
  C: p.C,
  dleq: p.dleq,
  ...(reserved ? { reserved } : {}),
});

/** The note of the ecash "Get test coins" brought (the engine plays its own sound for it). */
export const TEST_COINS_NOTE = "Test coins from the test mint";
const swapId = () => `swap-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const walletTx = (mint: string, kind: WalletTxKind, amount: number, fee: number, note?: string): WalletTx => ({
  id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  timestamp: Date.now(),
  mint,
  kind,
  amount,
  fee: Math.max(0, fee),
  note: note?.slice(0, 140),
});

/** Where a Lightning payment stands, once the mint has been asked. */
type MeltOutcome = "paid" | "pending" | "unpaid";

/** What a failed payment left in the wallet, said to the person: all of it, or all but the fee the mint kept. */
const backInWallet = (lost: number) => lost > 0
  ? `The sats are back in your wallet, less ${lost} sat${lost === 1 ? "" : "s"} the mint kept as its fee.`
  : "The sats are back in your wallet.";

/** A mint's own words for a refusal, as one short line: the reason at the end of `lightningRefused`. */
const mintReason = (error: unknown) =>
  stripHidden((error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ")).replace(/\s+/g, " ").trim().slice(0, 160) || "no reason given";

/** Every proof and swap stored, as `CashuWallet.readStored` read them. */
export interface StoredCashu { proofs: StoredProof[]; swaps: PendingSwap[] }

export interface WalletEvents {
  onChange(): void;
  /** Ecash arrived from the public test mint, which this wallet did not have yet. */
  onTestMintNeeded(mint: string): Promise<void>;
  /** An invoice of ours was paid and its ecash is in the wallet. */
  onQuotePaid(quote: StoredQuote): void;
  /** A Lightning payment the mint had left pending settled, one way or the other. */
  onMeltResolved(melt: PendingMelt, paid: boolean): void;
  /**
   * A swap the mint had not answered is settled, after the call that made it was over: `done`, what it brought is in
   * the wallet with its records; otherwise the mint never made it, and what it held is free again.
   */
  onSwapSettled?(swap: PendingSwap, done: boolean): void | Promise<void>;
  /**
   * Whether the chat request an invoice of ours belongs to (`StoredQuote.paymentId`) was closed: withdrawn, closed, or
   * paid some other way. Its invoice is then asked about only once more, after it expired (`nextInvoiceAsk`).
   */
  requestClosed?(paymentId: string): boolean;
}

/**
 * How long a mint gets to answer when it is only being asked something (its keys, an invoice). A mint
 * that is down can hold a request for minutes; the next mint should get its turn well before that.
 */
export const MINT_TIMEOUT_MS = 12_000;

function within<T>(ms: number, work: Promise<T>, mint: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${new URL(mint).host} did not answer`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A swap's request, and those that ask a mint where a swap stands (NUT-09 restore, NUT-07 states). */
const SWAP_REQUESTS = ["/v1/swap", "/v1/restore", "/v1/checkstate"];

/**
 * Each of `SWAP_REQUESTS` ends within `CASHU_REQUEST_TIMEOUT_MS`, retries included. cashu-ts' `requestTimeout` is per
 * try, and NUT-19 tries a cached endpoint again after a timeout, each try with a timeout of its own, for as long as the
 * mint's `ttl` (endless when it gives none): one deadline for the whole request ends them all, and a caller's abort is
 * never retried. Past it the request failed with no answer (`NetworkError`), as a try that timed out does. Every other
 * request, melts among them, keeps cashu-ts' defaults. cashu-ts takes no options per call of a swap: its mint client's
 * request function is wrapped.
 */
function boundSwapRequests(wallet: Wallet, NetworkError: typeof CashuNetworkError): void {
  const client = wallet.mint as unknown as { _request: RequestFn };
  const request = client._request;
  client._request = async <T,>(options: RequestOptions): Promise<T> => {
    const url = new URL(options.endpoint);
    if (!SWAP_REQUESTS.some((path) => url.pathname.endsWith(path))) return request<T>(options);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), CASHU_REQUEST_TIMEOUT_MS);
    options.signal?.addEventListener("abort", () => deadline.abort(), { once: true });
    try {
      return await request<T>({ ...options, requestTimeout: CASHU_REQUEST_TIMEOUT_MS, signal: deadline.signal });
    } catch (error) {
      if (deadline.signal.aborted && !options.signal?.aborted) throw new NetworkError(`${url.host} did not answer within ${CASHU_REQUEST_TIMEOUT_MS / 1_000} s`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * How long a mint that could not be loaded stays so for the payment poll's reads, then twice as long after each failed
 * load up to `MINT_FAILED_CAP_MS`: the payments of one round at a gone mint share its failure, instead of each loading
 * it again (three requests each), and so do payments made at different times, whose own backoffs are out of step.
 */
export const MINT_FAILED_MS = 5_000;
export const MINT_FAILED_CAP_MS = 600_000;

export class CashuWallet {
  private readonly wallets = new Map<string, Promise<Wallet>>();
  /** The mints whose load in `wallets` failed: the payment poll's reads try them again at `mintAsk`'s pace. */
  private readonly failedLoads = new Set<string>();
  private readonly mintAsk = new AskBackoff(MINT_FAILED_MS, MINT_FAILED_CAP_MS);
  private readonly names = new Map<string, string>();
  private readonly infos = new Map<string, MintInfoView>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private quoteTimer: ReturnType<typeof setTimeout> | null = null;
  /** When `quoteTimer` fires: a round that would fire later leaves it as it is. */
  private quoteTimerAt = 0;
  /** Per open quote: when its mint was last asked about it, in this run (`nextInvoiceAsk`). */
  private readonly quoteAsked = new Map<string, number>();
  /** Per quote the screen shows: until when (`watch`). */
  private readonly quoteWatched = new Map<string, number>();
  /** Per open quote whose mint did not answer, or answered with an error: as `meltAsk`, on top of its own pace. */
  private readonly quoteAsk = new AskBackoff(INVOICE_PACE.missedMs, INVOICE_PACE.missedCapMs);
  private meltTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per pending melt: when it is asked about next and the wait before that, in this run (a restart asks at once). */
  private readonly meltAsk = new AskBackoff(MELT_POLL_MS, MELT_SLOW_POLL_MS);
  private restoredTimer: ReturnType<typeof setTimeout> | null = null;
  private swapTimer: ReturnType<typeof setTimeout> | null = null;
  private swapTimerAt = 0;
  /** Per open swap whose mint did not answer past its overdue time: as `meltAsk`, in this run (a restart asks at once). */
  private readonly swapAsk = new AskBackoff(SWAP_POLL_MS, SWAP_SLOW_POLL_MS);
  /** Per mint that could not say which restored ecash is spent, or holds some pending: as `meltAsk`. */
  private readonly restoredAsk = new AskBackoff(RESTORED_POLL_MS, RESTORED_SLOW_POLL_MS);
  /** Per melt quote that ended unpaid: the sats the mint kept all the same (the fee of the split before the melt). */
  private readonly failedFees = new Map<string, number>();
  /** Melt quotes that ended unpaid with proofs the mint read spent: ecash spent somewhere else, said as such. */
  private readonly spentAway = new Set<string>();
  /**
   * Proofs of tokens the mint read spent by something else (`mint secret`), the newest SPENT_KEPT: spent stays spent,
   * so the same token sent again, under any id or encoding, is refused without asking the mint again.
   */
  private readonly spentTokens = new Set<string>();
  /** Per melt quote shown to the person: the invoice, its amount and the most it was said to cost in fees
   * (the mint's reserve and the coins' own fees). Only these are paid, for no more. */
  private readonly shownQuotes = new Map<string, { request: string; amount: number; feeReserve: number }>();
  /**
   * Per time a melt or swap wrote down (`createdAt`, `attemptEndedAt`): where it stands on the monotonic clock. Whether a
   * request of it can still reach the mint is measured from there (`passed`): read by the wall clock, a clock stepped an
   * hour forward booked a melt whose answer was lost unpaid within seconds, its sats back, and then the mint paid it.
   */
  private readonly writtenAt = new Map<number, number>();

  /**
   * `getMints`: the mints of one network (the engine's default when none is named), primary first: balances,
   * invoices, payments of that network's Cashu wallet. `getKnownMints`: every mint the user added, whatever its
   * network: ecash from any of them is taken in, and counts in its own network's wallet.
   */
  constructor(
    private readonly getMints: (network?: WalletNetwork) => string[],
    private readonly events: WalletEvents,
    private readonly getKnownMints: () => string[] = getMints,
  ) {}

  /** Stopped with the engine: no poll runs or is scheduled again (WISP 06: the check after a handoff's stop is final). */
  private stopped = false;

  start(): void {
    this.stopped = false;
    void this.pollQuotes();
    void this.pollMelts();
    void this.checkRestored();
    void this.pollSwaps();
    // Names, fees and limits for the UI; a mint that is down simply stays without them.
    for (const mint of this.getKnownMints()) void this.checkMint(mint).then(() => this.events.onChange(), () => {});
  }

  /**
   * Stops every poll and timer, and waits for what runs inside a per-mint lock to end: a swap there must end, not be cut.
   * Nothing is written by this wallet after it resolves.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.quoteTimer, this.meltTimer, this.restoredTimer, this.swapTimer]) if (timer) clearTimeout(timer);
    this.quoteTimer = this.meltTimer = this.restoredTimer = this.swapTimer = null;
    // Bounded: a mint that never answers does not hold a closing app forever (the handoff's check after the stop then
    // sees a swap still going through and refuses).
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.locks.values()].map((lock) => lock.catch(() => {}))), new Promise((resolve) => { timer = setTimeout(resolve, CashuWallet.STOP_WAIT_MS); })]);
    clearTimeout(timer);
  }
  /** How long `stop` waits for a swap in a per-mint lock. */
  static STOP_WAIT_MS = 30_000;

  /** The wall-clock time a melt or swap writes down, its place on the monotonic clock kept for `passed`. */
  private stamp(): number {
    const now = Date.now();
    this.keepWritten(now, performance.now());
    return now;
  }

  private keepWritten(at: number, monotonic: number): void {
    this.writtenAt.set(at, monotonic);
    if (this.writtenAt.size > WRITTEN_KEPT) this.writtenAt.delete(this.writtenAt.keys().next().value!);
  }

  /**
   * How long really passed since `at`, a time a melt or swap wrote down, while this wallet ran. One written by an earlier
   * run counts by the wall clock up to the first time this run asks, never below nothing: written by a clock ahead of
   * this one, its window starts again rather than waiting for the clock to get there.
   */
  private passed(at: number): number {
    let since = this.writtenAt.get(at);
    if (since === undefined) this.keepWritten(at, since = performance.now() - Math.max(0, Date.now() - at));
    return performance.now() - since;
  }

  /** Whether no request of this melt can reach the mint any more: its one request is sent right after it is written down. */
  private meltOverdue(melt: PendingMelt): boolean {
    return this.passed(melt.createdAt) >= MELT_REQUEST_TIMEOUT_MS + SWAP_SETTLED_MS;
  }

  /** Whether no request of this swap can reach the mint any more: a request's longest life, and a margin after its last try. */
  private swapOverdue(swap: PendingSwap): boolean {
    return swap.attemptEndedAt !== undefined && this.passed(swap.createdAt) >= CASHU_REQUEST_TIMEOUT_MS + SWAP_SETTLED_MS
      && this.passed(swap.attemptEndedAt) >= SWAP_SETTLED_MS;
  }

  /** Whether a swap is past the hour it is watched for (`SWAP_WATCH_MS`). */
  private pastWatch(swap: PendingSwap): boolean {
    return this.passed(swap.createdAt) >= SWAP_WATCH_MS;
  }

  /**
   * The Cashu wallet of one network: its mints, their balance, and the network's newest movements (every network's when
   * none is named) with the fees they paid. Only those movements are read, however long the history is. `read` is the
   * proofs and swaps as `readStored` read them, shared by the views of several networks.
   */
  async view(network?: WalletNetwork, read?: StoredCashu): Promise<WalletView> {
    const { proofs, swaps: allSwaps } = read ?? await this.readStored();
    const mints: MintView[] = this.getMints(network).map((url) => ({
      url,
      name: this.names.get(url) ?? new URL(url).hostname,
      balance: total(proofs.filter((p) => p.mint === url && !p.reserved)),
      info: this.infos.get(url) ?? null,
    }));
    const history = await newestWalletTx<WalletTx>((mint) => !network || mintNetwork(mint) === network, HISTORY_SHOWN);
    const here = new Set(mints.map((m) => m.url));
    const swaps = allSwaps.filter((s) => here.has(s.mint) && !s.released && !s.finished);
    // What a swap is about: the proofs it spends, or what a redeem would bring.
    const about = (s: PendingSwap) => s.kind === "send" ? swapOf(s).inputs.reduce((sum, p) => sum + Number(p.amount), 0) : s.tx?.amount ?? 0;
    // Inputs that read spent at a mint that cannot say what it gave for them are not "set aside": they may not return.
    const spentAway = new Set(swaps.filter((s) => s.stuck && s.kind === "send").flatMap((s) => swapOf(s).inputs.map((p) => p.secret)));
    return {
      mints,
      balance: total(mints.map((m) => ({ amount: m.balance }))),
      // Held for a payment or a swap the mint has not settled: not spendable now, and not gone.
      setAside: total(proofs.filter((p) => here.has(p.mint) && p.reserved && !spentAway.has(p.secret))),
      openSwaps: swaps.length,
      swapsAmount: total(swaps.map((s) => ({ amount: about(s) }))),
      unconfirmed: total(swaps.filter((s) => s.stuck).map((s) => ({ amount: about(s) }))),
      history,
      feesPaid: history.reduce((sum, tx) => sum + tx.fee, 0),
    };
  }

  /** Every proof and swap stored, read once for the views of every network: each read is the whole store. */
  async readStored(): Promise<StoredCashu> {
    const proofs = await this.allProofs();
    return { proofs, swaps: await this.readSwaps() };
  }

  /**
   * Ecash a profile restore brought back (`unchecked`) is a copy from when the backup was made. What was spent since
   * (by the profile it was copied from, or by this one before it was restored) still counted in the balance, for good,
   * and every payment that picked one of those proofs failed with the mint's "Token already spent". Each mint is asked
   * once which of them it still reads unspent: a spent proof is dropped, an unspent one is checked for good, and one
   * the mint holds pending, or a mint that cannot be asked, is asked again later: after RESTORED_POLL_MS, then twice
   * as late each time up to RESTORED_SLOW_POLL_MS (`restoredAsk`). `paced`: only the mints whose time came (the timer);
   * a start or a restore asks every one now.
   */
  private async checkRestored(paced = false): Promise<void> {
    if (this.restoredTimer) clearTimeout(this.restoredTimer);
    this.restoredTimer = null;
    if (this.stopped) return;
    const waiting = (p: StoredProof) => !!p.unchecked && !p.reserved;
    let changed = false, next = Infinity;
    const mints = new Set((await this.allProofs()).filter(waiting).map((p) => p.mint));
    this.restoredAsk.keepOnly(mints);
    for (const mint of mints) {
      if (paced && !this.restoredAsk.due(mint, Date.now())) { next = Math.min(next, this.restoredAsk.at(mint, Date.now())); continue; }
      let again = false;
      try {
        await this.locked(mint, async () => {
          const proofs = (await this.allProofs()).filter((p) => p.mint === mint && waiting(p));
          if (!proofs.length) return;
          const states = await (await this.wallet(mint)).checkProofsStates(proofs);
          if (states.length !== proofs.length) throw new Error("The mint answered for another number of proofs");
          await this.sealedTransact([STORES.proofs], { [STORES.proofs]: proofs }, (stores) => {
            proofs.forEach((proof, i) => {
              const state = states[i]?.state;
              if (state === "SPENT") stores[STORES.proofs].delete(proof.secret);
              else if (state === "UNSPENT") { const { unchecked: _checked, ...kept } = proof; stores[STORES.proofs].put(kept satisfies StoredProof); }
              else again = true;
            });
          });
          changed = true;
        });
      } catch {
        again = true;
      }
      if (again) next = Math.min(next, Date.now() + this.restoredAsk.missed(mint, Date.now()));
      else this.restoredAsk.forget(mint);
    }
    if (changed) this.events.onChange();
    if (next < Infinity && !this.stopped) this.restoredTimer = setTimeout(() => void this.checkRestored(true), Math.max(0, next - Date.now()));
  }

  /** Talks to the mint before it is added: a typo should not become a place to keep money. */
  async checkMint(url: string): Promise<{ url: string; name: string }> {
    const normalized = normalizeMintUrl(url);
    let wallet: Wallet;
    try { wallet = await this.wallet(normalized); }
    catch (error) {
      // "Failed to fetch" says nothing to a person: say which place did not answer, and what it should be.
      throw Object.assign(engineError("mintUnreachable", { host: new URL(normalized).host }), { cause: error });
    }
    const info = wallet.getMintInfo();
    const name = info.name || new URL(normalized).hostname;
    this.names.set(normalized, name);

    const bounds = (nut: 4 | 5) => {
      const method = info.isSupported(nut).params.find((m) => m.method === "bolt11" && m.unit === UNIT);
      const toNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return method ? { min: toNumber(method.min_amount), max: toNumber(method.max_amount) } : null;
    };
    const active = wallet.keyChain.getKeysets().filter((k) => k.isActive);
    this.infos.set(normalized, {
      version: info.version || undefined,
      motd: info.motd?.trim().slice(0, 200) || undefined,
      inputFeePpk: active.length > 0 ? Math.min(...active.map((k) => k.fee)) : 0,
      receive: bounds(4),
      send: bounds(5),
    });
    return { url: normalized, name };
  }

  /** What `view(network).balance` says, from the proofs alone: no swaps, no history. */
  async balance(network?: WalletNetwork): Promise<number> {
    const here = new Set(this.getMints(network));
    return total((await this.allProofs()).filter((p) => here.has(p.mint) && !p.reserved));
  }

  async balanceAt(mint: string): Promise<number> {
    return total((await this.allProofs()).filter((p) => p.mint === mint && !p.reserved));
  }

  // -- Lightning in ----------------------------------------------------------

  async receiveLightning(amount: number, paymentId?: string, network?: WalletNetwork): Promise<StoredQuote> {
    assertAmount(amount);
    // The primary mint comes first; if it is down the next one takes the invoice.
    let created: { mint: string; response: Awaited<ReturnType<Wallet["createMintQuoteBolt11"]>> } | null = null;
    let lastError: unknown = new Error("No mint configured");
    for (const candidate of this.getMints(network)) {
      try {
        created = { mint: candidate, response: await within(MINT_TIMEOUT_MS, mintInvoice(await this.wallet(candidate), amount, "Ghostly"), candidate) };
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!created) throw new Error(`No mint could create an invoice: ${lastError instanceof Error ? lastError.message : lastError}`);
    const { mint, response } = created;
    const quote: StoredQuote = {
      quote: response.quote,
      mint,
      amount,
      invoice: response.request,
      createdAt: Date.now(),
      expiresAt: response.expiry ? response.expiry * 1000 : null,
      paymentId,
      // A test mint says "paid" to every invoice: that is not someone paying this one.
      ...(paysItsOwnInvoices(mint) ? { held: true } : {}),
    };
    await this.putQuote(quote);
    // Nobody paid it yet: it is first asked about after the fast pace's gap.
    this.quoteAsked.set(quote.quote, Date.now());
    void this.pollQuotes();
    return quote;
  }

  /**
   * The screen shows this invoice of ours (Receive): it is asked about at the fast pace for `INVOICE_PACE.watchMs`, and
   * now if it was not just asked. The screen says it again while it shows it. Returns whether it is one of ours here.
   */
  async watch(invoice: string): Promise<boolean> {
    const wanted = invoice.trim().toLowerCase();
    const quote = (await this.quotes()).find((q) => q.invoice.toLowerCase() === wanted);
    if (!quote) return false;
    this.quoteWatched.set(quote.quote, Date.now() + INVOICE_PACE.watchMs);
    // Its mint may be back: the screen asks whatever wait its silence earned.
    this.quoteAsk.forget(quote.quote);
    await this.pollQuotes();
    return true;
  }

  /**
   * A payer says it paid this invoice of ours (a contact's app, once its payment went through). A held quote (a test
   * mint's, which reads paid by itself) is minted from now on; on any other mint the mint's own answer decides, as
   * always. Returns whether the invoice is one of ours. `said` false: the payer spoke of another invoice, so this one is
   * only asked about, and a held one stays held. Only this invoice is asked about now: the others keep their pace.
   */
  async vouch(invoice: string, said = true): Promise<boolean> {
    const wanted = invoice.trim().toLowerCase();
    let quote = (await this.quotes()).find((q) => q.invoice.toLowerCase() === wanted);
    if (!quote) return false;
    if (quote.held && said) {
      quote = { ...quote, held: undefined } satisfies StoredQuote;
      await this.putQuote(quote);
    }
    // The payment may take a moment to settle at the mint: the invoice is asked about at the fast pace meanwhile.
    this.quoteWatched.set(quote.quote, Date.now() + INVOICE_PACE.watchMs);
    if (!(await this.settleQuotes([quote])).length && !quote.held && !quote.issuedUnclaimed) this.scheduleQuotes(this.nextAsk(quote, Date.now()));
    return true;
  }

  /** True while an invoice of ours waits for a payer's word (see `vouch`): whatever its mint says, it is not paid. */
  async isHeld(quote: string): Promise<boolean> {
    return !!(await wrap<StoredQuote | undefined>((await store(STORES.quotes, "readonly")).get(quote)))?.held;
  }

  /**
   * "Get test coins": a test mint pays its own invoices, so an invoice asked of it on purpose is its faucet. Only a
   * mint that does (`paysItsOwnInvoices`), never real money. Waits a little for the mint to say paid, then mints;
   * a mint slower than that has its quote minted by the regular poll.
   */
  async testCoins(amount: number, network: WalletNetwork = "testnet"): Promise<{ mint: string; amount: number }> {
    assertAmount(amount);
    const mint = this.getMints(network).find(paysItsOwnInvoices);
    if (!mint) throw new Error("This wallet has no test mint to ask for test coins");
    let response: Awaited<ReturnType<typeof mintInvoice>>;
    try {
      response = await within(MINT_TIMEOUT_MS, mintInvoice(await this.wallet(mint), amount, "Ghostly test coins"), mint);
    } catch (error) {
      // A test mint that failed ("internal error", a closed connection) is named, with what to do; its words kept last.
      throw mintFailed(error) ? Object.assign(engineError("mintFailedFaucet", { host: new URL(mint).host, reason: mintReason(error) }), { cause: error }) : error;
    }
    const quote: StoredQuote = {
      quote: response.quote,
      mint,
      amount,
      invoice: response.request,
      createdAt: Date.now(),
      expiresAt: response.expiry ? response.expiry * 1000 : null,
      testCoins: true,
    };
    await this.putQuote(quote);
    const deadline = Date.now() + TEST_COINS_WAIT_MS;
    for (;;) {
      const minted = await this.locked(mint, () => this.settleQuote(quote.quote));
      if (minted) {
        this.events.onChange();
        return { mint, amount };
      }
      if (Date.now() > deadline) {
        void this.pollQuotes();
        throw new Error(`${new URL(mint).host} has not paid its test coins yet: they show up here once it does`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /**
   * Asks the mints about the open invoices now, without waiting for the next round. `mints`: only the invoices at
   * these mints (one network's wallet, before it is removed), claiming what is paid; the regular round is left alone.
   */
  async checkQuotes(mints?: readonly string[]): Promise<void> {
    if (!mints) return this.pollQuotes(true);
    const at = new Set(mints);
    await this.settleQuotes((await this.quotes()).filter((q) => at.has(q.mint)));
  }

  /** Every invoice of ours the mints have not settled yet, held, paid-unclaimed and issued-unclaimed ones included. */
  async quotes(): Promise<StoredQuote[]> {
    return openRows(STORES.quotes, await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll()));
  }

  /** Sealed before its transaction opens, when the profile is encrypted: a paid quote's outputs can be minted from. */
  private async putQuote(quote: StoredQuote): Promise<void> {
    const row = await sealRow(STORES.quotes, quote);
    await committed((await store(STORES.quotes, "readwrite")).put(row));
  }

  /**
   * Invoices are paid by someone else, somewhere else; all we can do is ask the mint. A quote is the only
   * claim on the sats paid to it, so it is dropped only once the mint says it is unpaid and it has expired.
   * Each quote is asked about at its own pace (`nextInvoiceAsk`): often while it is new or on screen, then less.
   * `now`: every open quote is asked about, whatever its pace (someone says it was paid). The store is read once.
   */
  private async pollQuotes(now = false): Promise<void> {
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    this.quoteTimer = null;
    if (this.stopped) return;
    const quotes = await this.quotes();
    const gone = new Set<string>();

    // A held quote is not asked about: its mint's "paid" means nothing. It only goes once it has expired.
    for (const held of quotes.filter((q) => q.held && q.expiresAt && q.expiresAt + INVOICE_PACE.expiryGraceMs < Date.now())) {
      await committed((await store(STORES.quotes, "readwrite")).delete(held.quote));
      gone.add(held.quote);
    }
    // What this run knows of quotes that are no longer stored goes with them.
    const stored = new Set(quotes.map((q) => q.quote));
    for (const pace of [this.quoteAsked, this.quoteWatched]) for (const id of pace.keys()) if (!stored.has(id)) pace.delete(id);
    this.quoteAsk.keepOnly(stored);

    const open = quotes.filter((q) => !q.issuedUnclaimed && !q.held);
    const at = Date.now();
    for (const settled of await this.settleQuotes(open.filter((q) => now || this.nextAsk(q, at) <= at + INVOICE_PACE.dueSlackMs))) gone.add(settled);

    const next = open.filter((q) => !gone.has(q.quote)).map((q) => this.nextAsk(q, Date.now()));
    if (next.length) this.scheduleQuotes(Math.min(...next));
  }

  /** When the mint is next asked about this quote: at its pace, and not before the wait its mint's silence earned. */
  private nextAsk(quote: StoredQuote, now: number): number {
    return Math.max(this.quoteAsk.at(quote.quote, 0), nextInvoiceAsk({
      createdAt: quote.createdAt,
      expiresAt: quote.expiresAt,
      watchedUntil: this.quoteWatched.get(quote.quote),
      closed: !!quote.paymentId && !!this.events.requestClosed?.(quote.paymentId),
      paid: !!quote.paid,
    }, this.quoteAsked.get(quote.quote), now));
  }

  /** The next round at `at`, unless one is due sooner. */
  private scheduleQuotes(at: number): void {
    if (this.stopped) return;
    if (this.quoteTimer && this.quoteTimerAt <= at) return;
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    this.quoteTimerAt = at;
    this.quoteTimer = setTimeout(() => { this.quoteTimer = null; void this.pollQuotes(); }, Math.max(0, at - Date.now()));
  }

  /**
   * Asks the mints about these quotes. Returns the ones minted. A quote whose mint does not answer, or answers with an
   * error, waits longer each time (`quoteAsk`); a mint that could not be loaded is not loaded again in this call for its
   * other quotes, which wait as that one does. The load runs outside the mint's lock, so a failed one does not hold it.
   */
  private async settleQuotes(quotes: readonly StoredQuote[]): Promise<string[]> {
    const minted: string[] = [];
    const down = new Set<string>();
    for (const { quote, mint } of quotes.filter((q) => !q.issuedUnclaimed && !q.held)) {
      this.quoteAsked.set(quote, Date.now());
      // Its mint could not be loaded for another quote just now: this one waits as that one does.
      if (down.has(mint)) { this.quoteAsk.missed(quote, Date.now()); continue; }
      try {
        try { await this.wallet(mint); }
        catch (error) { down.add(mint); throw error; }
        const paid = await this.locked(mint, () => this.settleQuote(quote));
        this.quoteAsk.forget(quote);
        if (paid) {
          minted.push(quote);
          // Test coins are no invoice anyone else knows of.
          if (!paid.testCoins) this.events.onQuotePaid(paid);
          this.events.onChange();
        }
      } catch {
        // The mint did not answer, or answered with an error: asked again later, and later each time.
        this.quoteAsk.missed(quote, Date.now());
      }
    }
    return minted;
  }

  /** Runs under the mint's lock, so two rounds never mint one quote twice. Returns the quote once its ecash is in. */
  private async settleQuote(id: string): Promise<StoredQuote | null> {
    // Another round may have settled it while this one waited for the lock.
    const quote = await openRow(STORES.quotes, await wrap<StoredQuote | undefined>((await store(STORES.quotes, "readonly")).get(id)));
    if (!quote || quote.issuedUnclaimed || quote.held) return null;
    const wallet = await this.wallet(quote.mint);
    const { OutputData } = await loadCashu();
    const answer = await wallet.checkMintQuoteBolt11(quote.quote);
    const { state } = answer;

    if (state === "UNPAID") {
      if (quote.expiresAt && quote.expiresAt + 60_000 < Date.now()) {
        await committed((await store(STORES.quotes, "readwrite")).delete(quote.quote));
      }
      return null;
    }
    const saved = (quote.outputs as SerializedOutputData[] | undefined)?.map((o) => OutputData.deserialize(o));
    if (state === "ISSUED") {
      // Issued for outputs that were written down here: the mint still has its signatures for them (NUT-09).
      // A mint that cannot be asked, or answers with an error, is asked again next round: the quote stays as it is.
      const issued = saved?.length ? await this.signedOutputs(wallet, saved) : undefined;
      if (Array.isArray(issued)) return this.storeMinted(quote, issued);
      // The ecash is stored in the same transaction that drops the quote, so a quote still here was never
      // credited to this wallet. It is the only trace of those sats: keep it, stop asking.
      console.warn(`[wallet] ${quote.mint} issued quote ${quote.quote} (${quote.amount} sats) but this wallet holds no ecash for it`);
      await this.putQuote({ ...quote, issuedUnclaimed: true } satisfies StoredQuote);
      return null;
    }

    // Paid: money arrived, and until it is minted this quote is the only claim on it. Written down, so a wallet
    // about to be removed can say so (walletRemoval) while the mint is slow to hand the ecash over.
    // The outputs the mint is asked to sign are written down with it, and asked for again as they are: whichever
    // request the mint acts on, what it issues is for these, and can be asked for again.
    const preview = await wallet.prepareMint("bolt11", quote.amount, { ...answer, quote: quote.quote });
    // These quotes are not locked to a key (NUT-20), so no signature over the outputs has to be made again.
    if (saved) preview.outputData = saved;
    const written: StoredQuote = { ...quote, paid: true, outputs: saved ? quote.outputs : preview.outputData.map((o) => OutputData.serialize(o as OutputData)) };
    if (!quote.paid || !saved) await this.putQuote(written);
    let proofs: Proof[];
    try {
      proofs = await wallet.completeMint(preview);
    } catch (error) {
      // Outputs the mint refuses while the quote is still only paid (on a keyset it retired since) would be refused
      // every round: the next one makes new ones. Nothing was issued for these.
      if (mintRefused(error) &&(await wallet.checkMintQuoteBolt11(quote.quote).catch(() => null))?.state === "PAID") {
        const { outputs: _refused, ...fresh } = written;
        await this.putQuote(fresh satisfies StoredQuote);
      }
      throw error;
    }
    return this.storeMinted(quote, proofs);
  }

  /** The ecash of a paid invoice goes in with its history line, in the transaction that drops the quote. */
  private async storeMinted(quote: StoredQuote, proofs: Proof[]): Promise<StoredQuote> {
    const minted = sats(proofs);
    const tx: WalletTx = { ...walletTx(quote.mint, "lightning-in", minted, quote.amount - minted, quote.paymentId ? "Request paid over Lightning" : quote.testCoins ? TEST_COINS_NOTE : undefined), quote: quote.quote };
    await this.sealedTransact([STORES.proofs, STORES.walletTx, STORES.quotes], { [STORES.proofs]: proofs }, (stores) => {
      // From a restored copy, the profile it came from may have minted this invoice and spent its ecash since.
      for (const p of proofs) stores[STORES.proofs].put({ ...toStored(quote.mint, p), ...(quote.restored ? { unchecked: true } : {}) } satisfies StoredProof);
      stores[STORES.walletTx].put(tx);
      stores[STORES.quotes].delete(quote.quote);
    });
    if (quote.restored) void this.checkRestored();
    return quote;
  }

  /** Where one of our invoices stands at its mint. Only a question: ecash is minted by the poll above. */
  async mintQuoteState(mint: string, quote: string): Promise<string> {
    return String((await (await this.wallet(mint)).checkMintQuoteBolt11(quote)).state);
  }

  /** Where one of our Lightning payments stands at its mint. Only a question: `pollMelts` books the answer. */
  async meltQuoteState(mint: string, quote: string): Promise<string> {
    return String((await (await this.wallet(mint)).checkMeltQuoteBolt11(quote)).state);
  }

  // -- ecash out and in --------------------------------------------------------

  /**
   * Takes `amount` out of the wallet as a token, from the first of `preferred`
   * (or of the user's mints) that holds enough. The receiver's redeem fee is
   * included, so they are credited the full amount.
   *
   * `outbox` turns the token into the record that keeps it (a chat payment). It is written in the same
   * transaction that takes the inputs out of the wallet, so the ecash never lives only in memory.
   */
  async createToken(
    amount: number,
    preferred?: string[],
    note?: string,
    outbox?: (token: string, mint: string) => StoredPayment,
    network?: WalletNetwork,
  ): Promise<{ token: string; mint: string }> {
    assertAmount(amount);
    // A send without mints comes from this network's mints. A request names its mints, but a contact may name a
    // real mint on a Testnet request: only mints of the network asked for are ever spent from.
    const mine = preferred ? this.getKnownMints() : this.getMints(network);
    const candidates = (preferred ? preferred.map(mintUrlSpelling).filter((m) => mine.includes(m)) : mine)
      .filter((m) => !network || mintNetwork(m) === network);
    /** The most a mint that holds the amount could send with its fees on top. */
    let room = 0;
    /** The coins held at `mint` when they send the amount. */
    const fitting = async (mint: string): Promise<StoredProof[] | undefined> => {
      const proofs = await this.proofsAt(mint);
      if (total(proofs) < amount) return undefined;
      // At a mint that charges for each coin it takes in, the amount held may not cover its fees: the next mint may.
      const wallet = await this.wallet(mint);
      if (fitsAt(wallet, proofs, amount)) return proofs;
      room = Math.max(room, roomAt(wallet, proofs));
      return undefined;
    };
    for (const mint of candidates) {
      if (!(await fitting(mint))) continue;
      const sent = await this.locked(mint, async () => {
        // Asked again in the mint's turn: another payment may have taken these coins since.
        const proofs = await fitting(mint);
        if (!proofs) return undefined;
        const { inputs, keep, send, swap } = await this.split(mint, amount, proofs);
        const token = (await loadCashu()).getEncodedToken({ mint, proofs: send, unit: UNIT });
        // Everything that left the balance beyond the amount: the swap's fee and the redeem fee prepaid for the receiver.
        const spent = total(inputs) - sats(keep);
        const tx = walletTx(mint, "ecash-out", amount, spent - amount, note);
        const kept = outbox?.(token, mint);
        await this.sealedTransact([STORES.proofs, STORES.walletTx, STORES.swaps, ...(kept ? [STORES.payments] : [])], { [STORES.proofs]: keep, [STORES.payments]: kept ? [kept] : [] }, (stores) => {
          this.queueReplace(stores[STORES.proofs], mint, inputs, keep);
          stores[STORES.walletTx].put(tx);
          if (swap) stores[STORES.swaps].delete(swap.id);
          if (kept) stores[STORES.payments].put(kept);
        });
        this.events.onChange();
        return { token, mint };
      });
      if (sent) return sent;
    }
    if (room > 0) throw engineError("notEnoughForFee", { amount: room });
    // The sats are there, only set aside by a split the mint has not answered: said as the first attempt said it.
    const held = await this.heldBySilentSplit(candidates, amount);
    if (held) throw new SwapUnsettledError(held);
    throw engineError(candidates.length === 0 && preferred ? "noSharedMint" : "notEnoughSats");
  }

  /** An open send swap at one of `mints` whose reserved inputs, with the coins free there, would cover `amount`. */
  private async heldBySilentSplit(mints: string[], amount: number): Promise<PendingSwap | undefined> {
    for (const mint of mints) {
      const open = (await this.swapsAt(mint)).filter((s) => s.kind === "send" && !s.released && !s.finished);
      if (open.length === 0) continue;
      const held = await Promise.all(open.map((s) => this.storedInputs(s)));
      const swap = open.find((_, i) => held[i].length > 0);
      if (swap && total(await this.proofsAt(mint)) + total(held.flat()) >= amount) return swap;
    }
    return undefined;
  }

  async prepareReviewedCashu(mint:string,amount:number):Promise<{fee:number;prepared:CashuPrepared}> {
    assertAmount(amount);
    if(!this.getKnownMints().includes(mint))throw new Error("Select a configured mint");
    return this.locked(mint,async()=>{
      const wallet=await this.wallet(mint);
      const proofs=await this.proofsAt(mint);
      const prepare=(sats:number)=>wallet.ops.send(sats,asProofLike(proofs)).includeFees(true).prepare();
      const preview=await prepare(amount).catch(async(error:unknown)=>{
        // Coins that cannot cover the amount and its fees are refused in cashu-ts' own English words: said as a send
        // says it instead, with how much fits. Its coins are not split's, so `roomAt` would claim more than fits here.
        if(!/^Not enough funds available/.test(error instanceof Error?error.message:""))throw error;
        const fits=(sats:number)=>prepare(sats).then(()=>true,()=>false);
        // Below the amount asked, and at most what every coin brings in past its fee (all of it, at a mint that charges none).
        let low=0,high=Math.min(amount-1,total(proofs)-wallet.getFeesForProofs(asProofLike(proofs)).toNumber());
        while(low<high){
          const middle=Math.ceil((low+high)/2);
          if(await fits(middle))low=middle;
          else high=middle-1;
        }
        throw low>0?engineError("notEnoughForFee",{amount:low}):engineError("notEnoughSats");
      });
      return {fee:await reviewedCashuFee(preview),prepared:{mint,swap:(await loadCashu()).serializeSwapPreview(preview)}};
    });
  }

  /** Reserve before the mint call. A timeout keeps these inputs reserved for read-only recovery. */
  async executeReviewedCashu(review:PaymentReview,prepared:CashuPrepared):Promise<string> {
    return this.locked(prepared.mint,async()=>{
      const preview=(await loadCashu()).deserializeSwapPreview(prepared.swap);
      // Refused before the mint is asked: nothing was sent, and the review fails for good (the request can be paid again).
      if(prepared.mint!==review.provider || preview.amount.toNumber()!==review.amount || await reviewedCashuFee(preview)!==review.fee)throw new PaymentPreflightError("Cashu preview does not match review");
      const seals=new RowSeals(),tx=(await openDb()).transaction(STORES.proofs,"readwrite");
      await new Promise<void>((resolve,reject)=>{
        const proofs=sealedStore(tx.objectStore(STORES.proofs),seals);
        for(const input of preview.inputs){
          const request=proofs.get(input.secret);
          request.onsuccess=()=>{
            const proof:StoredProof|undefined=request.result;
            if(!proof || proof.reserved || proof.mint!==prepared.mint || proof.C!==input.C || proof.amount!==input.amount.toNumber()){tx.abort();return;}
            proofs.put({...proof,reserved:true});
          };
        }
        tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(new PaymentPreflightError(engineText("reviewedSatsGone")));
      });
      // The inputs leave the balance for "set aside" now: a mint that never answers would leave the view made before.
      this.events.onChange();
      const wallet=await this.wallet(prepared.mint);
      const {keep,send}=await wallet.completeSwap(preview);
      return this.finishReviewedCashu(review,prepared,keep,send);
    });
  }

  /** NUT-09 retrieves signatures for the exact saved outputs; it never creates another swap. */
  async recoverReviewedCashu(review:PaymentReview,prepared:CashuPrepared):Promise<string|undefined> {
    const stored=await openRow(STORES.payments,await wrap<StoredPayment|undefined>((await store(STORES.payments,"readonly")).get(review.id)));
    if(stored?.token)return stored.token;
    const wallet=await this.wallet(prepared.mint,true);
    const {OutputData}=await loadCashu();
    const keep=(prepared.swap.keepOutputs??[]).map(OutputData.deserialize);
    const send=(prepared.swap.sendOutputs??[]).map(OutputData.deserialize);
    const outputs=[...keep,...send];
    const restored=await this.restoreOutputs(wallet,outputs);
    if(!Array.isArray(restored))return undefined;
    return this.finishReviewedCashu(review,prepared,restored.slice(0,keep.length),restored.slice(keep.length));
  }

  /**
   * What the mint says of outputs that were written down before it was asked to sign them: the proofs they stand for
   * when it signed them all, `none` when it answered that it signed none, and undefined when it has no way of saying
   * (it does not restore, NUT-09, by its own info). Only an answer counts: a mint that cannot be reached, answers with
   * an error or answers for some of the outputs throws, and is asked again later.
   */
  private async signedOutputs(wallet: Wallet, outputs: OutputData[]): Promise<Proof[] | "none" | undefined> {
    if (!wallet.getMintInfo().isSupported(9).supported) return undefined;
    const restored = await this.restoreOutputs(wallet, outputs);
    if (restored === "some") throw new Error("The mint answered for some of the outputs");
    return restored;
  }

  /**
   * The mint's signatures for these exact outputs (NUT-09), as the proofs they stand for: all of them, `none`, or
   * `some` (an answer that does not cover every output). It only reads what the mint already signed: nothing is
   * swapped again.
   */
  private async restoreOutputs(wallet:Wallet,outputs:OutputData[]):Promise<Proof[]|"none"|"some"> {
    const recovered=await wallet.mint.restore({outputs:outputs.map(o=>o.blindedMessage)});
    if(recovered.outputs.length===0 && recovered.signatures.length===0)return "none";
    if(recovered.outputs.length!==outputs.length || recovered.signatures.length!==outputs.length)return "some";
    const keys=(await wallet.mint.getKeys()).keysets;
    const {Amount}=await loadCashu();
    const restored:Proof[]=[];
    for(const output of outputs){
      const index=recovered.outputs.findIndex(o=>o.B_===output.blindedMessage.B_);
      const signature=recovered.signatures[index];
      const key=signature && keys.find(k=>k.id===signature.id);
      if(!signature || !key || signature.id!==output.blindedMessage.id || Amount.from(signature.amount).toString()!==Amount.from(output.blindedMessage.amount).toString())throw new Error("Mint restore does not match reviewed outputs");
      restored.push(output.toProof(signature,key));
    }
    return restored;
  }

  private async finishReviewedCashu(review:PaymentReview,prepared:CashuPrepared,keep:Proof[],send:Proof[]):Promise<string> {
    const {getEncodedToken,deserializeSwapPreview}=await loadCashu();
    const token=getEncodedToken({mint:prepared.mint,proofs:send,unit:UNIT});
    const preview=deserializeSwapPreview(prepared.swap);
    const record:StoredPayment={id:review.id,linkId:review.linkId!,kind:"payment",direction:"out",amount:review.amount,unit:UNIT,memo:review.memo,state:"pending",createdAt:review.createdAt,mint:prepared.mint,token,requestId:review.requestId,target:review};
    await this.sealedTransact([STORES.proofs,STORES.payments,STORES.walletTx], {[STORES.proofs]:keep,[STORES.payments]:[record]}, stores=>{
      this.queueReplace(stores[STORES.proofs],prepared.mint,preview.inputs.map(p=>toStored(prepared.mint,p)),keep);
      stores[STORES.payments].put(record);
      stores[STORES.walletTx].put({...walletTx(prepared.mint,"ecash-out",review.amount,review.fee),id:review.id});
    });
    prepared.token=token;this.events.onChange();return token;
  }

  /**
   * Proof from the mint that a reviewed swap never happened: every input it would spend reads UNSPENT (not PENDING,
   * not SPENT), and the mint signed none of its outputs. Read-only: it asks, and never sends the swap.
   */
  async reviewedCashuNeverSwapped(prepared:CashuPrepared):Promise<boolean> {
    const {OutputData,deserializeSwapPreview}=await loadCashu();
    const preview=deserializeSwapPreview(prepared.swap);
    if(!preview.inputs.length)return false;
    const wallet=await this.wallet(prepared.mint,true);
    const states=await wallet.checkProofsStates(preview.inputs.map(p=>({secret:p.secret,id:p.id})));
    if(states.length!==preview.inputs.length || !states.every(s=>s.state==="UNSPENT"))return false;
    const outputs=[...(prepared.swap.keepOutputs??[]),...(prepared.swap.sendOutputs??[])].map(OutputData.deserialize);
    const restored=await wallet.mint.restore({outputs:outputs.map(o=>o.blindedMessage)});
    return restored.signatures.length===0 && restored.outputs.length===0;
  }

  /**
   * Whether a reviewed swap can never happen because its ecash was spent by something else: the mint answers that it
   * signed none of its outputs (a successful NUT-09 answer, asked before and after), and reads an input spent, none
   * pending. Read-only. A mint that does not restore cannot say, and the answer is no.
   */
  async reviewedCashuSpentElsewhere(prepared:CashuPrepared):Promise<boolean> {
    const {OutputData,deserializeSwapPreview}=await loadCashu();
    const preview=deserializeSwapPreview(prepared.swap);
    if(!preview.inputs.length)return false;
    const wallet=await this.wallet(prepared.mint,true);
    const outputs=[...(prepared.swap.keepOutputs??[]),...(prepared.swap.sendOutputs??[])].map(OutputData.deserialize);
    if(await this.signedOutputs(wallet,outputs)!=="none")return false;
    const states=await wallet.checkProofsStates(preview.inputs.map(p=>({secret:p.secret,id:p.id})));
    if(states.length!==preview.inputs.length || states.some(s=>s.state==="PENDING") || !states.some(s=>s.state==="SPENT"))return false;
    return await this.signedOutputs(wallet,outputs)==="none";
  }

  /**
   * Ends a reviewed swap whose ecash was spent elsewhere: the inputs the mint reads spent leave the wallet, the others
   * are free again, and the rest of the wallet's ecash at that mint is checked the same way. Idempotent.
   */
  async dropReviewedCashu(prepared:CashuPrepared):Promise<void> {
    const preview=(await loadCashu()).deserializeSwapPreview(prepared.swap);
    await this.locked(prepared.mint,async()=>{
      const states=await (await this.wallet(prepared.mint)).checkProofsStates(preview.inputs.map(p=>({secret:p.secret,id:p.id})));
      if(states.length!==preview.inputs.length)throw new Error("The mint answered for another number of proofs");
      const spent=new Set(preview.inputs.filter((_,i)=>states[i]?.state==="SPENT").map(p=>p.secret));
      await this.sealedTransact([STORES.proofs], {}, stores=>{
        const proofs=stores[STORES.proofs];
        for(const input of preview.inputs){
          const request=proofs.get(input.secret);
          request.onsuccess=()=>{
            const proof:StoredProof|undefined=request.result;
            if(!proof || !proof.reserved || proof.mint!==prepared.mint || proof.C!==input.C)return;
            if(spent.has(input.secret)){proofs.delete(input.secret);return;}
            const {reserved:_released,...free}=proof;
            proofs.put(free);
          };
        }
      });
    });
    await this.recheck(prepared.mint);
    this.events.onChange();
  }

  /**
   * A proof of this wallet read spent when nothing here spent it: its ecash is in use somewhere else too. Every other
   * free proof at that mint is asked about once (`checkRestored`), so the balance becomes what the mint still holds
   * instead of one payment after another finding out.
   */
  private async recheck(mint:string):Promise<void> {
    const free=(await this.allProofs()).filter(p=>p.mint===mint && !p.reserved && !p.unchecked);
    if(free.length>0)await this.sealedTransact([STORES.proofs], {[STORES.proofs]:free}, stores=>{ for(const p of free)stores[STORES.proofs].put({...p,unchecked:true} satisfies StoredProof); });
    await this.checkRestored();
  }

  /** Gives back the inputs a reviewed swap reserved, once the mint proved it never happened. Idempotent. */
  async releaseReviewedCashu(prepared:CashuPrepared):Promise<void> {
    const preview=(await loadCashu()).deserializeSwapPreview(prepared.swap);
    await this.locked(prepared.mint,async()=>{
      await this.sealedTransact([STORES.proofs], {}, stores=>{
        const proofs=stores[STORES.proofs];
        for(const input of preview.inputs){
          const request=proofs.get(input.secret);
          request.onsuccess=()=>{
            const proof:StoredProof|undefined=request.result;
            if(!proof || !proof.reserved || proof.mint!==prepared.mint || proof.C!==input.C)return;
            const {reserved:_released,...free}=proof;
            proofs.put(free);
          };
        }
      });
    });
    this.events.onChange();
  }

  /**
   * Whether the ecash of a reviewed payment came back to this wallet (Take it back, or a refusal). Its proofs then read
   * SPENT at the mint because this wallet redeemed them, not the contact.
   */
  async reviewedCashuTakenBack(id:string):Promise<boolean> {
    return (await wrap<StoredPayment|undefined>((await store(STORES.payments,"readonly")).get(id)))?.state==="reclaimed";
  }

  /**
   * Whether a Take it back of this payment of ours is still written down: its redeem reached the mint, whose answer was
   * lost (`SwapUnsettledError`), and `pollSwaps` settles it. Its ecash reads SPENT meanwhile, by this wallet.
   */
  async cashuTakingBack(id:string):Promise<boolean> {
    return (await this.readSwaps()).some((s)=>s.kind==="receive" && !s.released && s.payment?.id===id && s.payment.direction==="out");
  }

  async reviewedCashuSpent(prepared:CashuPrepared):Promise<boolean> {
    const outputs=(prepared.swap.sendOutputs??[]).map((await loadCashu()).OutputData.deserialize);
    const states=await (await this.wallet(prepared.mint,true)).checkProofsStates(outputs.map(o=>({secret:new TextDecoder().decode(o.secret),id:o.blindedMessage.id})));
    return states.length>0 && states.length===outputs.length && states.every(s=>s.state==="SPENT");
  }

  /** Reads a token or a payment request without contacting a mint. Nothing here moves money. */
  async inspect(text: string): Promise<CashuInspection | null> {
    const value = text.trim();
    if (!/^(cashu|creq)[AB]/i.test(value)) return null;
    const { decodePaymentRequest, getTokenMetadata } = await loadCashu();
    try {
      if (/^cashu[AB]/i.test(value)) {
        const metadata = getTokenMetadata(value);
        const mint = mintUrlSpelling(metadata.mint);
        return {
          kind: "token",
          amount: metadata.amount.toNumber(),
          unit: metadata.unit,
          mint,
          memo: metadata.memo || undefined,
          // Only sat ecash is redeemed here, whatever mint it is from.
          accepted: metadata.unit === UNIT && (this.getKnownMints().includes(mint) || isTestMint(mint)),
        };
      }
      if (/^creq[AB]/i.test(value)) {
        const request = decodePaymentRequest(value);
        return {
          kind: "request",
          amount: request.amount === undefined ? null : request.amount.toNumber(),
          unit: request.unit ?? UNIT,
          mints: (request.mints ?? []).map(mintUrlSpelling),
          description: request.description || undefined,
        };
      }
    } catch {
      // not ecash after all
    }
    return null;
  }

  /**
   * Redeems a token into fresh proofs of our own. Until this succeeds the sender could still spend it.
   * Test-mint ecash the user pastes adds the test mint; ecash a contact sends in a payment never adds a mint.
   */
  async receiveToken(
    token: string,
    kind: WalletTxKind = "ecash-in",
    note?: string,
    { addTestMint = true, payment }: { addTestMint?: boolean; payment?: (amount: number, mint: string) => StoredPayment } = {},
  ): Promise<{ amount: number; mint: string; fee: number }> {
    let mint: string;
    let faceValue: number;
    let unit: string;
    const { getTokenMetadata, serializeSwapPreview } = await loadCashu();
    try {
      const metadata = getTokenMetadata(token);
      unit = metadata.unit;
      // In this wallet's spelling of its mints. The library redeems the token at the same mint in any spelling.
      mint = mintUrlSpelling(metadata.mint);
      faceValue = metadata.amount.toNumber();
    } catch {
      throw new Error("That is not a valid ecash token");
    }
    // A token of another unit is still a token: said as such.
    if (unit !== UNIT) throw engineError("ecashOtherUnit", { unit });
    // A mint is a custodian and only the user picks those. The test mint holds nothing of value.
    if (addTestMint && !this.getKnownMints().includes(mint) && isTestMint(mint)) await this.events.onTestMintNeeded(mint);
    if (!this.getKnownMints().includes(mint)) throw new Error(`Ecash from ${new URL(mint).hostname} is not accepted`);

    return this.locked(mint, async () => {
      // A sender that prepaid the redeem fee put it on top of the amount; what the mint kept is the fee either way.
      const records = (credited: number) => ({ tx: walletTx(mint, kind, credited, Math.max(0, faceValue - credited), note), ...(payment ? { payment: payment(credited, mint) } : {}) });
      // A redeem of this very token that is still written down is finished as it was made: never a second swap for it.
      const written = (await this.swapsAt(mint)).filter((s) => s.kind === "receive");
      let swap = written.find((s) => s.token === token);
      // Written down for another payment (another id, another chat) or for none: that payment's, never finished for this one.
      const own = payment?.(0, mint);
      const sameRecord = (a?: StoredPayment, b?: StoredPayment) => a?.id === b?.id && a?.linkId === b?.linkId && a?.direction === b?.direction;
      if (swap && !sameRecord(swap.payment, own)) throw engineError("ecashBeingReceived");
      // Already in the wallet, with only its chat still to be told: nothing to redeem again.
      if (swap?.finished) return { amount: swap.tx?.amount ?? 0, mint, fee: swap.tx?.fee ?? 0 };
      if (!swap) {
        const preview = await (await this.wallet(mint)).prepareSwapToReceive(token);
        if (preview.inputs.some((p) => this.spentTokens.has(`${mint} ${p.secret}`))) throw engineError("ecashAlreadySpent");
        // The same coins in another token (another memo): one coin is one redeem, never another swap counted again.
        const redeeming = new Set(written.flatMap((s) => (swapOf(s).inputs ?? []).map((p) => p.secret)));
        if (preview.inputs.some((p) => redeeming.has(p.secret))) throw engineError("ecashBeingReceived");
        // A mint whose fee to take the token in is all of it would spend the coin and give nothing back: refused before the
        // mint is asked, so the token stays unspent and its sender can still take it back.
        if (preview.amount.toNumber() <= 0) throw engineError("ecashFeeTakesAll", { amount: String(faceValue) });
        // The outputs are for what is left after the mint's fee, so the records are known before the mint is asked.
        swap = { id: swapId(), mint, kind: "receive", swap: serializeSwapPreview(preview), createdAt: this.stamp(), token, ...records(preview.amount.toNumber()) };
        await this.putSwap(swap);
      } else if (payment && !this.swapAsk.due(swap.id, Date.now())) {
        // A contact's payment sent already, and the mint did not take it: asked again at the wallet's own pace
        // (`pollSwaps`), not each time its payer sends the same token again.
        throw new SwapUnsettledError(swap);
      }
      const sent = swap;
      const { keep } = await this.completeSwap(sent).catch((error: unknown) => {
        if (error instanceof SwapUnsettledError) this.swapAsk.missed(sent.id, Date.now());
        throw error;
      });
      const credited = sats(keep);
      // What the mint signed is what is credited.
      if (swap.tx && credited !== swap.tx.amount) swap = { ...swap, ...records(credited), tx: { ...records(credited).tx, id: swap.tx.id, timestamp: swap.tx.timestamp } };
      await this.finishSwap(swap, keep, [], false);
      this.events.onChange();
      // `fee`: what the mint kept of the token's face value for taking it in.
      return { amount: credited, mint, fee: Math.max(0, faceValue - credited) };
    });
  }

  // -- swaps: written down, then finished ------------------------------------------

  /**
   * Splits `amount`, with the fee its receiver will pay to redeem it, out of `proofs`. Coins that add up exactly need
   * no mint, as long as their token fits in a payment frame: a wallet of many small coins can add up exactly in
   * hundreds of them, a token the contact's app drops unread. Otherwise it is a swap, which sends a few coins: written
   * down, with its inputs reserved, before the mint is asked. The caller stores the result in one transaction: `inputs`
   * out, `keep` in, `send` where it goes, and `swap` deleted. Runs under the mint's lock.
   */
  private async split(mint: string, amount: number, proofs: StoredProof[]): Promise<{ inputs: StoredProof[]; keep: Proof[]; send: Proof[]; swap?: PendingSwap }> {
    const wallet = await this.wallet(mint);
    const { getEncodedToken, serializeSwapPreview } = await loadCashu();
    const among =(chosen: { secret: string }[]) => { const secrets = new Set(chosen.map((p) => p.secret)); return proofs.filter((p) => secrets.has(p.secret)); };
    try {
      const { send } = wallet.sendOffline(amount, asProofLike(proofs), { includeFees: true, exactMatch: true });
      if (send.length > 0 && sats(send) === amount + wallet.getFeesForProofs(send).toNumber() && inOneFrame(getEncodedToken, mint)(send)) return { inputs: among(send), keep: [], send };
    } catch {
      // no exact coins: the mint makes them
    }
    const coins = sendCoins(wallet, amount);
    const preview = coins
      ? await wallet.prepareSwapToSend(coins.reduce((sum, coin) => sum + coin, 0), asProofLike(proofs), {}, { send: { type: "random", denominations: coins } })
      : await wallet.prepareSwapToSend(amount, asProofLike(proofs), { includeFees: true });
    const swap: PendingSwap = { id: swapId(), mint, kind: "send", swap: serializeSwapPreview(preview), createdAt: this.stamp() };
    const inputs = among(preview.inputs);
    // Written down before the mint sees the proofs: from here on they may be spent, and only these outputs replace them.
    await this.sealedTransact([STORES.proofs, STORES.swaps], { [STORES.proofs]: inputs, [STORES.swaps]: [swap] }, (stores) => {
      for (const p of inputs) stores[STORES.proofs].put({ ...p, reserved: true } satisfies StoredProof);
      stores[STORES.swaps].put(swap);
    });
    const { keep, send } = await this.completeSwap(swap);
    return { inputs, keep, send, swap };
  }

  /**
   * Sends a written-down swap to the mint: always the saved one, so a second try asks for the same outputs. When the
   * answer is missed the mint is asked what it did, and its word decides: the outputs it signed are the result, as the
   * answer would have been; a swap it says it never made is undone and the failure is thrown; and for as long as the
   * swap stays written down nothing is known to have failed, whatever the mint's words were (`SwapUnsettledError`):
   * `pollSwaps` settles it. A redeem refused for the keyset of its outputs is made again on the mint's keyset now and
   * sent once more (`renewedReceive`); `renew` false: it already was. Runs under the mint's lock.
   */
  private async completeSwap(swap: PendingSwap, renew = true): Promise<{ keep: Proof[]; send: Proof[] }> {
    const { deserializeSwapPreview } = await loadCashu();
    try {
      // The saved preview carries only the swap's own outputs: what comes back is exactly what the mint signed.
      return await (await this.wallet(swap.mint)).completeSwap(deserializeSwapPreview(swapOf(swap)));
    } catch (error) {
      const renewed = renew ? await this.renewedReceive(swap, error).catch(() => undefined) : undefined;
      if (renewed) return this.completeSwap(renewed, false);
      // A refusal of the first request ever made for this swap: no other request of it can be on its way.
      const refused = mintRefused(error) && swap.attemptEndedAt === undefined;
      const ended: PendingSwap = { ...swap, attemptEndedAt: this.stamp() };
      await this.putSwap(ended).catch(() => {});
      const outcome = await this.swapOutcome(ended, refused).catch((): SwapOutcome => ({ state: "open" }));
      if (outcome.state === "done") return outcome;
      if (outcome.state === "never" && outcome.final) {
        await this.dropSwap(ended, outcome.gone);
        if (swap.kind === "receive") this.rememberSpent(swap.mint, outcome.gone);
        // Said as what it is: the mint's own words for it vary from mint to mint, and cashu-ts' for a keyset are its own.
        if (outcome.gone.size > 0) throw Object.assign(engineError("ecashAlreadySpent"), { cause: error });
        throw swap.kind === "receive" && keysetRefused(error) ? Object.assign(new Error(MINT_DID_NOT_CONFIRM), { cause: error }) : error;
      }
      this.swapsAgainIn(SWAP_POLL_MS);
      // What it holds and that it is open show at once.
      this.events.onChange();
      throw new SwapUnsettledError(ended, error);
    }
  }

  /**
   * A redeem the mint refused for the keyset of its outputs (one it retired, or does not know, since they were made):
   * no request with those outputs is ever signed. While the mint reads every coin of its token unspent, nothing of it
   * happened, and it is written down again with new outputs on the keyset the mint signs with now (cashu-ts reloaded
   * the mint's keysets with the refusal), as `settleQuote` does for an invoice. Undefined when it is not that case.
   * Only asks: the caller sends it. Runs under the mint's lock.
   */
  private async renewedReceive(swap: PendingSwap, error: unknown): Promise<PendingSwap | undefined> {
    if (swap.kind !== "receive" || swap.released || !keysetRefused(error)) return undefined;
    // The keysets could not be reloaded with the refusal: loaded anew, so the new outputs are on the mint's keyset now.
    if ((error as { repaired?: boolean }).repaired === false) this.wallets.delete(swap.mint);
    const wallet = await this.wallet(swap.mint);
    const { deserializeSwapPreview, serializeSwapPreview } = await loadCashu();
    const { inputs } = deserializeSwapPreview(swapOf(swap));
    const states = await wallet.checkProofsStates(inputs.map((p) => ({ secret: p.secret, id: p.id })));
    if (states.length !== inputs.length || states.some((s) => s.state !== "UNSPENT")) return undefined;
    // The same coins, so the same fee: what was written down to credit stays right.
    const preview = await wallet.prepareSwapToReceive(swap.token ?? inputs);
    const { attemptEndedAt: _ended, askAt: _ask, stuck: _stuck, ...rest } = swap;
    // Written down before the mint is asked, in place of the outputs it refused: the only request of these is the next.
    const renewed: PendingSwap = { ...rest, swap: serializeSwapPreview(preview) };
    await this.putSwap(renewed);
    return renewed;
  }

  /**
   * Sends a redeem `renewedReceive` wrote down again, after the call that made it was over (`pollSwaps`): stored and its
   * chat told as any redeem settled late; let go by `completeSwap` on the mint's word (spent, refused once more), and
   * its chat told that; still written down with no answer, asked about again.
   */
  private async sendRenewed(swap: PendingSwap, later: (ms: number) => void): Promise<void> {
    try {
      const { keep } = await this.completeSwap(swap, false);
      if (await this.finishSwap(swap, keep, [], true)) {
        const told = await this.tellSwap(swap, true);
        if (swap.payment && told) await committed((await store(STORES.swaps, "readwrite")).delete(swap.id));
        else if (swap.payment) later(SWAP_POLL_MS);
        this.events.onChange();
      }
    } catch {
      if ((await this.swapsAt(swap.mint)).some((s) => s.id === swap.id)) { later(SWAP_POLL_MS); return; }
      await this.tellSwap(swap, false);
      this.events.onChange();
    }
  }

  /**
   * Asks the mint where a written-down swap stands. It only asks: nothing is sent again, nothing is stored.
   * `refused`: the mint refused the only request ever made for this swap, so no request of it is still on its way.
   * Throws when the mint cannot be asked, or answers with an error: only its answers count.
   */
  private async swapOutcome(swap: PendingSwap, refused = false): Promise<SwapOutcome> {
    const wallet = await this.wallet(swap.mint);
    const { OutputData } = await loadCashu();
    const saved = swapOf(swap);
    const keep =(saved.keepOutputs ?? []).map(OutputData.deserialize);
    const send = (saved.sendOutputs ?? []).map(OutputData.deserialize);
    const signed = async () => {
      const proofs = await this.signedOutputs(wallet, [...keep, ...send]);
      return Array.isArray(proofs) ? { state: "done" as const, keep: proofs.slice(0, keep.length), send: proofs.slice(keep.length) } : proofs;
    };
    const first = await signed();
    if (first && first !== "none") return first;
    const states = await wallet.checkProofsStates(saved.inputs.map((p) => ({ secret: p.secret, id: p.id })));
    if (states.length !== saved.inputs.length) throw new Error("The mint answered for another number of proofs");
    if (states.some((s) => s.state === "PENDING")) {
      // A redeem's inputs are its sender's, held by a payment of theirs: refused, this redeem can never reach the mint.
      if (swap.kind === "receive" && refused) return { state: "never", gone: new Set(), final: true };
      return { state: "open", pending: true };
    }
    const gone = new Set(saved.inputs.filter((_, i) => states[i]?.state === "SPENT").map((p) => p.secret));
    if (gone.size > 0) {
      // Asked once more: the swap may have gone through between the two questions.
      const second = await signed();
      if (second && second !== "none") return second;
      // The mint answered that it signed none of these outputs: something else spent the inputs.
      if (second === "none" || refused) return { state: "never", gone, final: true };
      // Spent, and the mint cannot say by what: this swap may have done it. It stays written down.
      return { state: "open", slow: true };
    }
    // Unspent and unsigned: it never happened. For good after a refusal; otherwise once no request can still arrive.
    if (refused) return { state: "never", gone, final: true };
    if (this.swapOverdue(swap)) return { state: "never", gone, final: false };
    return { state: "open", idle: !!first };
  }

  /**
   * Stores what a swap brought, in one transaction that reads the swap first: a swap still written down was never
   * stored, and one stored is never stored again, whoever else works on this database. A redeem brings its ecash with
   * its history line and its payment record. A split finished here was not finished by its caller (the payment it was
   * for is over): everything it made is the wallet's. `late`: after the call that made it was over; a swap with a
   * payment then stays, marked `finished`, until the chat has been told (`tellSwap`). Returns whether it stored.
   */
  private async finishSwap(swap: PendingSwap, keep: Proof[], send: Proof[], late: boolean): Promise<boolean> {
    // A redeem's inputs were never the wallet's: only a split looks its own up.
    const inputs = (await this.proofsOf(swap.kind === "send" ? swapOf(swap).inputs.map((p) => p.secret) : [])).filter((p) => p.mint === swap.mint);
    const lost = swap.kind === "send" ? swapOf(swap).inputs.reduce((sum, p) => sum + Number(p.amount), 0) - sats(keep) - sats(send) : 0;
    let stored = false;
    await this.sealedTransact([STORES.proofs, STORES.swaps, STORES.walletTx, ...(swap.payment ? [STORES.payments] : [])], { [STORES.proofs]: [...keep, ...send], [STORES.payments]: swap.payment ? [swap.payment] : [] }, (stores) => {
      const current = stores[STORES.swaps].get(swap.id);
      current.onsuccess = () => {
        const kept: PendingSwap | undefined = current.result;
        if (!kept || kept.finished) return;
        stored = true;
        for (const p of inputs) stores[STORES.proofs].delete(p.secret);
        // From a restored copy, what the swap made is as old as the copy: the mint is asked which of it is unspent.
        for (const p of [...keep, ...send]) stores[STORES.proofs].put({ ...toStored(swap.mint, p), ...(swap.restored ? { unchecked: true } : {}) } satisfies StoredProof);
        if (swap.tx) stores[STORES.walletTx].put(swap.tx);
        // What the mint kept for a split whose payment was never made. In the history, never silent.
        if (lost > 0) stores[STORES.walletTx].put({ ...walletTx(swap.mint, "fee", 0, lost, "A payment was not sent"), id: swap.id });
        if (swap.payment) stores[STORES.payments].put(swap.payment);
        if (late && swap.payment) stores[STORES.swaps].put({ ...kept, finished: true } satisfies PendingSwap);
        else stores[STORES.swaps].delete(swap.id);
      };
    });
    if (stored && swap.restored) void this.checkRestored();
    return stored;
  }

  /**
   * The mint never made this swap. The inputs it held are free again, less any the mint reads spent. `watch`: it is
   * only overdue, so it stays written down, marked `released`, and is asked about for a while longer: should the mint
   * have made it after all, what it made is still recovered.
   */
  private async dropSwap(swap: PendingSwap, gone: Set<string>, watch = false): Promise<void> {
    const inputs = swap.kind === "send" && !swap.released ? await this.storedInputs(swap) : [];
    if (gone.size > 0 && inputs.length > 0) console.warn(`[wallet] ${gone.size} proofs of a swap at ${swap.mint} that never happened are spent`);
    await this.sealedTransact([STORES.proofs, STORES.swaps], { [STORES.proofs]: inputs, [STORES.swaps]: [swap] }, (stores) => {
      for (const p of inputs) {
        if (gone.has(p.secret)) stores[STORES.proofs].delete(p.secret);
        else { const { reserved: _released, ...free } = p; stores[STORES.proofs].put(free satisfies StoredProof); }
      }
      if (watch) stores[STORES.swaps].put({ ...swap, released: true } satisfies PendingSwap);
      else stores[STORES.swaps].delete(swap.id);
    });
    // Ecash of this wallet spent by something else: the rest of what it holds at that mint is asked about too.
    if (gone.size > 0 && inputs.length > 0) void this.recheck(swap.mint).catch(() => {});
  }

  private rememberSpent(mint: string, secrets: Set<string>): void {
    for (const secret of secrets) {
      const key = `${mint} ${secret}`;
      this.spentTokens.delete(key);
      this.spentTokens.add(key);
    }
    for (const oldest of this.spentTokens) {
      if (this.spentTokens.size <= SPENT_KEPT) break;
      this.spentTokens.delete(oldest);
    }
  }

  /** The proofs a split reserved, as they are stored now. */
  private async storedInputs(swap: PendingSwap): Promise<StoredProof[]> {
    return (await this.proofsOf(swapOf(swap).inputs.map((p) => p.secret))).filter((p) => p.mint === swap.mint && p.reserved);
  }

  private async swapsAt(mint: string): Promise<PendingSwap[]> {
    return (await this.readSwaps()).filter((s) => s.mint === mint);
  }

  /** Says what became of a swap to whoever follows it (the chat its payment is in), and waits for it to be taken in. */
  private async tellSwap(swap: PendingSwap, done: boolean): Promise<boolean> {
    try { await this.events.onSwapSettled?.(swap, done); return true; } catch { return false; }
  }

  private swapsAgainIn(ms: number): void {
    if (this.stopped) return;
    if (this.swapTimer && this.swapTimerAt <= Date.now() + ms) return;
    if (this.swapTimer) clearTimeout(this.swapTimer);
    this.swapTimerAt = Date.now() + ms;
    this.swapTimer = setTimeout(() => void this.pollSwaps(), ms);
  }

  /**
   * Swaps still written down: the app closed while the mint was being asked, or the mint did not answer. Each mint is
   * asked where its own stand, one swap at a time under its lock. A swap it made is stored as its answer would have been; one it says it
   * never made is undone; one that is only overdue gives its inputs back and stays watched; one it cannot speak for
   * is asked about again. `mints`: only these mints', once, now.
   */
  /** Asks these mints about their open swaps now (before a wallet's removal is shown or refused). */
  settleSwaps(mints: readonly string[]): Promise<void> {
    return this.pollSwaps(mints);
  }

  /**
   * A contact's ecash for this request of ours is being redeemed: written down, and the mint has not said how it ended,
   * or it has and its chat was not told yet. Released: the mint never made it in time, and the ecash went back. Stuck
   * past its watch hour (spent, and a mint that cannot say by what): kept to be asked about, but no longer expected to
   * pay the request, which another member may pay.
   */
  async redeemingFor(requestId: string): Promise<boolean> {
    const open = await this.readSwaps();
    return open.some((s) => s.kind === "receive" && !s.released && s.payment?.requestId === requestId
      && !(s.stuck && this.pastWatch(s)));
  }

  private async pollSwaps(mints?: readonly string[]): Promise<void> {
    if (!mints) {
      if (this.swapTimer) clearTimeout(this.swapTimer);
      this.swapTimer = null;
      if (this.stopped) return;
    }
    const open = (await this.readSwaps()).filter((s) => !mints || mints.includes(s.mint));
    if (!mints) this.swapAsk.keepOnly(new Set(open.map((s) => s.id)));
    let again = 0;
    const later = (ms: number) => { again = again ? Math.min(again, ms) : ms; };
    // One swap at a time under its mint's lock, read again inside it: the user's own payments there go in between.
    for (const { id, mint } of open) {
      // A mint that has not answered for a while is asked less and less often; a wallet's removal asks it now.
      if (!mints && !this.swapAsk.due(id, Date.now())) { later(this.swapAsk.at(id, Date.now()) - Date.now()); continue; }
      await this.locked(mint, async () => {
        let swap = await openRow(STORES.swaps, await wrap<PendingSwap | undefined>((await store(STORES.swaps, "readonly")).get(id)));
        if (!swap) return;
        try {
          // Stored already, and the app closed before its chat was told: told now.
          // It goes only once the chat took it in: until then it is told again, every round and at every start.
          if (swap.finished) {
            if (await this.tellSwap(swap, true)) await committed((await store(STORES.swaps, "readwrite")).delete(swap.id));
            else later(SWAP_POLL_MS);
            return;
          }
          // Asked many times already with no way of knowing: asked again only when its time comes.
          if (swap.askAt && Date.now() < swap.askAt && !mints) { later(swap.askAt - Date.now()); return; }
          // Found written down with no answer on record: whatever sent it is gone. The mint gets time to finish.
          if (swap.attemptEndedAt === undefined) {
            swap = { ...swap, attemptEndedAt: this.stamp() };
            await this.putSwap(swap);
          }
          let outcome = await this.swapOutcome(swap);
          // A redeem whose token the mint reads unspent, with nothing signed, never happened however long the app was
          // closed, and still can: sent again below, never let go while the token is good (only the mint's word ends it).
          if (outcome.state === "never" && !outcome.final && swap.kind === "receive" && !swap.released) outcome = { state: "open", idle: true };
          // The mint answered. A redeem sent again below keeps its pace until the mint takes it: a mint that reads the
          // token but never takes the swap is not sent it every 30 s for as long as the token is good.
          if (!(outcome.state === "open" && outcome.idle && swap.kind === "receive" && !swap.released)) this.swapAsk.forget(id);
          if (outcome.state === "open") {
            // Its inputs went back, and an hour on the mint still cannot say more: nothing of it is held here.
            if (swap.released && this.pastWatch(swap)) { await this.dropSwap(swap, new Set()); return; }
            if (outcome.slow) {
              // No way of knowing what the mint signed: kept, and asked about less and less often.
              const stuck = (swap.stuck ?? 0) + 1;
              const wait = stuck <= 6 ? SWAP_SLOW_POLL_MS : stuck <= 30 ? 3_600_000 : 86_400_000;
              await this.putSwap({ ...swap, stuck, askAt: Date.now() + wait } satisfies PendingSwap);
              if (stuck === 1) this.events.onChange();
              later(wait);
            } else if (outcome.idle && swap.kind === "receive" && !swap.released) {
              // The mint answers, and has done nothing with this redeem: it is sent again as it was written down.
              // Whichever request the mint acts on signs the same outputs.
              const { deserializeSwapPreview } = await loadCashu();
              try {
                const { keep } = await (await this.wallet(mint)).completeSwap(deserializeSwapPreview(swapOf(swap)));
                this.swapAsk.forget(id);
                if (await this.finishSwap(swap, keep, [], true)) {
                  const told = await this.tellSwap(swap, true);
                  if (swap.payment && told) await committed((await store(STORES.swaps, "readwrite")).delete(swap.id));
                  else if (swap.payment) later(SWAP_POLL_MS);
                  this.events.onChange();
                }
              } catch (error) {
                // Refused for the keyset of its outputs, the token unspent: made again on the mint's keyset now.
                const renewed = await this.renewedReceive(swap, error).catch(() => undefined);
                if (renewed) { await this.sendRenewed(renewed, later); return; }
                swap = { ...swap, attemptEndedAt: this.stamp() };
                await this.putSwap(swap);
                // Refused: the mint's word on it, asked once more, ends it. Anything else is tried again.
                const refusal = mintRefused(error) ?await this.swapOutcome(swap, true).catch(() => undefined) : undefined;
                if (refusal?.state === "done") {
                  if (await this.finishSwap(swap, refusal.keep, refusal.send, true)) {
                    const told = await this.tellSwap(swap, true);
                    if (swap.payment && told) await committed((await store(STORES.swaps, "readwrite")).delete(swap.id));
                  }
                  this.events.onChange();
                } else if (refusal?.state === "never") {
                  await this.dropSwap(swap, refusal.gone);
                  await this.tellSwap(swap, false);
                  this.events.onChange();
                }
                // Not taken, and the mint did not refuse it: from 30 s, twice as late each time (each send moves when
                // it is overdue, so that cannot pace it).
                else later(this.swapAsk.missed(id, Date.now()));
              }
            } else if (outcome.pending && swap.kind === "receive" && !swap.released && this.swapOverdue(swap)) {
              // No request of it can reach the mint any more, and its sender's ecash is still held by a payment of
              // theirs: asked now and then, and let go after its hour.
              if (!this.pastWatch(swap)) {
                await this.putSwap({ ...swap, askAt: Date.now() + SWAP_SLOW_POLL_MS } satisfies PendingSwap);
                later(SWAP_SLOW_POLL_MS);
              } else {
                await this.dropSwap(swap, new Set());
                await this.tellSwap(swap, false);
                this.events.onChange();
              }
            } else later(swap.released ? SWAP_SLOW_POLL_MS : SWAP_POLL_MS);
            return;
          }
          if (outcome.state === "done") {
            if (await this.finishSwap(swap, outcome.keep, outcome.send, true)) {
              const told = await this.tellSwap(swap, true);
              // One with a payment stays, marked finished, until its chat took it in.
              if (swap.payment && told) await committed((await store(STORES.swaps, "readwrite")).delete(swap.id));
              else if (swap.payment) later(SWAP_POLL_MS);
            }
          } else if (swap.released) {
            // Its inputs went back long ago. Watched until they are spent by something else, or for an hour.
            if (outcome.final || this.pastWatch(swap)) await this.dropSwap(swap, outcome.gone);
            else later(SWAP_SLOW_POLL_MS);
            return;
          } else {
            await this.dropSwap(swap, outcome.gone, !outcome.final);
            await this.tellSwap(swap, false);
            if (!outcome.final) later(SWAP_SLOW_POLL_MS);
          }
          this.events.onChange();
        } catch {
          // Mint unreachable, or its answer was an error: asked again on the next round. One that holds nothing
          // any more is not asked about past its hour.
          if (swap.released && this.pastWatch(swap)) await this.dropSwap(swap, new Set()).catch(() => {});
          else if (swap.released) later(SWAP_SLOW_POLL_MS);
          else {
            // Every 30 s while a request may still reach the mint, then less and less often, as melts are.
            later(this.swapAsk.missed(id, Date.now(), !this.swapOverdue(swap)));
          }
        }
      }).catch(() => { later(SWAP_POLL_MS); });
    }
    if (again && !mints) this.swapsAgainIn(again);
  }

  // -- Lightning out -----------------------------------------------------------

  /**
   * What paying this invoice would cost, from the first mint that can afford it. `chosen`: the sats the person typed for
   * an invoice with no amount, the only way one is paid (WISP 203); only a mint that says it takes one is asked.
   */
  async quoteInvoice(invoice: string, network?: WalletNetwork, chosen?: number): Promise<{ quote: string; mint: string; amount: number; feeReserve: number }> {
    let lastError: unknown = new Error("Add a mint in Settings first");
    let mints = this.getMints(network);
    /** The most any mint asked could pay with its fee on top: a Max comes down to it. */
    let room = 0;
    const decoded = decodeBolt11(invoice);
    if (!decoded) throw new Error("That is not an invoice this wallet can pay");
    if (decoded.amountSat === null && chosen === undefined) throw new Error("Invoices without an amount are not supported");
    // An invoice that names its amount is paid for that amount, whatever is asked.
    if (decoded.amountSat !== null && chosen !== undefined) throw new Error(MINT_QUOTE_MISMATCH);
    if (chosen !== undefined) assertAmount(chosen);
    const expected = decoded.amountSat ?? chosen!;
    // A Bitcoin invoice may be real money: test sats pay one only through a mint whose Lightning is known to be fake.
    if (decoded.network === "bitcoin" && mints.some((mint) => mintNetwork(mint) === "testnet")) {
      mints = mints.filter((mint) => mintNetwork(mint) === "mainnet" || fakesLightning(mint));
      if (!mints.length) throw new Error(BITCOIN_INVOICE_ON_TESTNET);
    }
    if (chosen !== undefined && mints.length) lastError = engineError("mintsNoAnyAmount");
    for (const mint of mints) {
      try {
        const wallet = await this.wallet(mint);
        // cashu-ts leaves the amount out of the request for a mint that does not say it takes one: never asked here.
        if (chosen !== undefined && !wallet.getMintInfo().supportsAmountless("bolt11", UNIT)) continue;
        const quote = chosen === undefined ? await wallet.createMeltQuoteBolt11(invoice.trim()) : await wallet.createMeltQuoteBolt11(invoice.trim(), chosen * 1000);
        const amount = quote.amount.toNumber();
        const feeReserve = quote.fee_reserve.toNumber();
        // The amount shown is the invoice's, or the one chosen: a quote for another invoice or amount is never paid.
        if (quoteMismatch(quote, decoded.invoice, expected)) throw new Error(MINT_QUOTE_MISMATCH);
        // The coins the melt spends are paid for too, at a mint that charges for each coin it takes in.
        const proofs = await this.proofsAt(mint);
        const outlay = outlayAt(wallet, proofs, amount + feeReserve, inOneFrame((await loadCashu()).getEncodedToken, mint));
        if (outlay === undefined) {
          room = Math.max(room, roomAt(wallet, proofs, feeReserve));
          lastError = room > 0 ? engineError("notEnoughForFee", { amount: room }) : engineError("notEnoughSats");
          continue;
        }
        // The most it can cost: the reserve, and what the split before the melt and the melt itself pay for their coins.
        const fee = outlay - amount;
        this.shownQuotes.set(quote.quote, { request: decoded.invoice, amount, feeReserve: fee });
        return { quote: quote.quote, mint, amount, feeReserve: fee };
      } catch (error) {
        // A mint that failed ("internal error", a closed connection) is named, with what to do; its words kept last.
        lastError = mintFailed(error) ? Object.assign(engineError("mintFailedQuote", { host: new URL(mint).host, reason: mintReason(error) }), { cause: error }) : error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Pays a melt quote. True once paid; false while the mint holds the payment pending, in which case its
   * proofs stay reserved and the wallet keeps asking until the mint settles it (`onMeltResolved`).
   * Throws only when the sats never left the wallet or are known to be back in it, or when the split before the payment
   * has no answer yet (`SwapUnsettledError`): the payment was not made, and the split is settled by `pollSwaps`.
   */
  async payQuote(quoteId: string, mint: string, note?: string, paymentId?: string): Promise<boolean> {
    try {
      const outcome = await this.locked(mint, () => this.melt(quoteId, mint, note, paymentId));
      if (outcome === "unpaid") throw new Error(`The Lightning payment did not go through. ${backInWallet(this.takeFailedFee(quoteId))}`);
      if (outcome === "pending") void this.pollMelts();
      return outcome === "paid";
    } finally {
      this.events.onChange();
    }
  }

  private async melt(quoteId: string, mint: string, note?: string, paymentId?: string): Promise<MeltOutcome> {
    const wallet = await this.wallet(mint);
    const { MeltChangeError, OutputData, getEncodedToken } = await loadCashu();
    const quote = await wallet.checkMeltQuoteBolt11(quoteId);
    const inFlight = await this.readMelts();
    if (inFlight.some((m) => m.quote === quote.quote || m.request === quote.request)) throw new Error("This invoice is already being paid");
    // Read again from the mint: it must still be the invoice and amount shown, for no more fee than shown, the coins'
    // own fees included, out of the coins held now.
    const shown = this.shownQuotes.get(quoteId);
    const needed = quote.amount.toNumber() + quote.fee_reserve.toNumber();
    const proofs = await this.proofsAt(mint);
    const outlay = outlayAt(wallet, proofs, needed, inOneFrame(getEncodedToken, mint));
    if (!shown || quote.quote !== quoteId || quoteMismatch(quote, shown.request, shown.amount) || (outlay ?? needed) > shown.amount + shown.feeReserve) {
      throw new Error(MINT_QUOTE_MISMATCH);
    }
    // Coins another payment took since the quote was shown: said as the quote would have said it.
    if (outlay === undefined) {
      const room = roomAt(wallet, proofs, quote.fee_reserve.toNumber());
      throw room > 0 ? engineError("notEnoughForFee", { amount: room }) : engineError("notEnoughSats");
    }
    const { inputs, keep, send, swap } = await this.split(mint, needed, proofs);
    let preview: MeltPreview<MeltQuoteBolt11Response>;
    try {
      preview = await wallet.prepareMelt("bolt11", quote, send);
    } catch (error) {
      // Nothing reached the melt: what the swap returned is all spendable.
      await this.sealedTransact([STORES.proofs, STORES.swaps], { [STORES.proofs]: [...keep, ...send] }, (stores) => {
        this.queueReplace(stores[STORES.proofs], mint, inputs, [...keep, ...send]);
        if (swap) stores[STORES.swaps].delete(swap.id);
      });
      throw error;
    }

    const melt: PendingMelt = {
      quote: quote.quote,
      mint,
      request: quote.request,
      amount: quote.amount.toNumber(),
      secrets: send.map((p) => p.secret),
      outlay: total(inputs) - sats(keep),
      outputs: preview.outputData.map((o) => OutputData.serialize(o)),
      note: note?.slice(0, 140),
      paymentId,
      createdAt: this.stamp(),
    };
    // Written down before the mint sees the proofs: from here on they may be spent, or come back.
    await this.sealedTransact([STORES.proofs, STORES.melts, STORES.swaps], { [STORES.proofs]: [...keep, ...send], [STORES.melts]: [melt] }, (stores) => {
      this.queueReplace(stores[STORES.proofs], mint, inputs, keep);
      for (const p of send) stores[STORES.proofs].put(toStored(mint, p, true));
      stores[STORES.melts].put(melt);
      if (swap) stores[STORES.swaps].delete(swap.id);
    });
    this.shownQuotes.delete(quoteId);
    // Not paid: the review that showed it is still the invoice and amount shown, and Pay on it again pays (the refusal
    // says it is safe to try again), checked against the mint's quote as the first time.
    const unpaid = () => { this.shownQuotes.set(quoteId, shown); };

    let result: MeltProofsResponse<MeltQuoteBolt11Response>;
    try {
      result = await wallet.completeMelt(preview);
    } catch (error) {
      // A dropped connection or a gateway timeout says nothing: the payment may still be going through.
      if (!mintRefused(error) && !(error instanceof MeltChangeError)) return "pending";
      // The mint answered (a refusal), or took the proofs and only the change failed: its word decides.
      const outcome = await this.settleMelt(melt, true).catch((): MeltOutcome => "pending");
      if (outcome === "unpaid") {
        unpaid();
        const lost = this.takeFailedFee(melt.quote);
        // Its ecash was spent somewhere else: said in plain words, whatever the mint's own were.
        if (this.spentAway.delete(melt.quote)) throw Object.assign(engineError("ecashAlreadySpent"), { cause: error });
        // The mint's refusal ("Invoice already paid") stays what the person reads, with what it cost them.
        if (lost > 0) throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)} ${backInWallet(lost)}`), { cause: error });
        // Refused, the quote unpaid and every proof back unspent: nothing left the wallet. Said in the app's words, the
        // mint's own kept as the reason (and in the text, where "already paid" is read: InvoiceBubble.tsx).
        throw Object.assign(engineError("lightningRefused", { reason: mintReason(error) }), { cause: error });
      }
      return outcome;
    }
    if (result.quote.state === "PAID") {
      await this.finishMelt(melt, result.change);
      return "paid";
    }
    const outcome = await this.settleMelt(melt, true).catch((): MeltOutcome => "pending");
    if (outcome === "unpaid") unpaid();
    return outcome;
  }

  /**
   * Whether a Lightning payment of this invoice is written down as in flight. A melt is written before the mint sees
   * its proofs, and `pollMelts` settles and reports it: an invoice with none never reached the mint's melt, or is done.
   */
  async meltInFlight(invoice: string): Promise<boolean> {
    const melts = await this.readMelts();
    return melts.some((m) => m.request === invoice);
  }

  /**
   * Lightning payments left pending, asked about again until the mint settles each one: every MELT_POLL_MS while its
   * request may still land, then each at its own pace, twice as late every time up to MELT_SLOW_POLL_MS.
   */
  private async pollMelts(): Promise<void> {
    if (this.meltTimer) clearTimeout(this.meltTimer);
    this.meltTimer = null;
    if (this.stopped) return;
    const melts = await this.readMelts();

    for (const melt of melts) {
      if (!this.meltAsk.due(melt.quote, Date.now())) continue;
      try {
        const outcome = await this.locked(melt.mint, async () => {
          // It may have been settled while this waited for the lock.
          const current = await openRow(STORES.melts, await wrap<PendingMelt | undefined>((await store(STORES.melts, "readonly")).get(melt.quote)));
          return current ? this.settleMelt(current) : null;
        });
        if (outcome === "paid" || outcome === "unpaid") {
          this.takeFailedFee(melt.quote);
          this.spentAway.delete(melt.quote);
          this.events.onMeltResolved(melt, outcome === "paid");
          this.events.onChange();
        }
      } catch {
        // mint unreachable: try again on the next round
      }
      this.meltAsk.missed(melt.quote, Date.now(), !this.meltOverdue(melt));
    }

    const remaining = new Set((await this.readMelts()).map((m) => m.quote));
    this.meltAsk.keepOnly(remaining);
    if (remaining.size === 0 || this.stopped) return;
    // A melt written down since this round began has no pace yet: it is asked at once.
    const next = Math.min(...[...remaining].map((quote) => this.meltAsk.at(quote, 0)));
    if (this.meltTimer) clearTimeout(this.meltTimer);
    this.meltTimer = setTimeout(() => void this.pollMelts(), Math.max(0, next - Date.now()));
  }

  /**
   * Asks the mint where a recorded melt stands and books the answer. Paid: the reserved proofs are gone and
   * the change is ours. Unpaid: what the mint says is unspent is spendable again. Pending: nothing moves.
   * Throws when the mint cannot be asked, and the melt stays as it is. `answered`: the mint answered the melt request
   * itself, so it has acted on it; without that, an unpaid quote may only mean the request has not landed yet.
   */
  private async settleMelt(melt: PendingMelt, answered = false): Promise<MeltOutcome> {
    const wallet = await this.wallet(melt.mint);
    const { Amount, OutputData } = await loadCashu();
    const quote = await wallet.checkMeltQuoteBolt11(melt.quote);
    if (quote.state === "PAID") {
      const signatures = (quote.change ?? []).filter((sig) => !Amount.from(sig.amount).isZero());
      let change: Proof[] = [];
      if (signatures.length > 0) {
        // The change may be on a keyset rotated in while the payment was pending. Fetching it can fail, and is retried.
        await wallet.ensureOperableKeysets(signatures.map((sig) => sig.id));
        try {
          change = wallet.createMeltChangeProofs(
            (melt.outputs as SerializedOutputData[]).map((o) => OutputData.deserialize(o)),
            signatures,
          );
        } catch (error) {
          // This would fail the same way every time, and the payment itself went through.
          console.warn(`[wallet] the fee change of melt ${melt.quote} could not be unblinded`, error);
        }
      }
      await this.finishMelt(melt, change);
      return "paid";
    }
    if (quote.state === "PENDING") return "pending";
    // UNPAID with no answer to the request: it may still reach the mint and be paid with these very proofs. Held
    // until no request of this melt can land any more.
    if (!answered && !this.meltOverdue(melt)) return "pending";

    // UNPAID: the payment failed, or never started. The mint says which proofs are still unspent.
    const inputs = await this.reservedProofs(melt);
    const states = inputs.length > 0 ? await wallet.checkProofsStates(inputs) : [];
    if (states.some((s) => s.state === "PENDING")) return "pending";
    const spent = new Set(inputs.filter((_, i) => states[i]?.state === "SPENT").map((p) => p.secret));
    if (spent.size > 0) console.warn(`[wallet] melt ${melt.quote} is unpaid, yet ${spent.size} of its proofs are spent`);
    // What left the balance for this payment and does not come back: the fee of the split that made its exact proofs
    // (the mint keeps it whether the payment goes or not). In the history, never silent. A proof that reads spent when
    // the payment never happened was spent by something else: it leaves the wallet, and is no fee of this payment.
    const lost = melt.outlay - inputs.reduce((sum, p) => sum + p.amount, 0);
    await this.sealedTransact([STORES.proofs, STORES.melts, ...(lost > 0 ? [STORES.walletTx] : [])], { [STORES.proofs]: inputs }, (stores) => {
      for (const p of inputs) {
        if (spent.has(p.secret)) stores[STORES.proofs].delete(p.secret);
        else stores[STORES.proofs].put({ ...p, reserved: false } satisfies StoredProof);
      }
      stores[STORES.melts].delete(melt.quote);
      if (lost > 0) stores[STORES.walletTx].put(walletTx(melt.mint, "fee", 0, lost, melt.note ? `Payment failed: ${melt.note}` : "A Lightning payment failed"));
    });
    if (lost > 0) this.failedFees.set(melt.quote, lost);
    if (spent.size > 0) { this.spentAway.add(melt.quote); void this.recheck(melt.mint).catch(() => {}); }
    return "unpaid";
  }

  /** The fee a failed melt cost, once: for the words that say it failed. */
  private takeFailedFee(quote: string): number {
    const lost = this.failedFees.get(quote) ?? 0;
    this.failedFees.delete(quote);
    return lost;
  }

  /** The invoice is paid: the reserved proofs are spent, the change is ours, and the payment goes in the history. */
  private async finishMelt(melt: PendingMelt, change: Proof[]): Promise<void> {
    // The reserve is an upper bound; the mint returns what the route did not cost as change.
    const tx = walletTx(melt.mint, "lightning-out", melt.amount, melt.outlay - sats(change) - melt.amount, melt.note);
    await this.sealedTransact([STORES.proofs, STORES.melts, STORES.walletTx], { [STORES.proofs]: change }, (stores) => {
      for (const secret of melt.secrets) stores[STORES.proofs].delete(secret);
      // From a restored copy, the profile it came from may have settled this payment and spent its change since.
      for (const p of change) stores[STORES.proofs].put({ ...toStored(melt.mint, p), ...(melt.restored ? { unchecked: true } : {}) } satisfies StoredProof);
      stores[STORES.melts].delete(melt.quote);
      stores[STORES.walletTx].put(tx);
    });
    if (melt.restored && change.length > 0) void this.checkRestored();
  }

  /**
   * The person removes the Cashu wallet of a network (the engine checked what it holds and what it still waits for,
   * claimed what was already paid, and the person confirmed the rest): the ecash held at its mints, reserved or not,
   * and every invoice of theirs are deleted. A Lightning payment still in flight from one of them is not cut off: the
   * removal is refused until it settles.
   */
  async forget(mints: readonly string[], acceptLoss = false): Promise<void> {
    const at = new Set(mints);
    const inFlight = async () => {
      const melts = await this.readMelts();
      if (melts.some((m) => at.has(m.mint))) throw new Error("A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet.");
    };
    await inFlight();
    // A swap still written down may hold ecash of these mints. They are asked once more, and a swap they cannot
    // settle now is not cut off: the removal is refused until it is. One that holds nothing any more goes with the rest.
    await this.pollSwaps(mints).catch(() => {});
    // Checked again and deleted under every one of these mints' locks: a payment or a send that was splitting its ecash
    // meanwhile (no payment written down yet) ends its turn first, and one that went on to the mint refuses the removal
    // instead of losing its reserved ecash.
    await this.lockedAll(mints, async () => {
      await inFlight();
      const open = (await this.readSwaps()).filter((s) => at.has(s.mint) && !s.released);
      // One that may never settle (its mint is gone, or cannot say what it signed) goes only when the person, shown
      // what it is about, agreed to let it go.
      if (open.length > 0 && !acceptLoss) throw new Error("An exchange of ecash with this wallet's mint is not finished yet: wait for the mint to answer, or confirm that what it would bring is lost to remove the wallet.");
      const proofs = (await this.allProofs()).filter((p) => at.has(p.mint));
      const quotes = (await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll())).filter((q) => at.has(q.mint));
      const swaps = (await this.readSwaps()).filter((s) => at.has(s.mint));
      await this.sealedTransact([STORES.proofs, STORES.quotes, STORES.swaps], {}, (stores) => {
        for (const p of proofs) stores[STORES.proofs].delete(p.secret);
        for (const q of quotes) stores[STORES.quotes].delete(q.quote);
        for (const s of swaps) stores[STORES.swaps].delete(s.id);
      });
    });
    for (const mint of mints) { this.wallets.delete(mint); this.names.delete(mint); this.infos.delete(mint); }
  }

  private async reservedProofs(melt: PendingMelt): Promise<StoredProof[]> {
    return this.proofsOf(melt.secrets);
  }

  /** Everything held, as one token per mint; `mints`: only these mints' (one network's wallet). */
  async exportTokens(mints?: readonly string[]): Promise<{ mint: string; token: string; amount: number }[]> {
    const out: { mint: string; token: string; amount: number }[] = [];
    for (const mint of new Set((await this.allProofs()).map((p) => p.mint))) {
      if (mints && !mints.includes(mint)) continue;
      const proofs = await this.proofsAt(mint);
      if (proofs.length === 0) continue;
      out.push({
        mint,
        amount: total(proofs),
        token: (await loadCashu()).getEncodedToken({ mint, proofs: proofs as unknown as Proof[], unit: UNIT }),
      });
    }
    return out;
  }

  /** Whether the payment poll's reads at this mint may ask it now: its last load did not fail, or its next try came. */
  mintDue(mint: string, now: number): boolean {
    return !this.failedLoads.has(mint) || this.mintAsk.due(mint, now);
  }

  // -- storage -----------------------------------------------------------------

  /**
   * A mint's loaded wallet. A failed load is tried again by the next caller, unless that one takes `recentFailure`
   * (a payment's reads in the poll): a failed load is its answer too until the mint's next try (`mintAsk`).
   */
  private wallet(mint: string, recentFailure = false): Promise<Wallet> {
    let wallet = this.wallets.get(mint);
    if (this.failedLoads.has(mint) && !(recentFailure && !this.mintAsk.due(mint, Date.now()))) wallet = undefined;
    if (!wallet) {
      const loading = (async () => {
        const cashu = await loadCashu();
        const instance = new cashu.Wallet(mint, { unit: UNIT });
        boundSwapRequests(instance, cashu.NetworkError);
        await within(MINT_TIMEOUT_MS, instance.loadMint(), mint);
        const info = instance.getMintInfo();
        if (info.isSupported(5).params.some(saysAmountlessBeside)) instance.loadMintFromCache(amountlessUnderOptions(info.cache), instance.keyChain.cache);
        return instance;
      })();
      wallet = loading;
      this.failedLoads.delete(mint);
      this.wallets.set(mint, loading);
      loading.then(() => this.mintAsk.forget(mint), () => {
        if (this.wallets.get(mint) !== loading) return;
        this.failedLoads.add(mint);
        this.mintAsk.missed(mint, Date.now());
      });
    }
    return wallet;
  }

  /** One operation per mint at a time: two swaps must never pick the same proofs. */
  /** Tasks inside a per-mint lock, running or waiting their turn: a swap there must end, not be cut (WISP 06 § Wallets). */
  private lockedTasks = 0;
  get swapping(): boolean { return this.lockedTasks > 0; }

  private locked<T>(mint: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(mint) ?? Promise.resolve();
    this.lockedTasks += 1;
    const next = previous.then(task, task);
    void next.then(() => { this.lockedTasks -= 1; }, () => { this.lockedTasks -= 1; });
    this.locks.set(
      mint,
      next.catch(() => {}),
    );
    return next;
  }

  /** `task` under the locks of every one of `mints`, taken in one order (no other task holds two, so none waits on this one). */
  private lockedAll<T>(mints: readonly string[], task: () => Promise<T>): Promise<T> {
    return [...new Set(mints)].sort().reduceRight<() => Promise<T>>((inner, mint) => () => this.locked(mint, inner), task)();
  }

  private async allProofs(): Promise<StoredProof[]> {
    return openRows(STORES.proofs, await wrap<StoredProof[]>((await store(STORES.proofs, "readonly")).getAll()));
  }

  /**
   * The stored proofs of these secrets, each read by its key: a swap's inputs cost what the swap holds, not the wallet.
   * With the data key, a proof is under the hash of its secret, or under the secret itself until the migration reseals it.
   */
  private async proofsOf(secrets: Iterable<string>): Promise<StoredProof[]> {
    const wanted = [...new Set(secrets)];
    if (wanted.length === 0) return [];
    const proofs = await store(STORES.proofs, "readonly");
    const sealed = hasDataKey();
    const found = await Promise.all(wanted.map(async (secret) => {
      const [hashed, plain] = await Promise.all([sealed ? wrap<StoredProof | undefined>(proofs.get(proofKey(secret))) : undefined, wrap<StoredProof | undefined>(proofs.get(secret))]);
      return hashed ?? plain;
    }));
    return openRows(STORES.proofs, found.filter((p): p is StoredProof => p !== undefined));
  }

  private async readSwaps(): Promise<PendingSwap[]> {
    return openRows(STORES.swaps, await wrap<PendingSwap[]>((await store(STORES.swaps, "readonly")).getAll()));
  }

  private async readMelts(): Promise<PendingMelt[]> {
    return openRows(STORES.melts, await wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll()));
  }

  /** Sealed before its transaction opens (one that waits for WebCrypto commits early), when the profile is encrypted. */
  private async putSwap(swap: PendingSwap): Promise<void> {
    const row = await sealRow(STORES.swaps, swap);
    await committed((await store(STORES.swaps, "readwrite")).put(row));
  }

  /**
   * `transact`, with the wallet's secrets sealed as they are written when the profile is encrypted (WISP 04): `rows`,
   * the proofs, swaps, melts and payments the work may put, are sealed before the transaction opens, and the work finds
   * a proof by its secret. Without the data key, `transact` itself.
   */
  private async sealedTransact(names: string[], rows: Partial<Record<string, readonly object[]>>, work: (stores: Record<string, IDBObjectStore>) => void): Promise<void> {
    const seals = new RowSeals();
    for (const [name, list] of Object.entries(rows)) await seals.prepare(name, list ?? []);
    return transact(names, (stores) => work(seals.on ? Object.fromEntries(names.map((name) => [name, sealedStore(stores[name], seals)])) : stores));
  }

  private async proofsAt(mint: string): Promise<StoredProof[]> {
    return (await this.allProofs()).filter((p) => p.mint === mint && !p.reserved);
  }

  /** After a swap: the inputs are spent, `keep` is what came back to us. Queued in the caller's transaction: all or nothing. */
  private queueReplace(proofStore: IDBObjectStore, mint: string, inputs: StoredProof[], keep: Proof[]): void {
    const kept = new Set(keep.map((p) => p.secret));
    for (const p of inputs) if (!kept.has(p.secret)) proofStore.delete(p.secret);
    for (const p of keep) proofStore.put(toStored(mint, p));
  }
}
