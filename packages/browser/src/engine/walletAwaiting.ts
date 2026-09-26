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
  /** This network's active Lightning source: the Cashu mints unless the person chose another. */
  lightningSource?: string;
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
export function walletAwaiting({ network, mints, quotes, lightningOps, lightningSource, payments, now }: AwaitingSources): WalletAwaitingView[] {
  const at = new Set(mints);
  const live = (expiresAt: number | null | undefined) => !expiresAt || expiresAt + GRACE_MS > now;
  const invoiceKey = (invoice: string) => invoice.trim().toLowerCase();

  const cashuQuotes = quotes.filter((q) => at.has(q.mint) && !q.testCoins);
  const claimedBy = new Set<string>();
  const out: WalletAwaitingView[] = [];
  for (const q of cashuQuotes) {
    if (!q.issuedUnclaimed && !q.paid) continue;
    out.push({ type: "cashu", kind: q.issuedUnclaimed ? "unclaimed" : "paid", amount: q.amount, ...(q.paymentId ? { paymentId: q.paymentId } : {}) });
    if (q.paymentId) claimedBy.add(q.paymentId);
  }
  const openQuotes = cashuQuotes.filter((q) => !q.issuedUnclaimed && !q.paid && live(q.expiresAt));
  const cashuInvoices = new Set(openQuotes.map((q) => invoiceKey(q.invoice)));
  const openOps = lightningOps.filter((op) => op.direction === "in" && op.mode === network && op.state === "open" && !op.selfSettled && op.providerId !== CASHU_MINT_SOURCE && live(op.expiresAt));
  const lightningInvoices = new Set(openOps.map((op) => invoiceKey(op.invoice)));

  /** The wallets a request of ours can still be paid through. */
  const ways = (p: StoredPayment): Set<WalletType> => {
    const through = new Set<WalletType>();
    if (p.target?.method === "fedimint" || p.federations) { through.add("fedimint"); return through; }
    if (p.target && TARGETED.has(p.target.method as WalletType)) { through.add(p.target.method as WalletType); return through; }
    if (p.invoice) {
      const key = invoiceKey(p.invoice);
      if (cashuInvoices.has(key)) through.add("cashu");
      else if (lightningInvoices.has(key)) through.add("lightning");
      else {
        // Not in a journal (made before sources journaled their invoices): the source of the network makes them.
        const decoded = decodeBolt11(p.invoice);
        if (decoded && live(decoded.expiresAt * 1000)) through.add((lightningSource ?? CASHU_MINT_SOURCE) === CASHU_MINT_SOURCE ? "cashu" : "lightning");
      }
    }
    if (p.mints?.some((m) => at.has(m))) through.add("cashu");
    return through;
  };

  const requests = new Set<string>();
  for (const p of payments) {
    if (p.kind !== "request" || p.direction !== "out" || p.state !== "pending" || p.closed || paymentNetwork(p) !== network) continue;
    requests.add(p.id);
    if (claimedBy.has(p.id)) continue;
    const through = ways(p);
    if (through.size !== 1) continue;
    out.push({ type: [...through][0], kind: "request", amount: p.amount, paymentId: p.id });
  }
  // Invoices of no open request: made on the wallet's Receive, or of a request already closed.
  for (const q of openQuotes) if (!q.paymentId || !requests.has(q.paymentId)) out.push({ type: "cashu", kind: "invoice", amount: q.amount, ...(q.paymentId ? { paymentId: q.paymentId } : {}) });
  for (const op of openOps) if (!op.paymentId || !requests.has(op.paymentId)) out.push({ type: "lightning", kind: "invoice", amount: op.amount, ...(op.paymentId ? { paymentId: op.paymentId } : {}) });

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
