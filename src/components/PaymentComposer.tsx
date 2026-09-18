import { useEffect, useRef, useState } from "react";

interface PaymentComposerProps {
  balance: number;
  onSend: (amount: number, memo: string) => Promise<string | null>;
  onRequest: (amount: number, memo: string) => Promise<string | null>;
  onClose: () => void;
}

/** Popover over the message input: send sats to this contact, or ask them for some. */
export function PaymentComposer({ balance, onSend, onRequest, onClose }: PaymentComposerProps) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"send" | "request" | null>(null);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);

  const submit = async (kind: "send" | "request") => {
    setError("");
    setBusy(kind);
    const err = await (kind === "send" ? onSend : onRequest)(Number(amount), memo);
    setBusy(null);
    if (err) setError(err);
    else onClose();
  };

  const field =
    "w-full bg-input-bg border-none rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent";
  const value = Number(amount);

  return (
    <div
      ref={containerRef}
      data-testid="payment-composer"
      className="absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[300px] bg-panel-header border border-border rounded-xl shadow-2xl p-3 space-y-2"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="flex items-center justify-between">
        <span className="text-text-secondary text-xs font-bold uppercase tracking-wider">⚡ Sats</span>
        <span className="text-text-muted text-[11px]">You have {balance.toLocaleString()}</span>
      </div>
      <input data-testid="payment-amount" autoFocus className={field} inputMode="numeric" placeholder="Amount in sats" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
      <input className={field} placeholder="What for? (optional)" maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />
      <div className="flex gap-2">
        <button
          data-testid="payment-send"
          disabled={!value || busy !== null || value > balance}
          onClick={() => void submit("send")}
          className="flex-1 px-3 py-2 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "send" ? "Sending…" : "Send"}
        </button>
        <button
          data-testid="payment-request"
          disabled={!value || busy !== null}
          onClick={() => void submit("request")}
          className="flex-1 px-3 py-2 bg-surface-hover text-text-primary rounded-lg text-xs font-bold hover:brightness-110 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "request" ? "Requesting…" : "Request"}
        </button>
      </div>
      <p className="text-text-muted text-[11px] leading-snug m-0">
        Sent as ecash, straight to your contact. A request also carries a Lightning invoice, so it can be paid from any
        wallet.
      </p>
      {error && <p className="text-danger text-xs m-0">{error}</p>}
    </div>
  );
}
