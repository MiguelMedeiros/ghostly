import { engineError, engineText, type PaymentAdapter, type PaymentReview, type PaymentTarget } from '@ghostly/core';
import { mintNetwork } from '../../shared/mints';
import type { CashuWallet, CashuPrepared } from '../wallet';

/**
 * How long one request to a mint may last: cashu-ts's default `requestTimeout` (5 min), which this wallet does not
 * change. Retries of a swap (NUT-19) run inside the same approval, and reconcile waits for it (the coordinator runs one
 * operation per payment at a time).
 */
export const CASHU_REQUEST_TIMEOUT_MS=300_000;
/** The margin past that for a mint slow to act on a swap it did receive. */
export const SWAP_SETTLED_MS=120_000;
/**
 * When a swap whose outcome is unknown can no longer reach the mint: a request's longest life after the approval
 * (`submittedAt`, saved when it was claimed), and the margin after the attempt ended (`attemptEndedAt`), both saved.
 */
export function swapSettledAt(review:PaymentReview,prepared:CashuPrepared):number{
 return Math.max((review.submittedAt ?? review.createdAt)+CASHU_REQUEST_TIMEOUT_MS+SWAP_SETTLED_MS,(prepared.attemptEndedAt ?? 0)+SWAP_SETTLED_MS);
}
export const NEVER_REACHED_MINT="The payment never reached the mint: nothing was sent, and the sats are back in your wallet. You can pay again.";

export class CashuAdapter implements PaymentAdapter<CashuPrepared> {
 readonly method='cashu' as const;
 constructor(private wallet:CashuWallet,private publish:(review:PaymentReview,token:string)=>Promise<void>){}
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
  // Saved with the intent when the coordinator records the unknown outcome: the swap may still reach the mint for a while.
  catch(error){ prepared.attemptEndedAt=Date.now(); throw error; }
  await persist?.();
  await this.publish(review,token);
  return await this.outcome(review,prepared) ?? {settled:false};
 }
 /**
  * What the mint and this wallet know of a payment whose token went out: paid once the mint reads its ecash spent,
  * unless this wallet is the one that spent it, taking the payment back. Asked in that order: ecash taken back while
  * the mint was being asked reads spent too. Undefined while the contact has not taken it.
  */
 private async outcome(review:PaymentReview,prepared:CashuPrepared){
  const spent=await this.wallet.reviewedCashuSpent(prepared);
  if(await this.wallet.reviewedCashuTakenBack(review.id))return {settled:false,failed:true,error:engineText('paymentTakenBack')};
  return spent?{settled:true}:undefined;
 }
 /** `persist` saves the intent as it is: required, since the abandon path must be durable before it releases anything. */
 async reconcile(review:PaymentReview,prepared:CashuPrepared,persist:()=>Promise<void>){
  if(prepared.abandoned)return this.abandon(prepared,persist);
  const known=await this.outcome(review,prepared);
  if(known)return known;
  const token=prepared.token ?? await this.wallet.recoverReviewedCashu(review,prepared);
  if(token)await this.publish(review,token); // Repeat the same token, never mint a replacement.
  const after=await this.outcome(review,prepared);
  if(after)return after;
  // No token: the swap may never have reached the mint (it was unreachable when approved). Only the mint can say so,
  // and only once no request of it can still be on its way: then the payment failed and its inputs come back.
  if(!token && Date.now()>=swapSettledAt(review,prepared) && await this.wallet.reviewedCashuNeverSwapped(prepared))return this.abandon(prepared,persist);
  return {settled:false};
 }
 /**
  * The mint proved this swap never happened. Marked for good first (a reload repeats only this), then its reserved
  * inputs are released. Nothing sends the saved swap again: approve claims pending reviews only, and reconcile asks.
  */
 private async abandon(prepared:CashuPrepared,persist:()=>Promise<void>){
  prepared.abandoned=true;
  await persist();
  await this.wallet.releaseReviewedCashu(prepared);
  return {settled:false,failed:true,error:NEVER_REACHED_MINT};
 }
}
