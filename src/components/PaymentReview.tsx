import {useState} from 'react';
import {formatPaymentAmount,type PaymentReview as Review} from '@ghostly/core';
import type {WalletPlatform} from '../lib/platform';
export function PaymentReview({review:initial,wallet,onClose}:{review:Review;wallet:WalletPlatform;onClose:()=>void}) {
 const [saved,setReview]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const review=wallet.getState()?.intents?.find(i=>i.id===saved.id)??saved;
 const token=review.method==='usdt';
 const run=async(action:()=>Promise<Review>)=>{setBusy(true);setError('');try{setReview(await action());}catch(e){setError(e instanceof Error?e.message:'Could not update this payment. Check its saved status.');}finally{setBusy(false);}};
 const button='rounded-lg px-3 py-2 text-xs font-semibold bg-surface-hover text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';
 return <section aria-label="Payment review" className="rounded-xl border border-border p-3 space-y-3" data-testid="payment-review">
  <h3 className="text-text-primary text-sm font-semibold">{review.state==='pending'?'Review payment':'Payment status'}</h3>
  <p className="text-xl font-semibold text-text-primary">{token?formatPaymentAmount(review.amount,review.decimals):review.amount.toLocaleString()} <span className="text-xs font-normal">{token?review.asset:'sats'}</span></p>
  <p className="text-xs text-text-secondary">{review.method} · {review.network} · {review.asset}</p>
  <dl className="text-xs text-text-secondary space-y-2 break-all">
   <div><dt className="text-text-muted">Destination</dt><dd className="font-mono">{review.address}</dd></div>
   <div><dt className="text-text-muted">{token?'Maximum gas / your limit':'Fee / maximum'}</dt><dd>{token?`${formatPaymentAmount(review.fee,18)} / ${formatPaymentAmount(review.feeCap,18)} ETH`:`${review.fee} / ${review.feeCap} sats`}</dd></div>
   {!token&&<div><dt className="text-text-muted">Total</dt><dd>{(review.amount+review.fee).toLocaleString()} sats</dd></div>}
   <div><dt className="text-text-muted">Status</dt><dd aria-live="polite" data-testid="review-status">{token&&review.state==='settled'?'confirmed':review.state}</dd></div>
  </dl>
  <details className="text-xs text-text-secondary"><summary className="cursor-pointer text-text-muted">Payment details</summary><dl className="space-y-2 pt-2 break-all"><div><dt>Payee</dt><dd>{review.payee}</dd></div><div><dt>Provider</dt><dd>{review.provider}</dd></div><div><dt>Expires</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd></div>{token&&<><div><dt>Token / chain</dt><dd>{review.token} · {review.chainId} · {review.decimals} decimals</dd></div><div><dt>Gas limit / nonce</dt><dd>{review.evm?.gasLimit} / {review.evm?.nonce}</dd></div><div><dt>Maximum / priority fee per gas (wei)</dt><dd>{review.evm?.maxFeePerGas} / {review.evm?.maxPriorityFeePerGas}</dd></div></>}{review.txid&&<div><dt>Transaction</dt><dd>{review.txid}</dd></div>}</dl></details>
  {token&&<p className="text-[11px] text-text-muted">{review.asset==='TEST-USDT'?'Local test token, not Tether-issued USDT. ':''}Gas is paid separately in ETH and may exceed a small payment's value. Confirmed after {review.evm?.confirmations??2} blocks.</p>}
  {review.method==='arkade'&&<p className="text-[11px] text-text-muted">Test funds only. Ark confirmation is off-chain.</p>}
  {review.method==='cashu'&&<p className="text-[11px] text-text-muted">The selected mint holds the backing funds. Confirmation requires token redemption at that mint.</p>}
  {review.error&&<p className="text-xs text-danger">{review.error}</p>}{error&&<p role="alert" className="text-xs text-danger">{error}</p>}
  <div className="flex gap-2 flex-wrap">{review.state==='pending'?<><button className={`${button} !bg-accent !text-[#111b21]`} disabled={busy} onClick={()=>void run(()=>wallet.approvePayment(review.id))}>Approve payment</button><button className={button} disabled={busy} onClick={()=>void run(()=>wallet.cancelPayment(review.id))}>Cancel</button></>:<>{['submitted','unknown'].includes(review.state)&&<button className={button} disabled={busy} onClick={()=>void run(()=>wallet.reconcilePayment(review.id))}>Check existing payment</button>}<button className={button} onClick={onClose}>Close</button></>}</div>
 </section>;
}
