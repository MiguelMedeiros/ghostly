import { PaymentPreflightError, assertWholeSats, validatePaymentTarget, type PaymentAdapter, type PaymentExecution, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import type { StoredPayment } from "../../shared/types";
import { NOTES_REFUND_SECS, type FedimintWallet } from "./fedimintWallet";

/** What a review approved: the federation and the amount. Nothing is spent before approval. */
export interface FedimintPrepared { federation: string; amount: number }

/** What the adapter needs of the chat desk: the payment record it writes before spending, and the chat. */
export interface FedimintPublisher {
  /** The chat's record of this payment, if any. */
  payment(id: string): StoredPayment | undefined;
  /** Writes the payment down (pending, no notes yet) before anything is spent. */
  journal(review: PaymentReview): Promise<void>;
  /** The notes exist: kept with the payment (they are the money until redeemed), said in the chat, sent to the contact. */
  publish(review: PaymentReview, notes: string, operationId: string): Promise<void>;
  /** Sends the same notes again (a lost frame); never new ones. */
  republish(review: PaymentReview): Promise<void>;
  /** The notes were taken back before they reached the contact (an interruption between spending and sending). */
  withdrawn(review: PaymentReview, reason: string): Promise<void>;
}

/**
 * Federation ecash in a chat, through the shared review → approve → execute contract. Paying is spending notes
 * of the reviewed federation and sending them to the contact; they are the money until the contact redeems them,
 * so they are written down with the payment before they leave, and taken back if the contact refuses them or
 * never redeems them (the federation also gives them back by itself after a week).
 *
 * The payment settles on the contact's answer (it redeemed them); the federation cannot tell the payer who
 * redeemed notes, only that someone did, which taking them back reveals.
 */
export class FedimintAdapter implements PaymentAdapter<FedimintPrepared> {
  readonly method = "fedimint" as const;
  constructor(private readonly wallet: FedimintWallet, private readonly desk: FedimintPublisher) {}

  async prepare(target: PaymentTarget, amount: number, feeCap: number) {
    validatePaymentTarget(target); assertWholeSats(amount);
    if (target.method !== "fedimint") throw new Error("Not a Fedimint payment");
    const federation = this.wallet.federation(target.provider);
    if (!federation || federation.network !== target.network) throw new Error("You have not joined this federation in the Fedimint wallet of its network");
    if (!Number.isSafeInteger(feeCap) || feeCap < 0) throw new Error("Invalid maximum fee");
    const balance = Math.floor(await this.wallet.client(target.provider).balance() / 1000);
    if (balance < amount) throw new Error(`Not enough in this federation: ${balance.toLocaleString()} sats`);
    // Spending notes costs nothing; the contact pays the federation's fee when redeeming them.
    return { fee: 0, prepared: { federation: target.provider, amount } };
  }

  async execute(review: PaymentReview, prepared: FedimintPrepared, persist?: () => Promise<void>): Promise<PaymentExecution> {
    if (!review.linkId) throw new PaymentPreflightError("Fedimint ecash goes to a contact in a chat");
    if (prepared.federation !== review.provider || prepared.amount !== review.amount) throw new PaymentPreflightError("The prepared payment does not match the review");
    const client = this.wallet.client(review.provider);
    if (Math.floor(await client.balance() / 1000) < review.amount) throw new PaymentPreflightError("Not enough in this federation any more");
    // Submitted, and in the chat's journal, before the notes exist: whatever happens next is only ever reconciled.
    await persist?.();
    await this.desk.journal(review);
    const { notes, operationId } = await client.spend(review.amount * 1000, { cancelAfterSecs: NOTES_REFUND_SECS, ghostly: review.id });
    await this.desk.publish(review, notes, operationId);
    return { settled: false, pending: true };
  }

  async reconcile(review: PaymentReview): Promise<PaymentExecution> {
    const payment = this.desk.payment(review.id);
    if (payment?.state === "settled") return { settled: true };
    if (payment?.state === "reclaimed") return { settled: false, failed: true, error: "Taken back: the sats are in your wallet again" };
    if (payment?.token) {
      // Still waiting on the contact: the same notes again, in case the first frame was lost.
      await this.desk.republish(review).catch(() => {});
      return { settled: false, pending: true };
    }
    // No notes in the journal: interrupted between asking the federation and writing them down. Whatever it made
    // is taken back; nothing reached the contact.
    const spend = await this.wallet.spendFor(review.provider, review.id);
    if (!spend) return { settled: false, failed: true, error: "Nothing was spent" };
    const state = await this.wallet.takeBack(review.provider, spend.id);
    if (state === "pending") return { settled: false, pending: true };
    await this.desk.withdrawn(review, state === "canceled" ? "Interrupted before it reached your contact: the sats came back" : "Redeemed by someone");
    return state === "canceled" ? { settled: false, failed: true, error: "Interrupted before it reached your contact: the sats came back" } : { settled: true };
  }
}
