import {
  Amount,
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
import type { PaymentReview, WalletNetwork } from "@ghostly/core";
import { isTestMint } from "../shared/mints";
import type {
  CashuInspection,
  MintInfoView,
  MintView,
  PendingMelt,
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
 */
const UNIT = "sat";
const QUOTE_POLL_MS = 4_000;
/** A Lightning payment can stay in flight for minutes or hours; the mint is asked again this often. */
const MELT_POLL_MS = 30_000;
const MAX_AMOUNT = 1_000_000;
const HISTORY_SHOWN = 100;
export interface CashuPrepared {mint:string;swap:SerializedSwapPreview;token?:string}

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

export function normalizeMintUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("That is not a valid mint URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Mints must use https");
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

export interface WalletEvents {
  onChange(): void;
  /** Ecash arrived from the public test mint, which this wallet did not have yet. */
  onTestMintNeeded(mint: string): Promise<void>;
  /** An invoice of ours was paid and its ecash is in the wallet. */
  onQuotePaid(quote: StoredQuote): void;
  /** A Lightning payment the mint had left pending settled, one way or the other. */
  onMeltResolved(melt: PendingMelt, paid: boolean): void;
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

  /** Talks to the mint before it is added: a typo should not become a place to keep money. */
  async checkMint(url: string): Promise<{ url: string; name: string }> {
    const normalized = normalizeMintUrl(url);
    let wallet: Wallet;
    try { wallet = await this.wallet(normalized); }
    catch (error) {
      // "Failed to fetch" says nothing to a person: say which place did not answer, and what it should be.
      throw Object.assign(new Error(`Could not reach ${new URL(normalized).host}. Check the address: it should be a Cashu mint.`), { cause: error });
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
    };
    await wrap((await store(STORES.quotes, "readwrite")).put(quote));
    void this.pollQuotes();
    return quote;
  }

  /** Asks the mints about the open invoices now, without waiting for the next round. */
  checkQuotes(): Promise<void> { return this.pollQuotes(); }

  /**
   * Invoices are paid by someone else, somewhere else; all we can do is ask the mint. A quote is the only
   * claim on the sats paid to it, so it is dropped only once the mint says it is unpaid and it has expired.
   */
  private async pollQuotes(): Promise<void> {
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    this.quoteTimer = null;
    const quotes = await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());

    for (const { quote, mint } of quotes.filter((q) => !q.issuedUnclaimed)) {
      try {
        const paid = await this.locked(mint, () => this.settleQuote(quote));
        if (paid) {
          this.events.onQuotePaid(paid);
          this.events.onChange();
        }
      } catch {
        // mint unreachable: try again on the next round
      }
    }

    const remaining = await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());
    if (remaining.some((q) => !q.issuedUnclaimed)) this.quoteTimer = setTimeout(() => void this.pollQuotes(), QUOTE_POLL_MS);
  }

  /** Runs under the mint's lock, so two rounds never mint one quote twice. Returns the quote once its ecash is in. */
  private async settleQuote(id: string): Promise<StoredQuote | null> {
    // Another round may have settled it while this one waited for the lock.
    const quote = await wrap<StoredQuote | undefined>((await store(STORES.quotes, "readonly")).get(id));
    if (!quote || quote.issuedUnclaimed) return null;
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

    const proofs = await wallet.mintProofsBolt11(quote.amount, quote.quote);
    const minted = sats(proofs);
    const tx = walletTx(quote.mint, "lightning-in", minted, quote.amount - minted, quote.paymentId ? "Request paid over Lightning" : undefined);
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
    // A request names its mints, and so its network; a send without one comes from this network's mints.
    const mine = preferred ? this.getKnownMints() : this.getMints(network);
    const candidates = preferred ? preferred.map((m) => m.replace(/\/+$/, "")).filter((m) => mine.includes(m)) : mine;
    for (const mint of candidates) {
      if ((await this.balanceAt(mint)) < amount) continue;
      return this.locked(mint, async () => {
        const wallet = await this.wallet(mint);
        const proofs = await this.proofsAt(mint);
        const { keep, send } = await wallet.send(amount, asProofLike(proofs), { includeFees: true });
        const token = getEncodedToken({ mint, proofs: send, unit: UNIT });
        // Everything that left the balance beyond the amount: the swap's fee and the redeem fee prepaid for the receiver.
        const spent = total(proofs) - sats(keep);
        const tx = walletTx(mint, "ecash-out", amount, spent - amount, note);
        const kept = outbox?.(token, mint);
        await transact([STORES.proofs, STORES.walletTx, ...(kept ? [STORES.payments] : [])], (stores) => {
          this.queueReplace(stores[STORES.proofs], mint, proofs, keep);
          stores[STORES.walletTx].put(tx);
          if (kept) stores[STORES.payments].put(kept);
        });
        this.events.onChange();
        return { token, mint };
      });
    }
    throw new Error(
      candidates.length === 0 && preferred ? "You share no mint with this contact" : "Not enough sats in your wallet",
    );
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
      if(prepared.mint!==review.provider || preview.amount.toNumber()!==review.amount || reviewedCashuFee(preview)!==review.fee)throw new Error("Cashu preview does not match review");
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
        tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(new Error("Prepared Cashu inputs are no longer available"));
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
    return this.finishReviewedCashu(review,prepared,restored.slice(0,keep.length),restored.slice(keep.length));
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
      const wallet = await this.wallet(mint);
      const proofs = await wallet.receive(token);
      const credited = sats(proofs);
      // A sender that prepaid the redeem fee put it on top of the amount; what the mint kept is the fee either way.
      const tx = walletTx(mint, kind, credited, Math.max(0, faceValue - credited), note);
      await transact([STORES.proofs, STORES.walletTx, ...(payment ? [STORES.payments] : [])], (stores) => {
        for (const p of proofs) stores[STORES.proofs].put(toStored(mint, p));
        stores[STORES.walletTx].put(tx);
        if (payment) stores[STORES.payments].put(payment(credited, mint));
      });
      this.events.onChange();
      return { amount: credited, mint };
    });
  }

  // -- Lightning out -----------------------------------------------------------

  /** What paying this invoice would cost, from the first mint that can afford it. */
  async quoteInvoice(invoice: string, network?: WalletNetwork): Promise<{ quote: string; mint: string; amount: number; feeReserve: number }> {
    let lastError: unknown = new Error("Add a mint in Settings first");
    for (const mint of this.getMints(network)) {
      try {
        const wallet = await this.wallet(mint);
        const quote = await wallet.createMeltQuoteBolt11(invoice.trim());
        const amount = quote.amount.toNumber();
        const feeReserve = quote.fee_reserve.toNumber();
        if ((await this.balanceAt(mint)) < amount + feeReserve) {
          lastError = new Error("Not enough sats in your wallet");
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
      if (outcome === "unpaid") throw new Error("The Lightning payment did not go through. The sats are back in your wallet.");
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
    const proofs = await this.proofsAt(mint);
    const { keep, send } = await wallet.send(needed, asProofLike(proofs), { includeFees: true });
    let preview: MeltPreview<MeltQuoteBolt11Response>;
    try {
      preview = await wallet.prepareMelt("bolt11", quote, send);
    } catch (error) {
      // Nothing reached the melt: what the swap returned is all spendable.
      await this.replaceProofs(mint, proofs, [...keep, ...send]);
      throw error;
    }

    const melt: PendingMelt = {
      quote: quote.quote,
      mint,
      request: quote.request,
      amount: quote.amount.toNumber(),
      secrets: send.map((p) => p.secret),
      outlay: total(proofs) - sats(keep),
      outputs: preview.outputData.map((o) => OutputData.serialize(o)),
      note: note?.slice(0, 140),
      paymentId,
      createdAt: Date.now(),
    };
    // Written down before the mint sees the proofs: from here on they may be spent, or come back.
    await transact([STORES.proofs, STORES.melts], (stores) => {
      this.queueReplace(stores[STORES.proofs], mint, proofs, keep);
      for (const p of send) stores[STORES.proofs].put(toStored(mint, p, true));
      stores[STORES.melts].put(melt);
    });

    let result: MeltProofsResponse<MeltQuoteBolt11Response>;
    try {
      result = await wallet.completeMelt(preview);
    } catch (error) {
      // A dropped connection or a gateway timeout says nothing: the payment may still be going through.
      if (!isMintOperationError(error) && !(error instanceof MeltChangeError)) return "pending";
      // The mint answered (a refusal), or took the proofs and only the change failed: its word decides.
      const outcome = await this.settleMelt(melt).catch((): MeltOutcome => "pending");
      if (outcome === "unpaid") throw error;
      return outcome;
    }
    if (result.quote.state === "PAID") {
      await this.finishMelt(melt, result.change);
      return "paid";
    }
    return this.settleMelt(melt).catch((): MeltOutcome => "pending");
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
    await transact([STORES.proofs, STORES.melts], (stores) => {
      for (const p of inputs) {
        if (spent.has(p.secret)) stores[STORES.proofs].delete(p.secret);
        else stores[STORES.proofs].put({ ...p, reserved: false } satisfies StoredProof);
      }
      stores[STORES.melts].delete(melt.quote);
    });
    return "unpaid";
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
   * The person removes the Cashu wallet of a network (the engine checked what it holds and what they confirmed): the
   * ecash held at its mints, reserved or not, and their unpaid invoices are deleted. A Lightning payment still in
   * flight from one of them is not cut off: the removal is refused until it settles.
   */
  async forget(mints: readonly string[]): Promise<void> {
    const at = new Set(mints);
    const melts = await wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());
    if (melts.some((m) => at.has(m.mint))) throw new Error("A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet.");
    const proofs = (await this.allProofs()).filter((p) => at.has(p.mint));
    const quotes = (await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll())).filter((q) => at.has(q.mint));
    await transact([STORES.proofs, STORES.quotes], (stores) => {
      for (const p of proofs) stores[STORES.proofs].delete(p.secret);
      for (const q of quotes) stores[STORES.quotes].delete(q.quote);
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

  /** After a swap: the inputs are spent, `keep` is what came back to us. One transaction, so it is all or nothing. */
  private async replaceProofs(mint: string, inputs: StoredProof[], keep: Proof[]): Promise<void> {
    await transact([STORES.proofs], (stores) => this.queueReplace(stores[STORES.proofs], mint, inputs, keep));
  }

  private queueReplace(proofStore: IDBObjectStore, mint: string, inputs: StoredProof[], keep: Proof[]): void {
    const kept = new Set(keep.map((p) => p.secret));
    for (const p of inputs) if (!kept.has(p.secret)) proofStore.delete(p.secret);
    for (const p of keep) proofStore.put(toStored(mint, p));
  }
}
