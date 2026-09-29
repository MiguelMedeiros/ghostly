import type { PaymentAdapter, PaymentReview, PaymentTarget } from '@ghostly/core';
import { mintNetwork } from '../../shared/mints';
import type { CashuWallet, CashuPrepared } from '../wallet';

/**
 * How long after its approval an unanswered swap may still reach the mint. Past it, a mint that reads every input
 * UNSPENT and signed none of the outputs is proof the payment never happened.
 */
export const SWAP_SETTLED_MS=120_000;
export const NEVER_REACHED_MINT="The payment never reached the mint: nothing was sent, and the sats are back in your wallet. You can pay again.";

export class CashuAdapter implements PaymentAdapter<CashuPrepared> {
 readonly method='cashu' as const;
 constructor(private wallet:CashuWallet,private publish:(review:PaymentReview,token:string)=>Promise<void>){}
 async prepare(target:PaymentTarget,amount:number,feeCap:number){
  // A test mint (the public ones, or one on this machine) pays in test sats, named cashu-test; any other in sats.
  if(target.method!=='cashu' || target.network!==(mintNetwork(target.provider)==='testnet'?'cashu-test':'bitcoin'))throw new Error('Cashu mint/network mismatch');
  const result=await this.wallet.prepareReviewedCashu(target.provider,amount);
  if(result.fee>feeCap)throw new Error('Cashu fee exceeds your limit');
  return result;
 }
 async execute(review:PaymentReview,prepared:CashuPrepared,persist?:()=>Promise<void>){
  if(!review.linkId)throw new Error('Cashu requires an authenticated chat recipient');
  const token=await this.wallet.executeReviewedCashu(review,prepared);
  await persist?.();
  await this.publish(review,token);
  return {settled:await this.wallet.reviewedCashuSpent(prepared)};
 }
 async reconcile(review:PaymentReview,prepared:CashuPrepared,persist?:()=>Promise<void>){
  if(prepared.abandoned)return this.abandon(prepared,persist);
  if(await this.wallet.reviewedCashuSpent(prepared))return {settled:true};
  const token=prepared.token ?? await this.wallet.recoverReviewedCashu(review,prepared);
  if(token)await this.publish(review,token); // Repeat the same token, never mint a replacement.
  if(await this.wallet.reviewedCashuSpent(prepared))return {settled:true};
  // No token: the swap may never have reached the mint (it was unreachable when approved). Only the mint can say so,
  // and only once no request of it can still be on its way: then the payment failed and its inputs come back.
  const since=review.submittedAt ?? review.createdAt;
  if(!token && Date.now()-since>=SWAP_SETTLED_MS && await this.wallet.reviewedCashuNeverSwapped(prepared))return this.abandon(prepared,persist);
  return {settled:false};
 }
 /**
  * The mint proved this swap never happened. Marked for good first (a reload repeats only this), then its reserved
  * inputs are released. Nothing sends the saved swap again: approve claims pending reviews only, and reconcile asks.
  */
 private async abandon(prepared:CashuPrepared,persist?:()=>Promise<void>){
  prepared.abandoned=true;
  await persist?.();
  await this.wallet.releaseReviewedCashu(prepared);
  return {settled:false,failed:true,error:NEVER_REACHED_MINT};
 }
}
