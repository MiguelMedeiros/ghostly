import { useState } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

const STATE_LABEL = {
  payment: { pending: "Waiting for your contact…", settled: "Received", failed: "Failed", reclaimed: "Taken back" },
  request: { pending: "Waiting for payment", settled: "Paid", failed: "Failed", reclaimed: "" },
} as const;

/** A payment or a payment request in the chat. The amounts are live: they follow what the wallet knows. */
export function PaymentBubble({ paymentId, peerPubKey, fallbackText }: { paymentId: string; peerPubKey: string; fallbackText: string }) {
  const wallet = useServicesPlatform()?.wallet;
  const payment = wallet?.getPayment(paymentId) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

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

  const outgoing = payment.direction === "out";
  const isRequest = payment.kind === "request";
  const title = isRequest ? (outgoing ? "You requested" : "Requests") : outgoing ? "You sent" : "Sent you";
  const button =
    "px-3 py-1.5 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const quiet = "px-3 py-1.5 bg-black/20 hover:bg-black/30 rounded-lg text-xs font-bold transition-colors cursor-pointer";

  return (
    <div className="min-w-[210px] max-w-[300px] px-1 py-0.5" data-testid="payment-bubble" data-state={payment.state}>
      <p className="text-[11px] uppercase tracking-wider text-[hsla(0,0%,100%,0.6)] m-0">{title}</p>
      <p className="m-0 leading-tight">
        <span className="text-[22px] font-semibold">⚡ {payment.amount.toLocaleString()}</span>
        <span className="text-xs ml-1 text-[hsla(0,0%,100%,0.7)]">sats</span>
      </p>
      {payment.memo && <p className="text-[13px] m-0 mt-0.5 wrap-break-word">{payment.memo}</p>}
      <p
        className={`text-[11px] m-0 mt-1 ${payment.state === "failed" ? "text-danger" : payment.state === "settled" ? "text-accent" : "text-[hsla(0,0%,100%,0.6)]"}`}
        data-testid="payment-state"
      >
        {STATE_LABEL[payment.kind][payment.state]}
        {payment.error && payment.state !== "settled" ? ` · ${payment.error}` : ""}
      </p>

      {isRequest && !outgoing && payment.state === "pending" && (
        <div className="flex gap-2 mt-2">
          <button data-testid="payment-pay" className={button} disabled={busy} onClick={() => run(() => wallet.payRequest(peerPubKey, payment.id))}>
            {busy ? "Paying…" : "Pay"}
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
      {!isRequest && outgoing && payment.state === "pending" && (
        <button className={`${quiet} mt-2`} disabled={busy} onClick={() => run(() => wallet.reclaim(payment.id))} title="If your contact never picks it up, the ecash is still yours">
          Take it back
        </button>
      )}
      {error && <p className="text-danger text-[11px] m-0 mt-1">{error}</p>}
    </div>
  );
}
