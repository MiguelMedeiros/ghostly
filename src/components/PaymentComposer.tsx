import { parsePaymentAmount } from "@ghostly/core";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useEffect, useRef, useState } from "react";
import type { WalletPlatform } from "../lib/platform";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "./PaymentReview";
import { MiniCards, type ChatRail } from "./WalletCards";
import { walletCards, type WalletCard } from "./walletCardData";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

interface PaymentComposerProps {
  balance: number;
  onSend: (amount: number, memo: string) => Promise<string | null>;
  onRequest: (amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark") => Promise<string | null>;
  onClose: () => void;
  reviewContext?:{wallet:WalletPlatform;peer:string;linkId:string};
}

const RAIL_KEY = "ghostly-payment-rail";
/** Cashu fees are per proof: a few sats at most. The review shows the real fee before anything is spent. */
const CASHU_FEE_CAP = 10;

/**
 * Popover over the message input: pick a card, type an amount, request or send. The wallets are
 * already set up, so there is nothing else to choose; every send still stops at a review.
 */
export function PaymentComposer({ balance, onSend, onRequest, onClose, reviewContext }: PaymentComposerProps) {
  const wallet = reviewContext?.wallet;
  const state = wallet?.getState();
  const peer = useServicesPlatform()?.getPeer(reviewContext?.peer ?? "");
  /** Why a card cannot be used in this chat: not set up, off here, or off for the contact. */
  const unavailable = (card: Pick<WalletCard, "name" | "ready" | "balance"> & { id: ChatRail }) => {
    if (!card.ready) return `${card.name} is ${card.balance.toLowerCase()}`;
    if (peer?.paymentMethods && !peer.paymentMethods[card.id]) return `${card.name} is off in this chat`;
    if (peer?.dataLink === "open" && peer.capabilities?.methods && !peer.capabilities.methods[card.id]) return `Your contact does not accept ${card.name} in this chat`;
    return undefined;
  };
  const [rail, setRail] = useState<ChatRail>(() => {
    const allowed = (id: ChatRail) => !peer?.paymentMethods || peer.paymentMethods[id];
    try { const saved = localStorage.getItem(RAIL_KEY); if ((saved === "cashu" || saved === "lightning" || saved === "arkade" || saved === "bark" || saved === "usdt") && allowed(saved)) return saved; } catch { /* storage unavailable */ }
    return (["cashu", "lightning", "arkade", "bark", "usdt"] as const).find(allowed) ?? "cashu";
  });
  const [review, setReview] = useState<Review | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"send" | "request" | null>(null);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(containerRef, true, onClose);

  const method: "cashu" | "arkade" | "usdt" | "bark" = rail === "lightning" ? "cashu" : rail;
  const usdt = state?.usdt;
  const unit = method === "usdt" ? (usdt?.chainId && usdt.chainId !== 1 ? "TEST-USDT" : "USDT") : method === "arkade" ? (state?.ark?.network && state.ark.network !== "bitcoin" ? "test sats" : "sats") : method === "bark" ? (state?.bark?.network !== "bitcoin" ? "test sats" : "sats") : state?.mode === "testnet" ? "test sats" : "sats";
  const decimals = method === "usdt" ? usdt?.decimals ?? 6 : 0;
  const value = Number(amount);
  // Ecash goes straight to the contact; Ark, Bark and USDT ask the contact's app for an address first. Lightning
  // pays a request the contact sends.
  const canSend = rail !== "lightning";
  const [asking, setAsking] = useState<string | null>(null);
  const blocked = state && wallet ? unavailable(walletCards(state, wallet.testMintUrls).find((c): c is WalletCard & { id: ChatRail } => c.id === rail)!) : undefined;
  const pick = (next: ChatRail) => { setRail(next); setError(""); try { localStorage.setItem(RAIL_KEY, next); } catch { /* storage unavailable */ } };

  const send = async () => {
    setError(""); setBusy("send");
    try {
      if (reviewContext && (method === "arkade" || method === "bark" || method === "usdt")) {
        const units = method === "usdt" ? parsePaymentAmount(amount, decimals) : value;
        setAsking((await reviewContext.wallet.askToPay(reviewContext.peer, units, method, memo || undefined)).askId);
        return;
      }
      if (reviewContext && state) {
        // The mint that can pay: test sats only when that is all there is, never mixed with real ones.
        const mint = [...state.mints].sort((a, b) => b.balance - a.balance).find((m) => m.balance >= value + CASHU_FEE_CAP) ?? [...state.mints].sort((a, b) => b.balance - a.balance)[0];
        if (!mint) throw new Error("Add a Cashu mint first");
        setReview(await reviewContext.wallet.preparePayment({ target: { method: "cashu", network: reviewContext.wallet.testMintUrls.includes(mint.url) ? "cashu-test" : "bitcoin", provider: mint.url, address: reviewContext.peer, asset: "BTC", unit: "sat", expiresAt: Date.now() + 15 * 60 * 1000 }, amount: value, feeCap: CASHU_FEE_CAP, payee: reviewContext.peer, linkId: reviewContext.linkId, memo: memo || undefined }));
      } else {
        const err = await onSend(value, memo);
        if (err) setError(err); else onClose();
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not prepare payment"); }
    finally { setBusy(null); }
  };
  // The contact's app answers an ask with a request: review it here, as Pay on that request would.
  useEffect(() => {
    if (!asking || !reviewContext) return;
    const context = reviewContext, started = Date.now();
    const timer = setInterval(() => {
      const answer = context.wallet.answerTo(asking);
      if (answer?.target) {
        clearInterval(timer);
        const token = answer.target.method === "usdt";
        void context.wallet.preparePayment({ target: answer.target, amount: answer.amount, feeCap: token ? parsePaymentAmount("0.001", 18) : 10, payee: context.peer, linkId: answer.linkId, requestId: answer.id })
          .then(setReview, (e: unknown) => setError(e instanceof Error ? e.message : "Could not prepare payment"))
          .finally(() => setAsking(null));
      } else if (Date.now() - started > 45_000) {
        clearInterval(timer);
        setAsking(null);
        setError("Your contact's app did not answer. It may be offline or need an update; they can send you a Request instead.");
      }
    }, 400);
    return () => clearInterval(timer);
  }, [asking, reviewContext]);

  const request = async () => {
    setError(""); setBusy("request");
    try {
      const err = await onRequest(method === "usdt" ? parsePaymentAmount(amount, decimals) : value, memo, method);
      if (err) setError(err); else onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not prepare request"); }
    finally { setBusy(null); }
  };

  const field = "w-full bg-input-bg border-none rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent";
  const spendable = method === "cashu" ? balance : method === "arkade" ? state?.ark?.balance : method === "bark" ? state?.bark?.balance : usdt ? Number(usdt.balance) : undefined;

  return (
    <>
    <div className="sheet-backdrop" />
    <div
      ref={containerRef}
      data-testid="payment-composer"
      className="sheet sheet-padded absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[360px] max-w-[calc(100vw-1.5rem)] bg-panel-header border border-border rounded-2xl shadow-2xl p-3 space-y-3"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {state && wallet ? (
        <MiniCards state={state} testMints={wallet.testMintUrls} selected={rail} onSelect={pick} disabled={unavailable} />
      ) : <p className="text-text-secondary text-xs font-bold uppercase tracking-wider m-0">Payment</p>}

      <label className="flex items-baseline gap-2 bg-input-bg rounded-xl px-3 py-2.5 focus-within:ring-1 focus-within:ring-accent">
        <input data-testid="payment-amount" autoFocus inputMode={decimals ? "decimal" : "numeric"} placeholder="0" aria-label={`Amount in ${unit}`}
          className="min-w-0 flex-1 bg-transparent border-none outline-none text-2xl font-semibold text-text-primary placeholder-text-muted tabular-nums"
          value={amount} onChange={(e) => setAmount(e.target.value.replace(decimals ? /[^0-9.]/g : /\D/g, ""))} />
        <span className="text-text-muted text-sm shrink-0">{unit}</span>
      </label>
      <input className={field} placeholder="What for? (optional)" maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />

      <div className="grid grid-cols-2 gap-2">
        <button data-testid="payment-request" disabled={!value || busy !== null || !!asking || !!blocked} onClick={() => void request()}
          className="px-3 py-2.5 bg-surface-hover text-text-primary rounded-xl text-sm font-semibold hover:brightness-110 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
          {busy === "request" ? "Requesting…" : "Request"}
        </button>
        <button data-testid="payment-send" disabled={!canSend || !!blocked || !value || busy !== null || !!asking || (spendable !== undefined && value > spendable) || !!review} onClick={() => void send()}
          title={canSend ? undefined : "To pay on this card, tap Pay on your contact's request"}
          className="px-3 py-2.5 bg-accent text-[#111b21] rounded-xl text-sm font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
          {asking ? "Asking for an address…" : busy === "send" ? "Preparing…" : "Send"}
        </button>
      </div>
      <p className="text-text-muted text-[11px] leading-snug m-0">
        {blocked ? blocked : canSend
          ? `${balance.toLocaleString()} sats available. Sent as ecash straight to your contact; requests also carry a Lightning invoice.`
          : rail === "lightning" ? "Request with a Lightning invoice. To pay over Lightning, tap Pay on your contact's request."
          : `Send asks your contact's app for a ${rail === "arkade" ? "fresh Ark" : rail === "bark" ? "fresh Bark" : "USDT"} address, then shows the payment to approve.`}
      </p>
      {review && reviewContext && <PaymentReview key={review.id} review={review} wallet={reviewContext.wallet} onClose={onClose} />}
      {error && <p className="text-danger text-xs m-0">{error}</p>}
    </div>
    </>
  );
}
