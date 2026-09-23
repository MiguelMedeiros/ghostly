import { PaymentPreflightError, assertTokenUnits, assertWholeSats, validatePaymentTarget, type PaymentAdapter, type PaymentReview, type PaymentTarget } from "@ghostly/core";

export interface SavedIntent { review: PaymentReview; prepared: unknown }
export interface IntentRepository {
  get(id: string): Promise<SavedIntent | undefined>;
  put(intent: SavedIntent): Promise<void>;
  list(): Promise<SavedIntent[]>;
  claim(id: string): Promise<SavedIntent>;
  cancel(id: string): Promise<SavedIntent>;
}
/** Persist-before-spend; a submitted/unknown operation can only be reconciled, never re-executed. */
export class PaymentCoordinator {
  private active = new Map<string, Promise<PaymentReview>>();
  constructor(private repository: IntentRepository, private adapters: PaymentAdapter[], private changed: (review: PaymentReview) => void = () => {}) {}
  async prepare(target: PaymentTarget, amount: number, feeCap: number, context: { payee: string; linkId?: string; requestId?: string; memo?: string }): Promise<PaymentReview> {
    const validated = validatePaymentTarget(target);
    if(validated.method === "usdt")assertTokenUnits(amount);else assertWholeSats(amount);
    if (!Number.isSafeInteger(feeCap) || feeCap < 0) throw new Error("Invalid maximum fee");
    if (context.requestId) {
      const existing = (await this.repository.list()).find(({review:r}) => r.requestId === context.requestId && r.linkId === context.linkId && !["failed", "cancelled"].includes(r.state));
      if (existing) throw new Error("This request already has a payment. Reconcile it before trying again.");
    }
    const adapter = this.adapter(validated.method);
    const {fee,prepared,evm} = await adapter.prepare(validated,amount,feeCap);
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > feeCap) throw new Error("The fee exceeds your limit");
    const review: PaymentReview = {...validated,...context,id:crypto.randomUUID(),amount,fee,feeCap,...(evm ? {evm} : {}),createdAt:Date.now(),state:"pending"};
    await this.repository.put({review,prepared}); this.changed(review); return review;
  }
  approve(id: string): Promise<PaymentReview> { return this.once(id,async () => {
    const saved = await this.require(id);
    if (saved.review.state !== "pending") throw new Error("This payment cannot be submitted again. Reconcile its existing transaction.");
    validatePaymentTarget(saved.review);
    // Atomic claim prevents two tabs/coordinators from spending the same intent.
    const claimed = await this.repository.claim(id);
    saved.review = claimed.review; this.changed(saved.review);
    try {
      const result = await this.adapter(saved.review.method).execute(saved.review,saved.prepared,() => this.repository.put(saved));
      saved.review = {...saved.review,...result,state:result.failed ? "failed" : result.settled ? "settled" : "submitted"};
    } catch (error) {
      // An exception is not proof of a failed spend, even when it looks like a transport error.
      saved.review = {...saved.review,state:error instanceof PaymentPreflightError ? "failed" : "unknown",error:error instanceof PaymentPreflightError ? error.message : "Outcome unknown. Check the existing payment; do not send another."};
    }
    await this.repository.put(saved); this.changed(saved.review); return saved.review;
  }); }
  reconcile(id: string): Promise<PaymentReview> { return this.once(id,async () => {
    const saved = await this.require(id);
    if (!["submitted","unknown"].includes(saved.review.state)) return saved.review;
    try {
      const result = await this.adapter(saved.review.method).reconcile(saved.review,saved.prepared,()=>this.repository.put(saved));
      saved.review = {...saved.review,...result,state:result.failed ? "failed" : result.settled ? "settled" : result.pending ? "submitted" : "unknown",error:result.failed ? result.error : result.settled ? undefined : "Not yet confirmed. No second payment was sent."};
    } catch { saved.review = {...saved.review,state:"unknown",error:"Could not verify this payment yet. No second payment was sent."}; }
    await this.repository.put(saved); this.changed(saved.review); return saved.review;
  }); }
  cancel(id: string): Promise<PaymentReview> { return this.once(id,async () => {
    const saved = await this.repository.cancel(id);
    this.changed(saved.review); return saved.review;
  }); }
  private adapter(method: string) { const adapter=this.adapters.find(a=>a.method===method); if(!adapter)throw new Error("This payment method is unavailable"); return adapter; }
  private async require(id: string) { const saved=await this.repository.get(id); if(!saved)throw new Error("Unknown payment intent"); return saved; }
  private once(id:string,work:()=>Promise<PaymentReview>) { const existing=this.active.get(id);if(existing)return existing;const promise=work().finally(()=>this.active.delete(id));this.active.set(id,promise);return promise; }
}
