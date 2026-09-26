import {useState} from 'react';
import {formatPaymentAmount,walletNetworkOf,type PaymentReview as Review} from '@ghostly/core';
import type {WalletPlatform} from '../lib/platform';
import {NetworkTag,satsOf} from './NetworkTag';
import {ConfirmRealMoney} from './ConfirmRealMoney';

/**
 * A payment before it goes out, and its status after: the amount, the fee, the destination, and which money it is.
 * Test money says so and goes on Approve; real money says so, and Approve first asks once more, in words, before
 * anything is sent. Nothing leaves the wallet until that confirmation.
 */
export function PaymentReview({review:initial,wallet,onClose}:{review:Review;wallet:WalletPlatform;onClose:()=>void}) {
 const [saved,setReview]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirming,setConfirming]=useState(false);
 const review=wallet.getState()?.intents?.find(i=>i.id===saved.id)??saved;
 const token=review.method==='usdt';
 const network=walletNetworkOf(review.network),real=network==='mainnet',unit=token?review.asset:satsOf(network);
 const shown=token?formatPaymentAmount(review.amount,review.decimals):review.amount.toLocaleString();
 const run=async(action:()=>Promise<Review>)=>{setBusy(true);setError('');try{setReview(await action());}catch(e){setError(e instanceof Error?e.message:'Could not update this payment. Check its saved status.');}finally{setBusy(false);}};
 // Only the real-money step says so: the engine refuses a Mainnet approval without it.
 const approve=()=>void run(()=>wallet.approvePayment(review.id,real)).then(()=>setConfirming(false));
 const button='rounded-lg px-3 py-2 text-xs font-semibold bg-surface-hover text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';
 return <section aria-label="Payment review" className="rounded-xl border border-border p-3 space-y-3" data-testid="payment-review" data-network={network}>
  <h3 className="text-text-primary text-sm font-semibold flex items-center gap-2 flex-wrap">{review.state==='pending'?'Review payment':'Payment status'}<NetworkTag network={network} testId="review-network"/></h3>
  <p className="text-xl font-semibold text-text-primary">{shown} <span className="text-xs font-normal">{unit}</span></p>
  <p className="text-xs text-text-secondary">{review.method} · {review.network} · {review.asset}</p>
  <p className="text-xs text-text-secondary" data-testid="review-money">{real?'Real money: it leaves your wallet once you confirm.':'Test money: these coins are worth nothing outside the test network.'}</p>
  <dl className="text-xs text-text-secondary space-y-2 break-all">
   <div><dt className="text-text-muted">Destination</dt><dd className="font-mono">{review.address}</dd></div>
   <div><dt className="text-text-muted">{token?'Maximum gas / your limit':'Fee / maximum'}</dt><dd>{token?`${formatPaymentAmount(review.fee,18)} / ${formatPaymentAmount(review.feeCap,18)} ETH`:`${review.fee} / ${review.feeCap} ${unit}`}</dd></div>
   {!token&&<div><dt className="text-text-muted">Total</dt><dd>{(review.amount+review.fee).toLocaleString()} {unit}</dd></div>}
   <div><dt className="text-text-muted">Status</dt><dd aria-live="polite" data-testid="review-status">{token&&review.state==='settled'?'confirmed':review.state}</dd></div>
  </dl>
  <details className="text-xs text-text-secondary"><summary className="cursor-pointer text-text-muted">Payment details</summary><dl className="space-y-2 pt-2 break-all"><div><dt>Payee</dt><dd>{review.payee}</dd></div><div><dt>Provider</dt><dd>{review.provider}</dd></div><div><dt>Expires</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd></div>{token&&<><div><dt>Token / chain</dt><dd>{review.token} · {review.chainId} · {review.decimals} decimals</dd></div><div><dt>Gas limit / nonce</dt><dd>{review.evm?.gasLimit} / {review.evm?.nonce}</dd></div><div><dt>Maximum / priority fee per gas (wei)</dt><dd>{review.evm?.maxFeePerGas} / {review.evm?.maxPriorityFeePerGas}</dd></div></>}{review.txid&&<div><dt>Transaction</dt><dd>{review.txid}</dd></div>}</dl></details>
  {token&&<p className="text-[11px] text-text-muted">{review.asset==='TEST-USDT'?'Local test token, not Tether-issued USDT. ':''}Gas is paid separately in ETH and may exceed a small payment's value. Confirmed after {review.evm?.confirmations??2} blocks.</p>}
  {review.method==='arkade'&&<p className="text-[11px] text-text-muted">{real?'Real bitcoin. ':'Test funds only. '}Ark confirmation is off-chain.</p>}
  {review.method==='bark'&&<p className="text-[11px] text-text-muted">Sent over Second's Ark server, off-chain. Only an address of that same server can be paid.</p>}
  {review.method==='spark'&&<p className="text-[11px] text-text-muted" data-testid="review-spark-note">{review.network==='bitcoin'?'Real bitcoin. ':'Regtest: test sats, worthless. '}Spark to Spark, off-chain: final once Spark's operators sign the transfer. Checking it never sends a second one.</p>}
  {review.method==='bitcoin'&&<p className="text-[11px] text-text-muted">An on-chain transaction, signed for exactly this review. Settled after one confirmation; checking it never sends a second one.</p>}
  {review.method==='fedimint'&&<p className="text-[11px] text-text-muted">Ecash notes of this federation go to your contact: they are the money until your contact redeems them. If they never do, take them back (they also come back by themselves after a week).</p>}
  {review.method==='cashu'&&<p className="text-[11px] text-text-muted">The selected mint holds the backing funds. Confirmation requires token redemption at that mint.</p>}
  {review.error&&<p className="text-xs text-danger">{review.error}</p>}{error&&<p role="alert" className="text-xs text-danger">{error}</p>}
  {review.state==='pending'&&confirming&&<ConfirmRealMoney what={`${shown} ${unit}`} busy={busy} onSend={approve} onBack={()=>setConfirming(false)}/>}
  <div className="flex gap-2 flex-wrap">{review.state==='pending'?<>{!confirming&&<button className={`${button} !bg-accent !text-on-accent`} data-testid="review-approve" disabled={busy} onClick={()=>real?setConfirming(true):approve()}>Approve payment</button>}<button className={button} disabled={busy} onClick={()=>void run(()=>wallet.cancelPayment(review.id))}>Cancel</button></>:<>{['submitted','unknown'].includes(review.state)&&<button className={button} disabled={busy} onClick={()=>void run(()=>wallet.reconcilePayment(review.id))}>Check existing payment</button>}<button className={button} onClick={onClose}>Close</button></>}</div>
 </section>;
}
