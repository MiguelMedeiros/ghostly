import {
  Amount,
  HttpResponseError,
  MeltChangeError,
  OutputData,
  serializeSwapPreview,
  deserializeSwapPreview,
  Wallet,
  decodePaymentRequest,
  getEncodedToken,
  getTokenMetadata,
  isMintOperationError,
  type MeltPreview,
  type MeltProofsResponse,
  type MeltQuoteBolt11Response,
  type Proof,
  type ProofLike,
  type SerializedOutputData,
  type SerializedSwapPreview,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { STORES, openDb, store, transact, wrap } from "../shared/idb";
import { PaymentPreflightError, decodeBolt11, engineError, engineText, type PaymentReview, type WalletNetwork } from "@ghostly/core";
import { SWAP_SETTLED_MS } from "./paymentAdapters/cashu";
import { BITCOIN_INVOICE_ON_TESTNET, fakesLightning, isTestMint, mintNetwork, paysItsOwnInvoices } from "../shared/mints";
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
 * Because they are random, the outputs of a swap exist nowhere but here until the mint has signed them and its answer
 * is stored. So every swap is written down first (`PendingSwap`, or the payment intent of a reviewed payment): the mint
 * signs those outputs and no others, and its signatures can be asked for again (NUT-09) whenever an answer is missed.
 */
const UNIT = "sat";
const QUOTE_POLL_MS = 4_000;
/** A Lightning payment can stay in flight for minutes or hours; the mint is asked again this often. */
const MELT_POLL_MS = 30_000;
const MAX_AMOUNT = 1_000_000;
/** How long "Get test coins" waits for the test mint to mark its invoice paid before saying the coins come later. */
const TEST_COINS_WAIT_MS = 30_000;
const HISTORY_SHOWN = 100;
/** How long before a mint that could not say which restored ecash is spent is asked again. */
const RESTORED_POLL_MS = 60_000;
/** How long before a mint that could not say where a swap stands is asked again. */
const SWAP_POLL_MS = 30_000;
/** `abandoned`: the mint proved the swap never happened (`reviewedCashuNeverSwapped`); it is never sent again. */
/**
 * `attemptEndedAt`: when the approval's swap failed with no answer. `abandoned`: the mint proved the swap never
 * happened (`reviewedCashuNeverSwapped`); it is never sent again.
 */
export interface CashuPrepared {mint:string;swap:SerializedSwapPreview;token?:string;attemptEndedAt?:number;abandoned?:boolean}

// SDK 4.x preview.fees covers input swap fees, despite its declaration saying
// it includes the recipient fee. includeFees(true) also tops up send outputs.
// Derive everything leaving this wallet beyond the requested amount instead.
function reviewedCashuFee(preview: SwapPreview): number {
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
  constructor(readonly swap: PendingSwap, options?: ErrorOptions) {
    const host = new URL(swap.mint).host;
    super(swap.kind === "receive"
      ? `${host} has not answered yet. The ecash is added to your wallet as soon as it does.`
      : `${host} has not answered yet. Nothing was sent, and the sats are back in your wallet as soon as it does.`, options);
    this.name = "SwapUnsettledError";
  }
}

/** Where a written-down swap stands at its mint. `gone`: never signed, and these inputs are spent all the same. */
type SwapOutcome =
  | { state: "done"; keep: Proof[]; send: Proof[] }
  | { state: "never"; gone: Set<string> }
  | { state: "open" };

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
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter an amount in sats");
  if (amount > MAX_AMOUNT) throw new Error(`Amounts above ${MAX_AMOUNT.toLocaleString()} sats are not supported`);
}

/** Stored proofs are plain objects (amounts as numbers), which is what the library calls ProofLike. */
const asProofLike = (proofs: StoredProof[]) => proofs as unknown as ProofLike[];

const total = (proofs: { amount: number }[]) => proofs.reduce((sum, p) => sum + p.amount, 0);

const sats = (proofs: Proof[]) => total(proofs.map((p) => ({ amount: p.amount.toNumber() })));

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
const swapId = () => `swap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const walletTx = (mint: string, kind: WalletTxKind, amount: number, fee: number, note?: string): WalletTx => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
  onSwapSettled?(swap: PendingSwap, done: boolean): void;
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

export class CashuWallet {
  private readonly wallets = new Map<string, Promise<Wallet>>();
  private readonly names = new Map<string, string>();
  private readonly infos = new Map<string, MintInfoView>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private quoteTimer: ReturnType<typeof setTimeout> | null = null;
  private meltTimer: ReturnType<typeof setTimeout> | null = null;
  private restoredTimer: ReturnType<typeof setTimeout> | null = null;
  private swapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per melt quote that ended unpaid: the sats the mint kept all the same (the fee of the split before the melt). */
  private readonly failedFees = new Map<string, number>();

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

  start(): void {
    void this.pollQuotes();
    void this.pollMelts();
    void this.checkRestored();
    void this.pollSwaps();
    // Names, fees and limits for the UI; a mint that is down simply stays without them.
    for (const mint of this.getKnownMints()) void this.checkMint(mint).then(() => this.events.onChange(), () => {});
  }

  /** The Cashu wallet of one network: its mints and their balance. History is every network's, newest first. */
  async view(network?: WalletNetwork): Promise<WalletView> {
    const proofs = await this.allProofs();
    const mints: MintView[] = this.getMints(network).map((url) => ({
      url,
      name: this.names.get(url) ?? new URL(url).hostname,
      balance: total(proofs.filter((p) => p.mint === url && !p.reserved)),
      info: this.infos.get(url) ?? null,
    }));
    const all = await wrap<WalletTx[]>((await store(STORES.walletTx, "readonly")).getAll());
    all.sort((a, b) => b.timestamp - a.timestamp);
    return {
      mints,
      balance: total(mints.map((m) => ({ amount: m.balance }))),
      history: all.slice(0, HISTORY_SHOWN),
      feesPaid: all.reduce((sum, tx) => sum + tx.fee, 0),
    };
  }

  /**
   * Ecash a profile restore brought back (`unchecked`) is a copy from when the backup was made. What was spent since
   * (by the profile it was copied from, or by this one before it was restored) still counted in the balance, for good,
   * and every payment that picked one of those proofs failed with the mint's "Token already spent". Each mint is asked
   * once which of them it still reads unspent: a spent proof is dropped, an unspent one is checked for good, and one
   * the mint holds pending, or a mint that cannot be asked, is asked again later.
   */
  private async checkRestored(): Promise<void> {
    if (this.restoredTimer) clearTimeout(this.restoredTimer);
    this.restoredTimer = null;
    const waiting = (p: StoredProof) => !!p.unchecked && !p.reserved;
    let again = false, changed = false;
    for (const mint of new Set((await this.allProofs()).filter(waiting).map((p) => p.mint))) {
      try {
        await this.locked(mint, async () => {
          const proofs = (await this.allProofs()).filter((p) => p.mint === mint && waiting(p));
          if (!proofs.length) return;
          const states = await (await this.wallet(mint)).checkProofsStates(proofs);
          if (states.length !== proofs.length) throw new Error("The mint answered for another number of proofs");
          await transact([STORES.proofs], (stores) => {
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
    }
    if (changed) this.events.onChange();
    if (again) this.restoredTimer = setTimeout(() => void this.checkRestored(), RESTORED_POLL_MS);
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
        created = { mint: candidate, response: await within(MINT_TIMEOUT_MS, (await this.wallet(candidate)).createMintQuoteBolt11(amount, "Ghostly"), candidate) };
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
    await wrap((await store(STORES.quotes, "readwrite")).put(quote));
    void this.pollQuotes();
    return quote;
  }

  /**
   * A payer says it paid this invoice of ours (a contact's app, once its payment went through). A held quote (a test
   * mint's, which reads paid by itself) is minted from now on; on any other mint the mint's own answer decides, as
   * always. Returns whether the invoice is one of ours.
   */
  async vouch(invoice: string): Promise<boolean> {
    const wanted = invoice.trim().toLowerCase();
    const quote = (await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll())).find((q) => q.invoice.toLowerCase() === wanted);
    if (!quote) return false;
    if (quote.held) await wrap((await store(STORES.quotes, "readwrite")).put({ ...quote, held: undefined } satisfies StoredQuote));
    await this.pollQuotes();
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
    const response = await within(MINT_TIMEOUT_MS, (await this.wallet(mint)).createMintQuoteBolt11(amount, "Ghostly test coins"), mint);
    const quote: StoredQuote = {
      quote: response.quote,
      mint,
      amount,
      invoice: response.request,
      createdAt: Date.now(),
      expiresAt: response.expiry ? response.expiry * 1000 : null,
      testCoins: true,
    };
    await wrap((await store(STORES.quotes, "readwrite")).put(quote));
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
    if (!mints) return this.pollQuotes();
    const at = new Set(mints);
    await this.settleQuotes((await this.quotes()).filter((q) => at.has(q.mint)));
  }

  /** Every invoice of ours the mints have not settled yet, held, paid-unclaimed and issued-unclaimed ones included. */
  async quotes(): Promise<StoredQuote[]> {
    return wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());
  }

  /**
   * Invoices are paid by someone else, somewhere else; all we can do is ask the mint. A quote is the only
   * claim on the sats paid to it, so it is dropped only once the mint says it is unpaid and it has expired.
   */
  private async pollQuotes(): Promise<void> {
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    this.quoteTimer = null;
    const quotes = await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());

    // A held quote is not asked about: its mint's "paid" means nothing. It only goes once it has expired.
    for (const held of quotes.filter((q) => q.held && q.expiresAt && q.expiresAt + 60_000 < Date.now())) {
      await wrap((await store(STORES.quotes, "readwrite")).delete(held.quote));
    }
    await this.settleQuotes(quotes);

    const remaining = await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());
    if (remaining.some((q) => !q.issuedUnclaimed && !q.held)) this.quoteTimer = setTimeout(() => void this.pollQuotes(), QUOTE_POLL_MS);
  }

  private async settleQuotes(quotes: readonly StoredQuote[]): Promise<void> {
    for (const { quote, mint } of quotes.filter((q) => !q.issuedUnclaimed && !q.held)) {
      try {
        const paid = await this.locked(mint, () => this.settleQuote(quote));
        if (paid) {
          // Test coins are no invoice anyone else knows of.
          if (!paid.testCoins) this.events.onQuotePaid(paid);
          this.events.onChange();
        }
      } catch {
        // mint unreachable: try again on the next round
      }
    }
  }

  /** Runs under the mint's lock, so two rounds never mint one quote twice. Returns the quote once its ecash is in. */
  private async settleQuote(id: string): Promise<StoredQuote | null> {
    // Another round may have settled it while this one waited for the lock.
    const quote = await wrap<StoredQuote | undefined>((await store(STORES.quotes, "readonly")).get(id));
    if (!quote || quote.issuedUnclaimed || quote.held) return null;
    const wallet = await this.wallet(quote.mint);
    const { state } = await wallet.checkMintQuoteBolt11(quote.quote);

    if (state === "UNPAID") {
      if (quote.expiresAt && quote.expiresAt + 60_000 < Date.now()) {
        await wrap((await store(STORES.quotes, "readwrite")).delete(quote.quote));
      }
      return null;
    }
    if (state === "ISSUED") {
      // The ecash is stored in the same transaction that drops the quote, so a quote still here was never
      // credited to this wallet. It is the only trace of those sats: keep it, stop asking.
      console.warn(`[wallet] ${quote.mint} issued quote ${quote.quote} (${quote.amount} sats) but this wallet holds no ecash for it`);
      await wrap((await store(STORES.quotes, "readwrite")).put({ ...quote, issuedUnclaimed: true } satisfies StoredQuote));
      return null;
    }

    // Paid: money arrived, and until it is minted this quote is the only claim on it. Written down, so a wallet
    // about to be removed can say so (walletRemoval) while the mint is slow to hand the ecash over.
    if (!quote.paid) await wrap((await store(STORES.quotes, "readwrite")).put({ ...quote, paid: true } satisfies StoredQuote));
    const proofs = await wallet.mintProofsBolt11(quote.amount, quote.quote);
    const minted = sats(proofs);
    const tx = walletTx(quote.mint, "lightning-in", minted, quote.amount - minted, quote.paymentId ? "Request paid over Lightning" : quote.testCoins ? TEST_COINS_NOTE : undefined);
    await transact([STORES.proofs, STORES.walletTx, STORES.quotes], (stores) => {
      for (const p of proofs) stores[STORES.proofs].put(toStored(quote.mint, p));
      stores[STORES.walletTx].put(tx);
      stores[STORES.quotes].delete(quote.quote);
    });
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
    const candidates = (preferred ? preferred.map((m) => m.replace(/\/+$/, "")).filter((m) => mine.includes(m)) : mine)
      .filter((m) => !network || mintNetwork(m) === network);
    for (const mint of candidates) {
      if ((await this.balanceAt(mint)) < amount) continue;
      return this.locked(mint, async () => {
        const { inputs, keep, send, swap } = await this.split(mint, amount, await this.proofsAt(mint));
        const token = getEncodedToken({ mint, proofs: send, unit: UNIT });
        // Everything that left the balance beyond the amount: the swap's fee and the redeem fee prepaid for the receiver.
        const spent = total(inputs) - sats(keep);
        const tx = walletTx(mint, "ecash-out", amount, spent - amount, note);
        const kept = outbox?.(token, mint);
        await transact([STORES.proofs, STORES.walletTx, STORES.swaps, ...(kept ? [STORES.payments] : [])], (stores) => {
          this.queueReplace(stores[STORES.proofs], mint, inputs, keep);
          stores[STORES.walletTx].put(tx);
          if (swap) stores[STORES.swaps].delete(swap.id);
          if (kept) stores[STORES.payments].put(kept);
        });
        this.events.onChange();
        return { token, mint };
      });
    }
    throw engineError(candidates.length === 0 && preferred ? "noSharedMint" : "notEnoughSats");
  }

  async prepareReviewedCashu(mint:string,amount:number):Promise<{fee:number;prepared:CashuPrepared}> {
    assertAmount(amount);
    if(!this.getKnownMints().includes(mint))throw new Error("Select a configured mint");
    return this.locked(mint,async()=>{
      const wallet=await this.wallet(mint);
      const preview=await wallet.ops.send(amount,asProofLike(await this.proofsAt(mint))).includeFees(true).prepare();
      return {fee:reviewedCashuFee(preview),prepared:{mint,swap:serializeSwapPreview(preview)}};
    });
  }

  /** Reserve before the mint call. A timeout keeps these inputs reserved for read-only recovery. */
  async executeReviewedCashu(review:PaymentReview,prepared:CashuPrepared):Promise<string> {
    return this.locked(prepared.mint,async()=>{
      const preview=deserializeSwapPreview(prepared.swap);
      // Refused before the mint is asked: nothing was sent, and the review fails for good (the request can be paid again).
      if(prepared.mint!==review.provider || preview.amount.toNumber()!==review.amount || reviewedCashuFee(preview)!==review.fee)throw new PaymentPreflightError("Cashu preview does not match review");
      const tx=(await openDb()).transaction(STORES.proofs,"readwrite");
      await new Promise<void>((resolve,reject)=>{
        const proofs=tx.objectStore(STORES.proofs);
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
      const wallet=await this.wallet(prepared.mint);
      const {keep,send}=await wallet.completeSwap(preview);
      return this.finishReviewedCashu(review,prepared,keep,send);
    });
  }

  /** NUT-09 retrieves signatures for the exact saved outputs; it never creates another swap. */
  async recoverReviewedCashu(review:PaymentReview,prepared:CashuPrepared):Promise<string|undefined> {
    const stored=await wrap<StoredPayment|undefined>((await store(STORES.payments,"readonly")).get(review.id));
    if(stored?.token)return stored.token;
    const wallet=await this.wallet(prepared.mint);
    const keep=(prepared.swap.keepOutputs??[]).map(OutputData.deserialize);
    const send=(prepared.swap.sendOutputs??[]).map(OutputData.deserialize);
    const outputs=[...keep,...send];
    const restored=await this.restoreOutputs(wallet,outputs);
    if(!restored)return undefined;
    return this.finishReviewedCashu(review,prepared,restored.slice(0,keep.length),restored.slice(keep.length));
  }

  /**
   * The mint's signatures for these exact outputs (NUT-09), as the proofs they stand for; undefined unless it has
   * signed every one of them. It only reads what the mint already signed: nothing is swapped again.
   */
  private async restoreOutputs(wallet:Wallet,outputs:OutputData[]):Promise<Proof[]|undefined> {
    const recovered=await wallet.mint.restore({outputs:outputs.map(o=>o.blindedMessage)});
    if(recovered.outputs.length!==outputs.length || recovered.signatures.length!==outputs.length)return undefined;
    const keys=(await wallet.mint.getKeys()).keysets;
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
    const token=getEncodedToken({mint:prepared.mint,proofs:send,unit:UNIT});
    const preview=deserializeSwapPreview(prepared.swap);
    const record:StoredPayment={id:review.id,linkId:review.linkId!,kind:"payment",direction:"out",amount:review.amount,unit:UNIT,memo:review.memo,state:"pending",createdAt:review.createdAt,mint:prepared.mint,token,requestId:review.requestId,target:review};
    await transact([STORES.proofs,STORES.payments,STORES.walletTx],stores=>{
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
    const preview=deserializeSwapPreview(prepared.swap);
    if(!preview.inputs.length)return false;
    const wallet=await this.wallet(prepared.mint);
    const states=await wallet.checkProofsStates(preview.inputs.map(p=>({secret:p.secret,id:p.id})));
    if(states.length!==preview.inputs.length || !states.every(s=>s.state==="UNSPENT"))return false;
    const outputs=[...(prepared.swap.keepOutputs??[]),...(prepared.swap.sendOutputs??[])].map(OutputData.deserialize);
    const restored=await wallet.mint.restore({outputs:outputs.map(o=>o.blindedMessage)});
    return restored.signatures.length===0 && restored.outputs.length===0;
  }

  /** Gives back the inputs a reviewed swap reserved, once the mint proved it never happened. Idempotent. */
  async releaseReviewedCashu(prepared:CashuPrepared):Promise<void> {
    const preview=deserializeSwapPreview(prepared.swap);
    await this.locked(prepared.mint,async()=>{
      await transact([STORES.proofs],stores=>{
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

  async reviewedCashuSpent(prepared:CashuPrepared):Promise<boolean> {
    const outputs=(prepared.swap.sendOutputs??[]).map(OutputData.deserialize);
    const states=await (await this.wallet(prepared.mint)).checkProofsStates(outputs.map(o=>({secret:new TextDecoder().decode(o.secret),id:o.blindedMessage.id})));
    return states.length>0 && states.length===outputs.length && states.every(s=>s.state==="SPENT");
  }

  /** Reads a token or a payment request without contacting a mint. Nothing here moves money. */
  inspect(text: string): CashuInspection | null {
    const value = text.trim();
    try {
      if (/^cashu[AB]/i.test(value)) {
        const metadata = getTokenMetadata(value);
        const mint = metadata.mint.replace(/\/+$/, "");
        return {
          kind: "token",
          amount: Number(metadata.amount),
          unit: metadata.unit,
          mint,
          memo: metadata.memo || undefined,
          accepted: this.getKnownMints().includes(mint) || isTestMint(mint),
        };
      }
      if (/^creq[AB]/i.test(value)) {
        const request = decodePaymentRequest(value);
        return {
          kind: "request",
          amount: request.amount === undefined ? null : Number(request.amount),
          unit: request.unit ?? UNIT,
          mints: request.mints ?? [],
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
  ): Promise<{ amount: number; mint: string }> {
    let mint: string;
    let faceValue: number;
    try {
      const metadata = getTokenMetadata(token);
      if (metadata.unit !== UNIT) throw new Error("unit");
      mint = metadata.mint.replace(/\/+$/, "");
      faceValue = Number(metadata.amount);
    } catch {
      throw new Error("That is not a valid ecash token");
    }
    // A mint is a custodian and only the user picks those. The test mint holds nothing of value.
    if (addTestMint && !this.getKnownMints().includes(mint) && isTestMint(mint)) await this.events.onTestMintNeeded(mint);
    if (!this.getKnownMints().includes(mint)) throw new Error(`Ecash from ${new URL(mint).hostname} is not accepted`);

    return this.locked(mint, async () => {
      // A sender that prepaid the redeem fee put it on top of the amount; what the mint kept is the fee either way.
      const records = (credited: number) => ({ tx: walletTx(mint, kind, credited, Math.max(0, faceValue - credited), note), ...(payment ? { payment: payment(credited, mint) } : {}) });
      // A redeem of this very token that is still written down is finished as it was made: never a second swap for it.
      let swap = (await this.swapsAt(mint)).find((s) => s.kind === "receive" && s.token === token);
      if (!swap) {
        const preview = await (await this.wallet(mint)).prepareSwapToReceive(token);
        // The outputs are for what is left after the mint's fee, so the records are known before the mint is asked.
        swap = { id: swapId(), mint, kind: "receive", swap: serializeSwapPreview(preview), createdAt: Date.now(), token, ...records(preview.amount.toNumber()) };
        await wrap((await store(STORES.swaps, "readwrite")).put(swap));
      }
      const { keep } = await this.completeSwap(swap);
      const credited = sats(keep);
      // What the mint signed is what is credited.
      if (swap.tx && credited !== swap.tx.amount) swap = { ...swap, ...records(credited), tx: { ...records(credited).tx, id: swap.tx.id, timestamp: swap.tx.timestamp } };
      await this.finishSwap(swap, keep, []);
      this.events.onChange();
      return { amount: credited, mint };
    });
  }

  // -- swaps: written down, then finished ------------------------------------------

  /**
   * Splits `amount`, with the fee its receiver will pay to redeem it, out of `proofs`. Coins that add up exactly need
   * no mint. Otherwise it is a swap: written down, with its inputs reserved, before the mint is asked. The caller
   * stores the result in one transaction: `inputs` out, `keep` in, `send` where it goes, and `swap` deleted.
   * Runs under the mint's lock.
   */
  private async split(mint: string, amount: number, proofs: StoredProof[]): Promise<{ inputs: StoredProof[]; keep: Proof[]; send: Proof[]; swap?: PendingSwap }> {
    const wallet = await this.wallet(mint);
    const among = (chosen: { secret: string }[]) => { const secrets = new Set(chosen.map((p) => p.secret)); return proofs.filter((p) => secrets.has(p.secret)); };
    try {
      const { send } = wallet.sendOffline(amount, asProofLike(proofs), { includeFees: true, exactMatch: true });
      if (send.length > 0 && sats(send) === amount + wallet.getFeesForProofs(send).toNumber()) return { inputs: among(send), keep: [], send };
    } catch {
      // no exact coins: the mint makes them
    }
    const preview = await wallet.prepareSwapToSend(amount, asProofLike(proofs), { includeFees: true });
    const swap: PendingSwap = { id: swapId(), mint, kind: "send", swap: serializeSwapPreview(preview), createdAt: Date.now() };
    const inputs = among(preview.inputs);
    // Written down before the mint sees the proofs: from here on they may be spent, and only these outputs replace them.
    await transact([STORES.proofs, STORES.swaps], (stores) => {
      for (const p of inputs) stores[STORES.proofs].put({ ...p, reserved: true } satisfies StoredProof);
      stores[STORES.swaps].put(swap);
    });
    const { keep, send } = await this.completeSwap(swap);
    return { inputs, keep, send, swap };
  }

  /**
   * Sends a written-down swap to the mint: always the saved one, so a second try asks for the same outputs. When the
   * answer is missed the mint is asked what it did, and its word decides: the outputs it signed are the result, as the
   * answer would have been; a swap it never made is undone and the failure is thrown; and while it cannot say, the
   * swap stays written down (`SwapUnsettledError`) and `pollSwaps` settles it. Runs under the mint's lock.
   */
  private async completeSwap(swap: PendingSwap): Promise<{ keep: Proof[]; send: Proof[] }> {
    const retried = swap.attemptEndedAt !== undefined;
    try {
      // The saved preview carries only the swap's own outputs: what comes back is exactly what the mint signed.
      return await (await this.wallet(swap.mint)).completeSwap(deserializeSwapPreview(swapOf(swap)));
    } catch (error) {
      const refused = isMintOperationError(error);
      const ended: PendingSwap = { ...swap, attemptEndedAt: Date.now() };
      await (async () => wrap((await store(STORES.swaps, "readwrite")).put(ended)))().catch(() => {});
      const outcome = await this.swapOutcome(ended, refused).catch((): SwapOutcome => ({ state: "open" }));
      if (outcome.state === "done") return outcome;
      if (outcome.state === "never") {
        await this.dropSwap(ended, outcome.gone);
        throw error;
      }
      this.swapTimer ??= setTimeout(() => void this.pollSwaps(), SWAP_POLL_MS);
      // A first try the mint refused is a refusal, and is said as one; the swap stays until the mint confirms it.
      if (refused && !retried) throw error;
      throw new SwapUnsettledError(ended, { cause: error });
    }
  }

  /**
   * Asks the mint where a written-down swap stands. It only asks: nothing is sent again, nothing is stored.
   * `refused`: the mint answered this swap with a refusal, so no request of it is still on its way.
   * Throws when the mint cannot be asked.
   */
  private async swapOutcome(swap: PendingSwap, refused = false): Promise<SwapOutcome> {
    const wallet = await this.wallet(swap.mint);
    const saved = swapOf(swap);
    const keep = (saved.keepOutputs ?? []).map(OutputData.deserialize);
    const send = (saved.sendOutputs ?? []).map(OutputData.deserialize);
    const signed = async (): Promise<SwapOutcome | undefined> => {
      let proofs: Proof[] | undefined;
      try { proofs = keep.length + send.length > 0 ? await this.restoreOutputs(wallet, [...keep, ...send]) : undefined; }
      catch (error) {
        // A mint that does not restore (NUT-09) has no signatures to give back; one that cannot be reached is asked later.
        if (!isMintOperationError(error) && !(error instanceof HttpResponseError && [404, 405, 501].includes(error.status))) throw error;
      }
      return proofs && { state: "done", keep: proofs.slice(0, keep.length), send: proofs.slice(keep.length) };
    };
    const done = await signed();
    if (done) return done;
    const states = await wallet.checkProofsStates(saved.inputs.map((p) => ({ secret: p.secret, id: p.id })));
    if (states.length !== saved.inputs.length) throw new Error("The mint answered for another number of proofs");
    if (states.some((s) => s.state === "PENDING")) return { state: "open" };
    const gone = new Set(saved.inputs.filter((_, i) => states[i]?.state === "SPENT").map((p) => p.secret));
    // Spent, and not by this swap (asked once more: it may have gone through between the two questions).
    if (gone.size > 0) return (await signed()) ?? { state: "never", gone };
    // Unspent and unsigned: it never happened, once no request of it can still reach the mint.
    if (refused || Date.now() >= (swap.attemptEndedAt ?? Number.POSITIVE_INFINITY) + SWAP_SETTLED_MS) return { state: "never", gone };
    return { state: "open" };
  }

  /**
   * Stores what a swap brought, and deletes it, in one transaction: a swap still written down was never stored, and
   * one stored is never stored again. A redeem brings its ecash with its history line and its payment record. A split
   * finished here was not finished by its caller (the payment it was for is over): everything it made is the wallet's.
   */
  private async finishSwap(swap: PendingSwap, keep: Proof[], send: Proof[]): Promise<void> {
    const inputs = swap.kind === "send" ? await this.storedInputs(swap) : [];
    const lost = swap.kind === "send" ? swapOf(swap).inputs.reduce((sum, p) => sum + Number(p.amount), 0) - sats(keep) - sats(send) : 0;
    await transact([STORES.proofs, STORES.swaps, STORES.walletTx, ...(swap.payment ? [STORES.payments] : [])], (stores) => {
      for (const p of inputs) stores[STORES.proofs].delete(p.secret);
      for (const p of [...keep, ...send]) stores[STORES.proofs].put(toStored(swap.mint, p));
      if (swap.tx) stores[STORES.walletTx].put(swap.tx);
      // What the mint kept for a split whose payment was never made. In the history, never silent.
      if (lost > 0) stores[STORES.walletTx].put({ ...walletTx(swap.mint, "fee", 0, lost, "A payment was not sent"), id: swap.id });
      if (swap.payment) stores[STORES.payments].put(swap.payment);
      stores[STORES.swaps].delete(swap.id);
    });
  }

  /** The mint never made this swap: the inputs it held are free again, less any the mint reads spent, and it is deleted. */
  private async dropSwap(swap: PendingSwap, gone: Set<string>): Promise<void> {
    const inputs = swap.kind === "send" ? await this.storedInputs(swap) : [];
    if (gone.size > 0 && inputs.length > 0) console.warn(`[wallet] ${gone.size} proofs of a swap at ${swap.mint} that never happened are spent`);
    await transact([STORES.proofs, STORES.swaps], (stores) => {
      for (const p of inputs) {
        if (gone.has(p.secret)) stores[STORES.proofs].delete(p.secret);
        else { const { reserved: _released, ...free } = p; stores[STORES.proofs].put(free satisfies StoredProof); }
      }
      stores[STORES.swaps].delete(swap.id);
    });
  }

  /** The proofs a split reserved, as they are stored now. */
  private async storedInputs(swap: PendingSwap): Promise<StoredProof[]> {
    const secrets = new Set(swapOf(swap).inputs.map((p) => p.secret));
    return (await this.allProofs()).filter((p) => p.mint === swap.mint && p.reserved && secrets.has(p.secret));
  }

  private async swapsAt(mint: string): Promise<PendingSwap[]> {
    return (await wrap<PendingSwap[]>((await store(STORES.swaps, "readonly")).getAll())).filter((s) => s.mint === mint);
  }

  /**
   * Swaps still written down: the app closed while the mint was being asked, or the mint did not answer. Each mint is
   * asked where its own stand, under its lock. A swap it made is stored as its answer would have been; one it never
   * made is undone; one it cannot speak for yet is asked about again. `mints`: only these mints', once, now.
   */
  private async pollSwaps(mints?: readonly string[]): Promise<void> {
    if (!mints) {
      if (this.swapTimer) clearTimeout(this.swapTimer);
      this.swapTimer = null;
    }
    const open = (await wrap<PendingSwap[]>((await store(STORES.swaps, "readonly")).getAll())).filter((s) => !mints || mints.includes(s.mint));
    let again = false;
    for (const mint of new Set(open.map((s) => s.mint))) {
      await this.locked(mint, async () => {
        for (let swap of await this.swapsAt(mint)) {
          try {
            // Found written down with no answer on record: whatever sent it is gone. The mint gets a moment to finish.
            if (swap.attemptEndedAt === undefined) {
              swap = { ...swap, attemptEndedAt: Date.now() };
              await wrap((await store(STORES.swaps, "readwrite")).put(swap));
            }
            const outcome = await this.swapOutcome(swap);
            if (outcome.state === "open") { again = true; continue; }
            if (outcome.state === "done") await this.finishSwap(swap, outcome.keep, outcome.send);
            else await this.dropSwap(swap, outcome.gone);
            this.events.onSwapSettled?.(swap, outcome.state === "done");
            this.events.onChange();
          } catch {
            // mint unreachable: asked again on the next round
            again = true;
          }
        }
      }).catch(() => { again = true; });
    }
    if (again && !mints) this.swapTimer ??= setTimeout(() => void this.pollSwaps(), SWAP_POLL_MS);
  }

  // -- Lightning out -----------------------------------------------------------

  /** What paying this invoice would cost, from the first mint that can afford it. */
  async quoteInvoice(invoice: string, network?: WalletNetwork): Promise<{ quote: string; mint: string; amount: number; feeReserve: number }> {
    let lastError: unknown = new Error("Add a mint in Settings first");
    let mints = this.getMints(network);
    // A Bitcoin invoice may be real money: test sats pay one only through a mint whose Lightning is known to be fake.
    if (decodeBolt11(invoice.trim())?.network === "bitcoin" && mints.some((mint) => mintNetwork(mint) === "testnet")) {
      mints = mints.filter((mint) => mintNetwork(mint) === "mainnet" || fakesLightning(mint));
      if (!mints.length) throw new Error(BITCOIN_INVOICE_ON_TESTNET);
    }
    for (const mint of mints) {
      try {
        const wallet = await this.wallet(mint);
        const quote = await wallet.createMeltQuoteBolt11(invoice.trim());
        const amount = quote.amount.toNumber();
        const feeReserve = quote.fee_reserve.toNumber();
        if ((await this.balanceAt(mint)) < amount + feeReserve) {
          lastError = engineError("notEnoughSats");
          continue;
        }
        return { quote: quote.quote, mint, amount, feeReserve };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Pays a melt quote. True once paid; false while the mint holds the payment pending, in which case its
   * proofs stay reserved and the wallet keeps asking until the mint settles it (`onMeltResolved`).
   * Throws only when the sats never left the wallet or are known to be back in it.
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
    const quote = await wallet.checkMeltQuoteBolt11(quoteId);
    const inFlight = await wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());
    if (inFlight.some((m) => m.quote === quote.quote || m.request === quote.request)) throw new Error("This invoice is already being paid");
    const needed = quote.amount.toNumber() + quote.fee_reserve.toNumber();
    const { inputs, keep, send, swap } = await this.split(mint, needed, await this.proofsAt(mint));
    let preview: MeltPreview<MeltQuoteBolt11Response>;
    try {
      preview = await wallet.prepareMelt("bolt11", quote, send);
    } catch (error) {
      // Nothing reached the melt: what the swap returned is all spendable.
      await transact([STORES.proofs, STORES.swaps], (stores) => {
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
      createdAt: Date.now(),
    };
    // Written down before the mint sees the proofs: from here on they may be spent, or come back.
    await transact([STORES.proofs, STORES.melts, STORES.swaps], (stores) => {
      this.queueReplace(stores[STORES.proofs], mint, inputs, keep);
      for (const p of send) stores[STORES.proofs].put(toStored(mint, p, true));
      stores[STORES.melts].put(melt);
      if (swap) stores[STORES.swaps].delete(swap.id);
    });

    let result: MeltProofsResponse<MeltQuoteBolt11Response>;
    try {
      result = await wallet.completeMelt(preview);
    } catch (error) {
      // A dropped connection or a gateway timeout says nothing: the payment may still be going through.
      if (!isMintOperationError(error) && !(error instanceof MeltChangeError)) return "pending";
      // The mint answered (a refusal), or took the proofs and only the change failed: its word decides.
      const outcome = await this.settleMelt(melt).catch((): MeltOutcome => "pending");
      if (outcome === "unpaid") {
        // The mint's refusal ("Invoice already paid") stays what the person reads, with what it cost them.
        const lost = this.takeFailedFee(melt.quote);
        if (lost > 0) throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)} ${backInWallet(lost)}`), { cause: error });
        throw error;
      }
      return outcome;
    }
    if (result.quote.state === "PAID") {
      await this.finishMelt(melt, result.change);
      return "paid";
    }
    return this.settleMelt(melt).catch((): MeltOutcome => "pending");
  }

  /**
   * Whether a Lightning payment of this invoice is written down as in flight. A melt is written before the mint sees
   * its proofs, and `pollMelts` settles and reports it: an invoice with none never reached the mint's melt, or is done.
   */
  async meltInFlight(invoice: string): Promise<boolean> {
    const melts = await wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());
    return melts.some((m) => m.request === invoice);
  }

  /** Lightning payments left pending, asked about again until the mint settles each one. */
  private async pollMelts(): Promise<void> {
    if (this.meltTimer) clearTimeout(this.meltTimer);
    this.meltTimer = null;
    const melts = await wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());

    for (const melt of melts) {
      try {
        const outcome = await this.locked(melt.mint, async () => {
          // It may have been settled while this waited for the lock.
          const current = await wrap<PendingMelt | undefined>((await store(STORES.melts, "readonly")).get(melt.quote));
          return current ? this.settleMelt(current) : null;
        });
        if (outcome === "paid" || outcome === "unpaid") {
          this.takeFailedFee(melt.quote);
          this.events.onMeltResolved(melt, outcome === "paid");
          this.events.onChange();
        }
      } catch {
        // mint unreachable: try again on the next round
      }
    }

    const remaining = await wrap((await store(STORES.melts, "readonly")).count());
    if (remaining > 0) this.meltTimer = setTimeout(() => void this.pollMelts(), MELT_POLL_MS);
  }

  /**
   * Asks the mint where a recorded melt stands and books the answer. Paid: the reserved proofs are gone and
   * the change is ours. Unpaid: what the mint says is unspent is spendable again. Pending: nothing moves.
   * Throws when the mint cannot be asked, and the melt stays as it is.
   */
  private async settleMelt(melt: PendingMelt): Promise<MeltOutcome> {
    const wallet = await this.wallet(melt.mint);
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

    // UNPAID: the payment failed, or never started. The mint says which proofs are still unspent.
    const inputs = await this.reservedProofs(melt);
    const states = inputs.length > 0 ? await wallet.checkProofsStates(inputs) : [];
    if (states.some((s) => s.state === "PENDING")) return "pending";
    const spent = new Set(inputs.filter((_, i) => states[i]?.state === "SPENT").map((p) => p.secret));
    if (spent.size > 0) console.warn(`[wallet] melt ${melt.quote} is unpaid, yet ${spent.size} of its proofs are spent`);
    // What left the balance for this payment and does not come back: the fee of the split that made its exact proofs
    // (the mint keeps it whether the payment goes or not), and any proof it spent anyway. In the history, never silent.
    const lost = melt.outlay - inputs.filter((p) => !spent.has(p.secret)).reduce((sum, p) => sum + p.amount, 0);
    await transact([STORES.proofs, STORES.melts, ...(lost > 0 ? [STORES.walletTx] : [])], (stores) => {
      for (const p of inputs) {
        if (spent.has(p.secret)) stores[STORES.proofs].delete(p.secret);
        else stores[STORES.proofs].put({ ...p, reserved: false } satisfies StoredProof);
      }
      stores[STORES.melts].delete(melt.quote);
      if (lost > 0) stores[STORES.walletTx].put(walletTx(melt.mint, "fee", 0, lost, melt.note ? `Payment failed: ${melt.note}` : "A Lightning payment failed"));
    });
    if (lost > 0) this.failedFees.set(melt.quote, lost);
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
    await transact([STORES.proofs, STORES.melts, STORES.walletTx], (stores) => {
      for (const secret of melt.secrets) stores[STORES.proofs].delete(secret);
      for (const p of change) stores[STORES.proofs].put(toStored(melt.mint, p));
      stores[STORES.melts].delete(melt.quote);
      stores[STORES.walletTx].put(tx);
    });
  }

  /**
   * The person removes the Cashu wallet of a network (the engine checked what it holds and what it still waits for,
   * claimed what was already paid, and the person confirmed the rest): the ecash held at its mints, reserved or not,
   * and every invoice of theirs are deleted. A Lightning payment still in flight from one of them is not cut off: the
   * removal is refused until it settles.
   */
  async forget(mints: readonly string[]): Promise<void> {
    const at = new Set(mints);
    const melts = await wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());
    if (melts.some((m) => at.has(m.mint))) throw new Error("A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet.");
    // A swap still written down may hold ecash of these mints: they are asked once more before it goes with the rest.
    await this.pollSwaps(mints).catch(() => {});
    const proofs = (await this.allProofs()).filter((p) => at.has(p.mint));
    const quotes = (await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll())).filter((q) => at.has(q.mint));
    const swaps = (await wrap<PendingSwap[]>((await store(STORES.swaps, "readonly")).getAll())).filter((s) => at.has(s.mint));
    await transact([STORES.proofs, STORES.quotes, STORES.swaps], (stores) => {
      for (const p of proofs) stores[STORES.proofs].delete(p.secret);
      for (const q of quotes) stores[STORES.quotes].delete(q.quote);
      for (const s of swaps) stores[STORES.swaps].delete(s.id);
    });
    for (const mint of mints) { this.wallets.delete(mint); this.names.delete(mint); this.infos.delete(mint); }
  }

  private async reservedProofs(melt: PendingMelt): Promise<StoredProof[]> {
    const secrets = new Set(melt.secrets);
    return (await this.allProofs()).filter((p) => secrets.has(p.secret));
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
        token: getEncodedToken({ mint, proofs: proofs as unknown as Proof[], unit: UNIT }),
      });
    }
    return out;
  }

  // -- storage -----------------------------------------------------------------

  private wallet(mint: string): Promise<Wallet> {
    let wallet = this.wallets.get(mint);
    if (!wallet) {
      wallet = (async () => {
        const instance = new Wallet(mint, { unit: UNIT });
        await within(MINT_TIMEOUT_MS, instance.loadMint(), mint);
        return instance;
      })();
      this.wallets.set(mint, wallet);
      wallet.catch(() => this.wallets.delete(mint));
    }
    return wallet;
  }

  /** One operation per mint at a time: two swaps must never pick the same proofs. */
  private locked<T>(mint: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(mint) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(
      mint,
      next.catch(() => {}),
    );
    return next;
  }

  private async allProofs(): Promise<StoredProof[]> {
    return wrap((await store(STORES.proofs, "readonly")).getAll());
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
