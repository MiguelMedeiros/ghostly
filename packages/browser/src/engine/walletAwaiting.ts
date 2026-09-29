import { decodeBolt11, type WalletNetwork } from "@ghostly/core";
import type { StoredPayment, StoredQuote, WalletAwaitingView, WalletType } from "../shared/types";
import { paymentNetwork } from "./paymentAdapters/walletInstances";
import { CASHU_MINT_SOURCE } from "./paymentAdapters/providers/cashuMint";
import type { LightningOp } from "./paymentAdapters/providers/lightningService";

/** What one network's wallets are read from to tell what they still wait for. */
export interface AwaitingSources {
  network: WalletNetwork;
  /** This network's Cashu mints: the Cashu wallet. */
  mints: readonly string[];
  /** Every stored Cashu quote (every network's). */
  quotes: readonly StoredQuote[];
  /** The Lightning journal (every network's). */
  lightningOps: readonly LightningOp[];
  /** This network's default Lightning card for receiving, and its source: the Cashu mints unless the person chose another. */
  lightningSource?: string;
  lightningCard?: string;
  /** The Lightning card an operation went through. */
  lightningOwner?: (op: LightningOp) => string | undefined;
  payments: readonly StoredPayment[];
  now: number;
}

/** An invoice or a quote a minute past its expiry can no longer be paid (the mints poll with the same grace). */
const GRACE_MS = 60_000;
const TARGETED = new Set<WalletType>(["arkade", "bark", "spark", "bitcoin", "usdt"]);

/**
 * What the wallets of one network still wait for (see `WalletAwaitingView`): what removing one of them would lose, or
 * close. A request of ours counts only for the wallet it can be paid through, and only when there is one: a request a
 * Cashu mint and another Lightning source can both be paid through is not lost when one of them goes.
 */
export function walletAwaiting({ network, mints, quotes, lightningOps, lightningSource, lightningCard, lightningOwner = (op) => op.card, payments, now }: AwaitingSources): WalletAwaitingView[] {
  const at = new Set(mints);
  const live = (expiresAt: number | null | undefined) => !expiresAt || expiresAt + GRACE_MS > now;
  const invoiceKey = (invoice: string) => invoice.trim().toLowerCase();

  const pending = payments.filter((p) => p.kind === "request" && p.direction === "out" && p.state === "pending" && !p.closed && paymentNetwork(p) === network);
  const requests = new Set(pending.map((p) => p.id));
  // The request an invoice belongs to: named on it, or found by the invoice (the mints' source does not name it).
  const byInvoice = new Map(pending.filter((p) => p.invoice).map((p) => [invoiceKey(p.invoice!), p.id]));
  const ownerOf = (x: { paymentId?: string; invoice: string }) => x.paymentId ?? byInvoice.get(invoiceKey(x.invoice));
  const withOwner = (id: string | undefined) => (id ? { paymentId: id } : {});

  const cashuQuotes = quotes.filter((q) => at.has(q.mint) && !q.testCoins);
  const claimedBy = new Set<string>();
  const out: WalletAwaitingView[] = [];
  for (const q of cashuQuotes) {
    if (!q.issuedUnclaimed && !q.paid) continue;
    const owner = ownerOf(q);
    out.push({ type: "cashu", kind: q.issuedUnclaimed ? "unclaimed" : "paid", amount: q.amount, ...withOwner(owner) });
    if (owner) claimedBy.add(owner);
  }
  const openQuotes = cashuQuotes.filter((q) => !q.issuedUnclaimed && !q.paid && live(q.expiresAt));
  const cashuInvoices = new Set(openQuotes.map((q) => invoiceKey(q.invoice)));
  const openOps = lightningOps.filter((op) => op.direction === "in" && op.mode === network && op.state === "open" && !op.selfSettled && op.providerId !== CASHU_MINT_SOURCE && live(op.expiresAt));
  /** Each open invoice's Lightning card. */
  const lightningInvoices = new Map(openOps.map((op) => [invoiceKey(op.invoice), lightningOwner(op)]));
  const onCard = (card: string | undefined) => (card !== undefined ? { card } : {});
  /** The Lightning card a request of ours goes through, when it is Lightning's. */
  const cardOf = new Map<string, string | undefined>();

  /** The wallets a request of ours can still be paid through. */
  const ways = (p: StoredPayment): Set<WalletType> => {
    const through = new Set<WalletType>();
    if (p.target?.method === "fedimint" || p.federations) { through.add("fedimint"); return through; }
    if (p.target && TARGETED.has(p.target.method as WalletType)) { through.add(p.target.method as WalletType); return through; }
    if (p.invoice) {
      const key = invoiceKey(p.invoice);
      if (cashuInvoices.has(key)) through.add("cashu");
      else if (lightningInvoices.has(key)) { through.add("lightning"); cardOf.set(p.id, lightningInvoices.get(key)); }
      else {
        // Not in a journal (made before sources journaled their invoices): the source of the network makes them.
        const decoded = decodeBolt11(p.invoice);
        const mints = (lightningSource ?? CASHU_MINT_SOURCE) === CASHU_MINT_SOURCE;
        if (decoded && live(decoded.expiresAt * 1000)) { through.add(mints ? "cashu" : "lightning"); if (!mints) cardOf.set(p.id, lightningCard); }
      }
    }
    if (p.mints?.some((m) => at.has(m))) through.add("cashu");
    return through;
  };

  for (const p of pending) {
    if (claimedBy.has(p.id)) continue;
    const through = ways(p);
    if (through.size !== 1) continue;
    const type = [...through][0];
    out.push({ type, kind: "request", amount: p.amount, paymentId: p.id, ...(type === "lightning" ? onCard(cardOf.get(p.id)) : {}) });
  }
  // Invoices of no open request: made on the wallet's Receive, or of a request already closed.
  for (const q of openQuotes) { const owner = ownerOf(q); if (!owner || !requests.has(owner)) out.push({ type: "cashu", kind: "invoice", amount: q.amount, ...withOwner(owner) }); }
  for (const op of openOps) { const owner = ownerOf(op); if (!owner || !requests.has(owner)) out.push({ type: "lightning", kind: "invoice", amount: op.amount, ...withOwner(owner), ...onCard(lightningOwner(op)) }); }

  // Ecash sent that the contact has not taken yet: only the wallet it came from can take it back.
  for (const p of payments) {
    if (p.kind !== "payment" || p.direction !== "out" || p.state !== "pending" || !p.token) continue;
    if (p.target?.method === "fedimint" || p.federation) {
      if (paymentNetwork(p) === network) out.push({ type: "fedimint", kind: "sent", amount: p.amount, paymentId: p.id });
      continue;
    }
    const mint = p.mint ?? (p.target?.method === "cashu" ? p.target.provider : undefined);
    if (mint && at.has(mint)) out.push({ type: "cashu", kind: "sent", amount: p.amount, paymentId: p.id });
  }
  return out;
}
