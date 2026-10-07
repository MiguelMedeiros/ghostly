import {useId,useState} from 'react';
import {walletNetworkOf,type PaymentReview as Review} from '@ghostly/core';
import type {WalletPlatform} from '../lib/platform';
import {useI18n} from '../contexts/I18nContext';
import {formatAt} from '../lib/time';
import {NetworkTag,satsIn} from './NetworkTag';
import {ConfirmRealMoney} from './ConfirmRealMoney';
import { formatAmount, formatTokenAmount } from "../lib/amount";
import { paymentStateLabel, railLine } from "./paymentWords";
import { InfoButton } from "./layout/Section";
import { problemText, type Problem } from "../lib/problemText";
import { Notice } from "./ui/Notice";


/**
 * A payment before it goes out, and its status after: the amount, the fee, the destination, and which money it is.
 * Test money says so and goes on Approve; real money says so, and Approve first asks once more, in words, before
 * anything is sent. Nothing leaves the wallet until that confirmation. `onSent`, when given, is called once an approved
 * payment has gone out (submitted or settled), so a chat's sheet can close and leave its status to the chat's bubble;
 * one that failed, or whose outcome is not known, stays here with its error.
 */
export function PaymentReview({review:initial,wallet,onClose,onSent}:{review:Review;wallet:WalletPlatform;onClose:()=>void;onSent?:()=>void}) {
 const {t}=useI18n();
 const [saved,setReview]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState<Problem|null>(null),[confirming,setConfirming]=useState(false),[feeWhy,setFeeWhy]=useState(false);
 const feeWhyId=useId();
 const review=wallet.getState()?.intents?.find(i=>i.id===saved.id)??saved;
 const token=review.method==='usdt';
 const network=walletNetworkOf(review.network),real=network==='mainnet',unit=token?review.asset:satsIn(t,network);
 const shown=token?formatTokenAmount(review.amount,review.decimals,t.language):formatAmount(review.amount, t.language);
 const run=async(action:()=>Promise<Review>):Promise<Review|null>=>{setBusy(true);setError(null);try{const next=await action();setReview(next);return next;}catch(e){setError(e instanceof Error?problemText(e, t):{tone:'error',title:t('payments.review.error.update')});return null;}finally{setBusy(false);}};
 // Only the real-money step says so: the engine refuses a Mainnet approval without it.
 const approve=()=>void run(()=>wallet.approvePayment(review.id,real)).then(next=>{setConfirming(false);if(next&&(next.state==='submitted'||next.state==='settled'))onSent?.();});
 const button='rounded-lg px-3 py-2 text-xs font-semibold bg-surface-hover text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';
 const status=token&&review.state==='settled'?'confirmed':review.state;
 const blocks=review.evm?.confirmations??2;
 return <section aria-label={t('payments.review.label')} className="rounded-xl border border-border p-3 space-y-3" data-testid="payment-review" data-network={network}>
  <h3 className="text-text-primary text-sm font-semibold flex items-center gap-2 flex-wrap">{review.state==='pending'?t('payments.review.title.pending'):t('payments.review.title.status')}<NetworkTag network={network} testId="review-network"/></h3>
  <p className="text-xl font-semibold text-text-primary">{shown} <span className="text-xs font-normal">{unit}</span></p>
  <p className="text-xs text-text-secondary" data-testid="review-rail">{railLine(t,review.method,review.network)}</p>
  <p className="text-xs text-text-secondary" data-testid="review-money">{real?t('payments.review.money.mainnet'):t('payments.review.money.testnet')}</p>
  <dl className="text-xs text-text-secondary space-y-2 break-all">
   <div><dt className="text-text-muted">{t('payments.review.destination')}</dt><dd className="font-mono">{review.address}</dd></div>
   <div><dt className="text-text-muted">{token?t('payments.review.gasLimit'):t('payments.review.fee')}</dt><dd>{token?`${formatTokenAmount(review.fee,18,t.language)} / ${formatTokenAmount(review.feeCap,18,t.language)} ETH`:`${formatAmount(review.fee,t.language)} / ${formatAmount(review.feeCap,t.language)} ${unit}`}</dd></div>
   {!token&&<div><dt className="text-text-muted">{t('payments.review.total')}</dt><dd>{formatAmount(review.amount+review.fee, t.language)} {unit}</dd></div>}
   <div><dt className="text-text-muted">{t('payments.review.status')}</dt><dd aria-live="polite" data-testid="review-status">{paymentStateLabel(t,status)}</dd></div>
  </dl>
  <details className="text-xs text-text-secondary"><summary className="cursor-pointer text-text-muted">{t('payments.review.details')}</summary><dl className="space-y-2 pt-2 break-all"><div><dt>{t('payments.review.payee')}</dt><dd>{review.payee}</dd></div><div><dt>{t('payments.review.provider')}</dt><dd>{review.provider}</dd></div><div><dt>{t('payments.review.expires')}</dt><dd>{formatAt(review.expiresAt, { dateStyle: "medium", timeStyle: "short" }, t.language)}</dd></div>{token&&<><div><dt>{t('payments.review.tokenChain')}</dt><dd>{t('payments.review.tokenChainValue',{token:review.token??'',chain:review.chainId??'',decimals:review.decimals??''})}</dd></div><div><dt>{t('payments.review.gasNonce')}</dt><dd>{review.evm?.gasLimit} / {review.evm?.nonce}</dd></div><div><dt>{t('payments.review.feePerGas')}</dt><dd>{review.evm?.maxFeePerGas} / {review.evm?.maxPriorityFeePerGas}</dd></div></>}{review.txid&&<div><dt>{t('payments.review.transaction')}</dt><dd>{review.txid}</dd></div>}</dl></details>
  {token&&<p className="text-[11px] text-text-muted">{review.asset==='TEST-USDT'?t('payments.review.note.usdtTest',{blocks}):t('payments.review.note.usdt',{blocks})}</p>}
  {review.method==='arkade'&&<p className="text-[11px] text-text-muted">{real?t('payments.review.note.arkReal'):t('payments.review.note.arkTest')}</p>}
  {review.method==='bark'&&<p className="text-[11px] text-text-muted">{t('payments.review.note.bark')}</p>}
  {review.method==='spark'&&<p className="text-[11px] text-text-muted" data-testid="review-spark-note">{review.network==='bitcoin'?t('payments.review.note.sparkReal'):t('payments.review.note.sparkTest')}</p>}
  {review.method==='bitcoin'&&<p className="text-[11px] text-text-muted">{t('payments.review.note.bitcoin')}</p>}
  {review.method==='fedimint'&&<p className="text-[11px] text-text-muted">{t('payments.review.note.fedimint')}</p>}
  {review.method==='cashu'&&<p className="text-[11px] text-text-muted">{t('payments.review.note.cashu')}</p>}
  {/* A refusal says what came back, short; why the mint kept some of it is behind the ⓘ. */}
  {review.error&&<div className="flex items-start gap-1.5"><Notice problem={problemText(review.error,t)} testId="review-error" className="text-xs min-w-0 flex-1 break-words"/>{!!review.returned?.fee&&<InfoButton open={feeWhy} onToggle={()=>setFeeWhy(!feeWhy)} controls={feeWhyId} testId="review-returned-info" className="-mt-0.5"/>}</div>}
  {feeWhy&&!!review.returned?.fee&&<p id={feeWhyId} className="text-xs text-text-secondary" data-testid="review-returned-text">{t('payments.review.returnedInfo',{fee:formatAmount(review.returned.fee,t.language),unit})}</p>}{error&&<Notice problem={error}/>}
  {review.state==='pending'&&confirming&&<ConfirmRealMoney what={`${shown} ${unit}`} busy={busy} onSend={approve} onBack={()=>setConfirming(false)}/>}
  <div className="flex gap-2 flex-wrap">{review.state==='pending'?<>{!confirming&&<button className={`${button} !bg-accent !text-on-accent`} data-testid="review-approve" disabled={busy} onClick={()=>real?setConfirming(true):approve()}>{t('payments.review.approve')}</button>}<button className={button} disabled={busy} onClick={()=>void run(()=>wallet.cancelPayment(review.id))}>{t('common.cancel')}</button></>:<>{['submitted','unknown'].includes(review.state)&&<button className={button} disabled={busy} onClick={()=>void run(()=>wallet.reconcilePayment(review.id))}>{t('payments.review.check')}</button>}<button className={button} onClick={onClose}>{t('common.close')}</button></>}</div>
 </section>;
}
