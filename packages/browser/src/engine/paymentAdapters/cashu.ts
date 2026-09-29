import type { PaymentAdapter, PaymentReview, PaymentTarget } from '@ghostly/core';
import { mintNetwork } from '../../shared/mints';
import type { CashuWallet, CashuPrepared } from '../wallet';

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
 async reconcile(review:PaymentReview,prepared:CashuPrepared){
  if(await this.wallet.reviewedCashuSpent(prepared))return {settled:true};
  const token=prepared.token ?? await this.wallet.recoverReviewedCashu(review,prepared);
  if(token)await this.publish(review,token); // Repeat the same token, never mint a replacement.
  return {settled:await this.wallet.reviewedCashuSpent(prepared)};
 }
}
