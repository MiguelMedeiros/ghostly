import { Wallet, getEncodedToken, getTokenMetadata, type Proof, type ProofLike } from "@cashu/cashu-ts";
import { STORES, store, wrap } from "../shared/idb";
import type { MintInfoView, MintView, StoredProof, StoredQuote, WalletTx, WalletTxKind, WalletView } from "../shared/types";

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
const MAX_AMOUNT = 1_000_000;
const HISTORY_SHOWN = 100;

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

export interface WalletEvents {
  onChange(): void;
  /** An invoice of ours was paid and its ecash is in the wallet. */
  onQuotePaid(quote: StoredQuote): void;
}

export class CashuWallet {
  private readonly wallets = new Map<string, Promise<Wallet>>();
  private readonly names = new Map<string, string>();
  private readonly infos = new Map<string, MintInfoView>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private quoteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getMints: () => string[],
    private readonly events: WalletEvents,
  ) {}

  start(): void {
    void this.pollQuotes();
    // Names, fees and limits for the UI; a mint that is down simply stays without them.
    for (const mint of this.getMints()) void this.checkMint(mint).then(() => this.events.onChange(), () => {});
  }

  async view(): Promise<WalletView> {
    const proofs = await this.allProofs();
    const mints: MintView[] = this.getMints().map((url) => ({
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
    const wallet = await this.wallet(normalized);
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

  async receiveLightning(amount: number, paymentId?: string): Promise<StoredQuote> {
    assertAmount(amount);
    // The primary mint comes first; if it is down the next one takes the invoice.
    let created: { mint: string; response: Awaited<ReturnType<Wallet["createMintQuoteBolt11"]>> } | null = null;
    let lastError: unknown = new Error("No mint configured");
    for (const candidate of this.getMints()) {
      try {
        created = { mint: candidate, response: await (await this.wallet(candidate)).createMintQuoteBolt11(amount, "Ghostly") };
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

  /** Invoices are paid by someone else, somewhere else; all we can do is ask the mint. */
  private async pollQuotes(): Promise<void> {
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    this.quoteTimer = null;
    const quotes = await wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());

    for (const quote of quotes) {
      try {
        if (quote.expiresAt && quote.expiresAt + 60_000 < Date.now()) {
          await wrap((await store(STORES.quotes, "readwrite")).delete(quote.quote));
          continue;
        }
        const wallet = await this.wallet(quote.mint);
        const { state } = await wallet.checkMintQuoteBolt11(quote.quote);
        if (state === "UNPAID") continue;
        if (state === "PAID") {
          await this.locked(quote.mint, async () => {
            const proofs = await wallet.mintProofsBolt11(quote.amount, quote.quote);
            await this.putProofs(quote.mint, proofs);
            const minted = total(proofs.map((p) => ({ amount: p.amount.toNumber() })));
            await this.record(quote.mint, "lightning-in", minted, quote.amount - minted, quote.paymentId ? "Request paid over Lightning" : undefined);
          });
        }
        await wrap((await store(STORES.quotes, "readwrite")).delete(quote.quote));
        if (state === "PAID") {
          this.events.onQuotePaid(quote);
          this.events.onChange();
        }
      } catch {
        // mint unreachable: try again on the next round
      }
    }

    const remaining = await wrap((await store(STORES.quotes, "readonly")).count());
    if (remaining > 0) this.quoteTimer = setTimeout(() => void this.pollQuotes(), QUOTE_POLL_MS);
  }

  // -- ecash out and in --------------------------------------------------------

  /**
   * Takes `amount` out of the wallet as a token, from the first of `preferred`
   * (or of the user's mints) that holds enough. The receiver's redeem fee is
   * included, so they are credited the full amount.
   */
  async createToken(amount: number, preferred?: string[], note?: string): Promise<{ token: string; mint: string }> {
    assertAmount(amount);
    const mine = this.getMints();
    const candidates = preferred ? preferred.map((m) => m.replace(/\/+$/, "")).filter((m) => mine.includes(m)) : mine;
    for (const mint of candidates) {
      if ((await this.balanceAt(mint)) < amount) continue;
      return this.locked(mint, async () => {
        const wallet = await this.wallet(mint);
        const proofs = await this.proofsAt(mint);
        const { keep, send } = await wallet.send(amount, asProofLike(proofs), { includeFees: true });
        await this.replaceProofs(mint, proofs, keep);
        // Everything that left the balance beyond the amount: the swap's fee and the redeem fee prepaid for the receiver.
        const spent = total(proofs) - total(keep.map((p) => ({ amount: p.amount.toNumber() })));
        await this.record(mint, "ecash-out", amount, spent - amount, note);
        this.events.onChange();
        return { token: getEncodedToken({ mint, proofs: send, unit: UNIT }), mint };
      });
    }
    throw new Error(
      candidates.length === 0 && preferred ? "You share no mint with this contact" : "Not enough sats in your wallet",
    );
  }

  /** Redeems a token into fresh proofs of our own. Until this succeeds the sender could still spend it. */
  async receiveToken(token: string, kind: WalletTxKind = "ecash-in", note?: string): Promise<{ amount: number; mint: string }> {
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
    if (!this.getMints().includes(mint)) throw new Error(`Ecash from ${new URL(mint).hostname} is not accepted`);

    return this.locked(mint, async () => {
      const wallet = await this.wallet(mint);
      const proofs = await wallet.receive(token);
      await this.putProofs(mint, proofs);
      const credited = total(proofs.map((p) => ({ amount: p.amount.toNumber() })));
      // A sender that prepaid the redeem fee put it on top of the amount; what the mint kept is the fee either way.
      await this.record(mint, kind, credited, Math.max(0, faceValue - credited), note);
      this.events.onChange();
      return { amount: credited, mint };
    });
  }

  // -- Lightning out -----------------------------------------------------------

  /** What paying this invoice would cost, from the first mint that can afford it. */
  async quoteInvoice(invoice: string): Promise<{ quote: string; mint: string; amount: number; feeReserve: number }> {
    let lastError: unknown = new Error("Add a mint in Settings first");
    for (const mint of this.getMints()) {
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

  async payQuote(quoteId: string, mint: string, note?: string): Promise<boolean> {
    return this.locked(mint, async () => {
      const wallet = await this.wallet(mint);
      const quote = await wallet.checkMeltQuoteBolt11(quoteId);
      const needed = quote.amount.toNumber() + quote.fee_reserve.toNumber();
      const proofs = await this.proofsAt(mint);
      const before = total(proofs);
      const { keep, send } = await wallet.send(needed, asProofLike(proofs), { includeFees: true });
      await this.replaceProofs(mint, proofs, keep);
      try {
        const result = await wallet.meltProofsBolt11(quote, send);
        await this.putProofs(mint, result.change);
        const paid = result.quote.state === "PAID";
        if (paid) {
          // The reserve is an upper bound; the mint returns what the route did not cost as change.
          const invoiceAmount = quote.amount.toNumber();
          await this.record(mint, "lightning-out", invoiceAmount, before - (await this.balanceAt(mint)) - invoiceAmount, note);
        }
        return paid;
      } catch (error) {
        // The payment did not go out: the proofs set aside for it are still ours.
        await this.putProofs(mint, send);
        throw error;
      } finally {
        this.events.onChange();
      }
    });
  }

  async exportTokens(): Promise<{ mint: string; token: string; amount: number }[]> {
    const out: { mint: string; token: string; amount: number }[] = [];
    for (const mint of new Set((await this.allProofs()).map((p) => p.mint))) {
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

  private async record(mint: string, kind: WalletTxKind, amount: number, fee: number, note?: string): Promise<void> {
    const tx: WalletTx = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      mint,
      kind,
      amount,
      fee: Math.max(0, fee),
      note: note?.slice(0, 140),
    };
    await wrap((await store(STORES.walletTx, "readwrite")).put(tx));
  }

  private wallet(mint: string): Promise<Wallet> {
    let wallet = this.wallets.get(mint);
    if (!wallet) {
      wallet = (async () => {
        const instance = new Wallet(mint, { unit: UNIT });
        await instance.loadMint();
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

  private async putProofs(mint: string, proofs: Proof[]): Promise<void> {
    if (proofs.length === 0) return;
    const proofStore = await store(STORES.proofs, "readwrite");
    await Promise.all(
      proofs.map((p) =>
        wrap(
          proofStore.put({
            mint,
            id: p.id,
            amount: p.amount.toNumber(),
            secret: p.secret,
            C: p.C,
            dleq: p.dleq,
          } satisfies StoredProof),
        ),
      ),
    );
  }

  /** After a swap: the inputs are spent, `keep` is what came back to us. One transaction, so it is all or nothing. */
  private async replaceProofs(mint: string, inputs: StoredProof[], keep: Proof[]): Promise<void> {
    const kept = new Set(keep.map((p) => p.secret));
    const proofStore = await store(STORES.proofs, "readwrite");
    const work: Promise<unknown>[] = inputs.filter((p) => !kept.has(p.secret)).map((p) => wrap(proofStore.delete(p.secret)));
    for (const p of keep) {
      work.push(
        wrap(proofStore.put({ mint, id: p.id, amount: p.amount.toNumber(), secret: p.secret, C: p.C, dleq: p.dleq } satisfies StoredProof)),
      );
    }
    await Promise.all(work);
  }
}
