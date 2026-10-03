import { PaymentPreflightError, assertTokenUnits, assertWholeSats, engineError, engineText, validatePaymentTarget, type PaymentAdapter, type PaymentReview, type PaymentTarget } from "@ghostly/core";

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
    if (!Number.isSafeInteger(feeCap) || feeCap < 0) throw engineError("invalidMaxFee");
    if (context.requestId) {
      const existing = (await this.repository.list()).find(({review:r}) => r.requestId === context.requestId && r.linkId === context.linkId && !["failed", "cancelled"].includes(r.state));
      if (existing) throw engineError("requestHasPayment");
    }
    const adapter = this.adapter(validated.method);
    const {fee,prepared,evm} = await adapter.prepare(validated,amount,feeCap);
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > feeCap) throw engineError("feeAboveLimit");
    const review: PaymentReview = {...validated,...context,id:crypto.randomUUID(),amount,fee,feeCap,...(evm ? {evm} : {}),createdAt:Date.now(),state:"pending"};
    await this.repository.put({review,prepared}); this.changed(review); return review;
  }
  approve(id: string): Promise<PaymentReview> { return this.once(id,async () => {
    const saved = await this.require(id);
    if (saved.review.state !== "pending") throw engineError("cannotSubmitAgain");
    validatePaymentTarget(saved.review);
    // Atomic claim prevents two tabs/coordinators from spending the same intent.
    const claimed = await this.repository.claim(id);
    saved.review = claimed.review; this.changed(saved.review);
    try {
      const result = await this.adapter(saved.review.method).execute(saved.review,saved.prepared,() => this.repository.put(saved));
      saved.review = {...saved.review,...result,state:result.failed ? "failed" : result.settled ? "settled" : "submitted"};
    } catch (error) {
      // An exception is not proof of a failed spend, even when it looks like a transport error.
      saved.review = {...saved.review,state:error instanceof PaymentPreflightError ? "failed" : "unknown",error:error instanceof PaymentPreflightError ? error.message : engineText("outcomeUnknown")};
    }
    await this.repository.put(saved); this.changed(saved.review); return saved.review;
  }); }
  reconcile(id: string): Promise<PaymentReview> { return this.once(id,async () => {
    const saved = await this.require(id);
    if (!["submitted","unknown"].includes(saved.review.state)) return saved.review;
    // Parked by a copy started from older state: its signed bytes are never sent again, and nothing is asked here.
    if (saved.review.parked) return saved.review;
    try {
      const result = await this.adapter(saved.review.method).reconcile(saved.review,saved.prepared,()=>this.repository.put(saved));
      saved.review = {...saved.review,...result,state:result.failed ? "failed" : result.settled ? "settled" : result.pending ? "submitted" : "unknown",error:result.failed ? result.error : result.settled ? undefined : engineText("notYetConfirmed")};
    } catch { saved.review = {...saved.review,state:"unknown",error:engineText("couldNotVerify")}; }
    await this.repository.put(saved); this.changed(saved.review); return saved.review;
  }); }
  cancel(id: string): Promise<PaymentReview> { return this.once(id,async () => {
    const saved = await this.repository.cancel(id);
    // Only now, once no approval can claim it: what prepare reserved goes back. Best effort, nothing was spent.
    await this.adapters.find(a=>a.method===saved.review.method)?.release?.(saved.review,saved.prepared).catch(()=>{});
    this.changed(saved.review); return saved.review;
  }); }
  /**
   * Cancels the reviews no Approve can send any more, as Cancel does (what prepare reserved goes back, and each stays
   * in the store as cancelled): one past its expiry (approve refuses it), and one whose request was paid some other
   * way or closed (`unpayable`). Only pending reviews: a submitted or unknown one may hold or move money, and is only
   * ever reconciled. Returns what it cancelled.
   */
  async dropStale(now: number = Date.now(), unpayable: (review: PaymentReview) => boolean = () => false): Promise<PaymentReview[]> {
    const dropped: PaymentReview[] = [];
    for (const { review } of await this.repository.list()) {
      if (review.state !== "pending" || (review.expiresAt > now && !unpayable(review))) continue;
      // Approved meanwhile, or cancelled elsewhere: the store refuses (or the approval under way answers), and that
      // one is left as it is.
      try { const cancelled = await this.cancel(review.id); if (cancelled.state === "cancelled") dropped.push(cancelled); } catch { /* not pending any more */ }
    }
    return dropped;
  }
  private adapter(method: string) { const adapter=this.adapters.find(a=>a.method===method); if(!adapter)throw engineError("methodUnavailable"); return adapter; }
  private async require(id: string) { const saved=await this.repository.get(id); if(!saved)throw engineError("unknownPaymentIntent"); return saved; }
  private once(id:string,work:()=>Promise<PaymentReview>) { const existing=this.active.get(id);if(existing)return existing;const promise=work().finally(()=>this.active.delete(id));this.active.set(id,promise);return promise; }
}
