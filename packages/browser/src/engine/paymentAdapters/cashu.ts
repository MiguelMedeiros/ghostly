import { engineError, engineText, type PaymentAdapter, type PaymentReview, type PaymentTarget } from '@ghostly/core';
import { mintNetwork } from '../../shared/mints';
import type { CashuWallet, CashuPrepared } from '../wallet';

/**
 * How long one request of a swap to a mint may last, and one asking where a swap stands (NUT-09 restore, NUT-07 states):
 * its retries (NUT-19) included, under one deadline (`boundSwapRequests`). A mint that takes the connection and never
 * answers is given up on within it, and the payment says so, instead of after cashu-ts' 5 min. Retries run inside the
 * same approval, and reconcile waits for it (the coordinator runs one operation per payment at a time).
 */
export const CASHU_REQUEST_TIMEOUT_MS=30_000;
/** How long a melt's request may last: cashu-ts's default `requestTimeout` (5 min), which this wallet does not change. */
export const MELT_REQUEST_TIMEOUT_MS=300_000;
/** The margin past that for a mint slow to act on a swap it did receive. */
export const SWAP_SETTLED_MS=120_000;
/**
 * When a swap whose outcome is unknown can no longer reach the mint: a request's longest life after the approval
 * (`submittedAt`, saved when it was claimed), and the margin after the attempt ended (`attemptEndedAt`), both saved.
 */
export function swapSettledAt(review:PaymentReview,prepared:CashuPrepared):number{
 return Math.max((review.submittedAt ?? review.createdAt)+CASHU_REQUEST_TIMEOUT_MS+SWAP_SETTLED_MS,(prepared.attemptEndedAt ?? 0)+SWAP_SETTLED_MS);
}
/**
 * The mint answered, and refused. cashu-ts turns a refusal of a keyset the mint retired or does not know (codes
 * 12xxx) into a `StaleKeysetError` once it has reloaded the mint's keysets: the mint's refusal all the same, with it
 * as its cause. By name, as cashu-ts's own `isMintOperationError`, so it needs no import of the library.
 */
export function mintRefused(error:unknown):boolean{
 if(!(error instanceof Error))return false;
 if(error.name==='StaleKeysetError')return mintRefused((error as {cause?:unknown}).cause);
 return error.name==='MintOperationError' && 'code' in error;
}
/**
 * The mint refused outputs for their keyset: one it retired, or does not know, since they were made. No request with
 * those outputs is ever signed; new ones on the keyset it signs with now can be. cashu-ts says it in its own English,
 * which is never shown to a person.
 */
/**
 * The mint failed, and said nothing of the request: a server error (5xx, "internal error"), or no answer at all (a
 * closed connection, cashu-ts's `NetworkError`). Unlike a refusal, it may work later. By name, as `mintRefused`.
 */
export function mintFailed(error:unknown):boolean{
 if(!(error instanceof Error))return false;
 const status=(error as {status?:unknown}).status;
 return error.name==='NetworkError' || (error.name==='HttpResponseError' && typeof status==='number' && status>=500);
}
export function keysetRefused(error:unknown):boolean{
 return error instanceof Error && error.name==='StaleKeysetError' && mintRefused(error);
}
export const NEVER_REACHED_MINT="The payment never reached the mint: nothing was sent, and the sats are back in your wallet. You can pay again.";

/**
 * A Take it back of the payment under way, if one is (`PaymentDesk.takingBack`): settles once it is over, with the
 * payment's state then.
 */
export type TakingBack=(paymentId:string)=>Promise<string|undefined>|undefined;

export class CashuAdapter implements PaymentAdapter<CashuPrepared> {
 readonly method='cashu' as const;
 constructor(private wallet:CashuWallet,private publish:(review:PaymentReview,token:string)=>Promise<void>,private takingBack:TakingBack=()=>undefined){}
 async prepare(target:PaymentTarget,amount:number,feeCap:number){
  // A test mint (the public ones, or one on this machine) pays in test sats, named cashu-test; any other in sats.
  if(target.method!=='cashu' || target.network!==(mintNetwork(target.provider)==='testnet'?'cashu-test':'bitcoin'))throw new Error('Cashu mint/network mismatch');
  const result=await this.wallet.prepareReviewedCashu(target.provider,amount);
  if(result.fee>feeCap)throw engineError('cashuFeeAboveLimit');
  return result;
 }
 async execute(review:PaymentReview,prepared:CashuPrepared,persist?:()=>Promise<void>){
  if(!review.linkId)throw new Error('Cashu requires an authenticated chat recipient');
  let token:string;
  try { token=await this.wallet.executeReviewedCashu(review,prepared); }
  catch(error){
   // Saved with the intent when the coordinator records the unknown outcome: the swap may still reach the mint for a while.
   prepared.attemptEndedAt=Date.now();
   if(persist && mintRefused(error)){
    // A refusal, and the mint says why: the ecash it was to spend was spent somewhere else. The payment ends here.
    if(await this.wallet.reviewedCashuSpentElsewhere(prepared).catch(()=>false))return this.spentElsewhere(prepared,persist);
    // A refusal of the only request made for it (outputs on a keyset the mint retired since): no request of it is on
    // its way, so the mint's word that it never happened ends it now, not once reconcile may ask.
    if(await this.wallet.reviewedCashuNeverSwapped(prepared).catch(()=>false))return this.abandon(prepared,persist);
   }
   throw error;
  }
  await persist?.();
  await this.publish(review,token);
  return await this.outcome(review,prepared) ?? {settled:false};
 }
 /**
  * What the mint and this wallet know of a payment whose token went out: paid once the mint reads its ecash spent,
  * unless this wallet is the one that spent it, taking the payment back. Asked in that order: ecash taken back while
  * the mint was being asked reads spent too. Undefined while the contact has not taken it.
  * A Take it back of it under way when the mint is asked, or started while it answers, is waited for: its swap makes
  * the ecash read spent before the ecash is back here. Ended with the ecash back, the payment was taken back; ended
  * with the mint saying the contact had it first, it is paid; ended any other way, this round's spent read proves
  * nothing, and the next round asks again (nothing is sent meanwhile). One whose answer from the mint was lost is still
  * under way while its redeem is written down: asked before whether the ecash is back, which is stored as it ends.
  */
 private async outcome(review:PaymentReview,prepared:CashuPrepared){
  const before=this.takingBack(review.id);
  const spent=await this.wallet.reviewedCashuSpent(prepared);
  const reclaim=this.takingBack(review.id) ?? before;
  const ended=await reclaim;
  const unsettled=await this.wallet.cashuTakingBack(review.id);
  const back=await this.takenBack(review.id);
  if(back)return back;
  if(unsettled || (reclaim && ended!=='settled'))return {settled:false};
  return spent?{settled:true}:undefined;
 }
 /** Taken back, waiting for a Take it back under way first: the payment then ends failed, its sats back here. */
 private async takenBack(id:string){
  await this.takingBack(id);
  return await this.wallet.reviewedCashuTakenBack(id)?{settled:false,failed:true,error:engineText('paymentTakenBack')}:undefined;
 }
 /** `persist` saves the intent as it is: required, since the abandon path must be durable before it releases anything. */
 async reconcile(review:PaymentReview,prepared:CashuPrepared,persist:()=>Promise<void>){
  if(prepared.abandoned)return this.abandon(prepared,persist);
  if(prepared.spentElsewhere)return this.spentElsewhere(prepared,persist);
  // Asked once a round: the contact taking a token it just got says so (`onReviewedPaymentResult`), and the next round asks.
  const known=await this.outcome(review,prepared);
  if(known)return known;
  const token=prepared.token ?? await this.wallet.recoverReviewedCashu(review,prepared);
  if(token){
   await this.publish(review,token); // Repeat the same token, never mint a replacement.
   // Sending it can wait on the chat for a while (a restart dials the contact): Take it back may have ended it meanwhile.
   const back=await this.takenBack(review.id);
   if(back)return back;
  }
  // No token: the swap may never have reached the mint (it was unreachable when approved). Only the mint can say so,
  // and only once no request of it can still be on its way: then the payment failed and its inputs come back.
  if(!token && Date.now()>=swapSettledAt(review,prepared) && await this.wallet.reviewedCashuNeverSwapped(prepared))return this.abandon(prepared,persist);
  // No token, and the mint answers that it signed none of the outputs while an input reads spent: something else
  // spent this ecash (the profile in use on another device, its ecash redeemed from a copy). This swap can never
  // happen, whenever it is asked about.
  if(!token && await this.wallet.reviewedCashuSpentElsewhere(prepared))return this.spentElsewhere(prepared,persist);
  return {settled:false};
 }
 /**
  * The mint proved this swap never happened. Marked for good first (a reload repeats only this), then its reserved
  * inputs are released. Nothing sends the saved swap again: approve claims pending reviews only, and reconcile asks.
  */
 /**
  * The ecash this payment was to spend is spent, and not by this payment. Marked for good first, then the wallet lets
  * go of what the mint reads spent, frees the rest, and asks the mint about its other ecash there.
  */
 private async spentElsewhere(prepared:CashuPrepared,persist:()=>Promise<void>){
  prepared.spentElsewhere=true;
  await persist();
  await this.wallet.dropReviewedCashu(prepared);
  return {settled:false,failed:true,error:engineText('reviewedEcashSpent')};
 }
 private async abandon(prepared:CashuPrepared,persist:()=>Promise<void>){
  prepared.abandoned=true;
  await persist();
  await this.wallet.releaseReviewedCashu(prepared);
  return {settled:false,failed:true,error:NEVER_REACHED_MINT};
 }
}
