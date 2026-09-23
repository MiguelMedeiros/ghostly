import { formatPaymentAmount, parsePaymentAmount } from "@ghostly/core";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "./PaymentReview";
import { useEffect, useRef, useState } from "react";
import { useCountUp } from "../hooks/useCountUp";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { isWorthlessMint } from "@ghostly/browser/shared/mints";

const STATE_LABEL = {
  payment: { pending: "Waiting for your contact…", settled: "Received", failed: "Failed", reclaimed: "Taken back" },
  request: { pending: "Waiting for payment", settled: "Paid", failed: "Failed", reclaimed: "" },
} as const;

/** A payment or a payment request in the chat. The amounts are live: they follow what the wallet knows. */
export function PaymentBubble({ paymentId, peerPubKey, fallbackText }: { paymentId: string; peerPubKey: string; fallbackText: string }) {
  const platform = useServicesPlatform();
  const wallet = platform?.wallet;
  const payment = wallet?.getPayment(paymentId) ?? null;
  /** Its way of paying is off in this chat: the request stays readable, but nothing here can pay it. */
  const allowed = platform?.getPeer(peerPubKey)?.paymentMethods;
  const paymentsOff = !!allowed && !!payment && (payment.target ? !allowed[payment.target.method] : !(allowed.cashu || allowed.lightning));
  const [review,setReview] = useState<Review|null>(null);
  const [mint,setMint] = useState("");
  const [feeCap,setFeeCap] = useState<string|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Feedback for what happens while you watch: a payment landing, a request coming in, a confirmation.
  const state = payment?.state;
  const incomingMoney = payment ? (payment.kind === "payment" ? payment.direction === "in" : payment.direction === "out") : false;
  const [fresh] = useState(() => payment !== null && Date.now() - payment.createdAt < 8000);
  const [celebrate, setCelebrate] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!payment || !state) return;
    const first = previous.current === undefined;
    const settledNow = state === "settled" && (first ? fresh : previous.current === "pending");
    if (settledNow) {
      setCelebrate(incomingMoney);
    }
    previous.current = state;
    // `payment` only matters through the fields above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const amountShown = useCountUp(celebrate ? (payment?.amount ?? 0) : 0, 650);

  if (!wallet || !payment) return <span className="text-[14.2px] leading-[19px]">{fallbackText}</span>;

  const run = async (task: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tokenPayment=payment.target?.method==='usdt';
  const feeInput=feeCap??(tokenPayment?'0.001':'10');
  const outgoing = payment.direction === "out";
  const isRequest = payment.kind === "request";
  const sharedMints=(wallet.getState()?.mints??[]).filter(m=>payment.mints?.includes(m.url));
  const selectedMint=sharedMints.find(m=>m.url===mint)?.url ?? sharedMints[0]?.url;
  const title = isRequest ? (outgoing ? "You requested" : "Requests") : outgoing ? "You sent" : "Sent you";
  // Test sats are worth nothing, and the bubble says so: a contact must not pass them off as money.
  const testSats = payment.target?.method === "arkade" ? payment.target.network !== "bitcoin"
    : payment.target?.method === "cashu" ? payment.target.network === "cashu-test"
    : !tokenPayment && (payment.mint ? isWorthlessMint(payment.mint) : !!payment.mints?.length && payment.mints.every(isWorthlessMint));
  const button =
    "px-3 py-1.5 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const quiet = "px-3 py-1.5 bg-black/20 hover:bg-black/30 rounded-lg text-xs font-bold transition-colors cursor-pointer";

  return (
    <div
      className={`min-w-[210px] max-md:min-w-[min(210px,68vw)] max-w-[min(300px,72vw)] px-1 py-0.5 rounded-md ${celebrate ? "animate-sats-shine" : ""} ${
        fresh && isRequest && !outgoing && payment.state === "pending" ? "animate-nudge" : ""
      }`}
      data-testid="payment-bubble"
      data-state={payment.state}
    >
      <p className="text-[11px] uppercase tracking-wider text-[hsla(0,0%,100%,0.6)] m-0">{title}</p>
      <p className="m-0 leading-tight">
        <span className="text-[22px] font-semibold">

          {tokenPayment?formatPaymentAmount(payment.amount,payment.target?.decimals):(celebrate ? amountShown : payment.amount).toLocaleString()}
        </span>
        {" "}<span className="text-xs ml-1 text-[hsla(0,0%,100%,0.7)]">{tokenPayment?payment.target?.asset:testSats?'test sats':'sats'}</span>
      </p>
      {payment.target && <p className="text-xs text-text-muted">{payment.target.method==="usdt"?"USDT":payment.target.method==="arkade"?"Ark":"Cashu"} · {payment.target.network}</p>}
      {review && <PaymentReview review={review} wallet={wallet} onClose={()=>setReview(null)}/>}
      {payment.memo && <p className="text-[13px] m-0 mt-0.5 wrap-break-word">{payment.memo}</p>}
      <p
        className={`text-[11px] m-0 mt-1 ${payment.state === "failed" ? "text-danger" : payment.state === "settled" ? "text-accent" : "text-[hsla(0,0%,100%,0.6)]"}`}
        data-testid="payment-state"
      >
        {payment.lightningPending && payment.state === "pending" ? "Lightning payment pending at the mint…" : STATE_LABEL[payment.kind][payment.state]}
        {payment.error && payment.state !== "settled" ? ` · ${payment.error}` : ""}
      </p>

      {isRequest && !outgoing && paymentsOff && (payment.state === "pending" || payment.state === "failed") && (
        <p className="text-xs text-text-muted mt-2" data-testid="payment-off">This way of paying is off in this chat.</p>
      )}
      {isRequest && !outgoing && !paymentsOff && (payment.state === "pending" || payment.state === "failed") && !payment.lightningPending && (
        <div className="flex flex-col gap-2 mt-2">
          {!payment.target && <label className="text-xs">Cashu mint<select aria-label="Cashu mint" className="block max-w-full bg-input-bg rounded p-1" value={selectedMint??""} onChange={e=>setMint(e.target.value)}>{!sharedMints.length&&<option value="">No shared configured mint</option>}{sharedMints.map(m=><option key={m.url} value={m.url}>{m.url} · {m.balance} sats</option>)}</select></label>}
          <label className="text-xs">{tokenPayment?'Maximum gas (ETH)':'Maximum fee (sats)'}<input aria-label={tokenPayment?'Maximum gas (ETH)':'Maximum fee (sats)'} className="block w-20 bg-input-bg rounded p-1" inputMode="numeric" value={feeInput} onChange={e=>setFeeCap(e.target.value.replace(tokenPayment?/[^0-9.]/g:/\D/g,""))}/></label>
          <button data-testid="payment-pay" className={button} disabled={busy || (!payment.target && !selectedMint) || !!review} onClick={() => run(async () => {
            const target=payment.target ?? {method:"cashu" as const,network:wallet.testMintUrls.includes(selectedMint!) ? "cashu-test" as const : "bitcoin" as const,provider:selectedMint!,asset:"BTC" as const,unit:"sat" as const,address:payment.id,expiresAt:Date.now()+15*60*1000};
            setReview(await wallet.preparePayment({target,amount:payment.amount,feeCap:tokenPayment?parsePaymentAmount(feeInput,18):Number(feeInput),payee:peerPubKey,linkId:payment.linkId,requestId:payment.id}));
          })}>
            {busy ? "Preparing…" : "Review payment"}
          </button>
          {payment.invoice && (
            <button
              className={quiet}
              title="Pay it from another Lightning wallet"
              onClick={() => {
                void navigator.clipboard.writeText(payment.invoice!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied!" : "Copy invoice"}
            </button>
          )}
        </div>
      )}
      {/* Ecash nobody picked up is still ours, whether it went out through a review or not. */}
      {(!payment.target || payment.target.method === "cashu") && !isRequest && outgoing && (payment.state === "pending" || payment.state === "failed") && (
        <button className={`${quiet} mt-2`} disabled={busy} onClick={() => run(() => wallet.reclaim(payment.id))} title="If your contact never picks it up, the ecash is still yours">
          Take it back
        </button>
      )}
      {error && <p className="text-danger text-[11px] m-0 mt-1">{error}</p>}
    </div>
  );
}
