/**
 * How often an open invoice of ours is asked about, at its Cashu mint or at a Lightning card's source (agents#2447).
 * Someone pays an invoice soon after it is shown, or not at all: it is asked about every few seconds at first, then
 * less and less. Asked every 4 s for the hour a mint or a node keeps it open, an invoice nobody paid cost about 900
 * requests (on NWC each one signed, encrypted and carried by the wallet's relay); on this pace it costs about 100.
 *
 * Whoever knows a payment may have happened asks at once, whatever the pace: a payer's "I paid" (`vouch`), the
 * request's check, a wallet about to be removed. The screen showing an invoice keeps it `watched`, at the fast pace.
 */
export const INVOICE_PACE = {
  /** While the invoice is new, or watched: a payment shows within seconds. */
  fastMs: 4_000,
  fastForMs: 2 * 60_000,
  /** Then, until it is this old. */
  midMs: 15_000,
  midForMs: 5 * 60_000,
  /** From then on, until it expires. */
  slowMs: 60_000,
  /** How long one word from the screen keeps an invoice watched: the screen says it again while it shows it. */
  watchMs: 90_000,
  /** A quote or an invoice goes only this long after its expiry, once its mint or source says it is unpaid. */
  expiryGraceMs: 60_000,
  /** Due this close to now counts as due: a timer may fire a moment before the clock reads its time. */
  dueSlackMs: 250,
} as const;

export interface PacedInvoice {
  createdAt: number;
  /** Null: an invoice that does not expire. */
  expiresAt: number | null;
  /** Until when the screen shows it (`watch`). */
  watchedUntil?: number;
  /**
   * The chat request it is the invoice of was closed (withdrawn, closed, or paid some other way): nobody is meant to
   * pay it any more. It is asked about once more after it expired, so money that came all the same is claimed, and
   * the quote goes.
   */
  closed?: boolean;
  /** The money is there and only its claim is left (a paid quote not minted yet): asked at the fast pace. */
  paid?: boolean;
}

/** When the invoice is next asked about. `asked`: when it was last, in this run; never, it is due now. */
export function nextInvoiceAsk(invoice: PacedInvoice, asked: number | undefined, now: number): number {
  const { fastMs, fastForMs, midMs, midForMs, slowMs, expiryGraceMs } = INVOICE_PACE;
  const fast = invoice.paid || (invoice.watchedUntil ?? 0) > now;
  if (invoice.closed && !fast) {
    if (invoice.expiresAt !== null) return Math.max(asked === undefined ? now : asked + slowMs, invoice.expiresAt + expiryGraceMs + 1);
    return asked === undefined ? now : asked + slowMs;
  }
  if (asked === undefined) return now;
  const age = now - invoice.createdAt;
  return asked + (fast || age < fastForMs ? fastMs : age < midForMs ? midMs : slowMs);
}
