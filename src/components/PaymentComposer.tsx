import { formatPaymentAmount, parsePaymentAmount } from "@ghostly/core";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WalletPlatform } from "../lib/platform";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "./PaymentReview";
import { WalletMark, type ChatRail } from "./WalletCards";
import { CardDeck, WalletCardFace } from "./WalletDeck";
import { ONCHAIN_FEE_CAP, walletCards, type WalletCard } from "./walletCardData";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import "./payment-composer.css";

interface PaymentComposerProps {
  balance: number;
  onSend: (amount: number, memo: string) => Promise<string | null>;
  onRequest: (amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin") => Promise<string | null>;
  onClose: () => void;
  reviewContext?:{wallet:WalletPlatform;peer:string;linkId:string};
  /** Who the chat is with, as the chat shows them. */
  contact?: string;
}

const RAIL_KEY = "ghostly-payment-rail";
/** Cashu fees are per proof: a few sats at most. The review shows the real fee before anything is spent. */
const CASHU_FEE_CAP = 10;
const RAILS = ["cashu", "lightning", "arkade", "bark", "bitcoin", "usdt"] as const;
const FLIP_MS = 520;
const reducedMotion = () => document.documentElement.dataset.reduceMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Popover over the message input, as a wallet: the cards in a stack, one comes up as the pointer passes over it
 * (or a finger swipes to it), and the one clicked turns over. Its back is where the amount and what it is for are
 * written, then Request or Send. The wallets are already set up, so there is nothing else to choose; every send
 * still stops at a review.
 */
export function PaymentComposer({ balance, onSend, onRequest, onClose, reviewContext, contact }: PaymentComposerProps) {
  const wallet = reviewContext?.wallet;
  const state = wallet?.getState();
  const peer = useServicesPlatform()?.getPeer(reviewContext?.peer ?? "");
  const who = contact || "your contact";
  /** Why a card cannot be used in this chat: not set up, off here, or off for the contact. */
  const unavailable = (card: Pick<WalletCard, "name" | "ready" | "balance" | "status"> & { id: ChatRail }) => {
    // A card with nothing to connect to yet says so; one on its way says where it is ("Ark is connecting…").
    if (!card.ready) return card.status === "Set up" ? `${card.name} is not set up yet` : `${card.name} is ${card.balance.toLowerCase()}`;
    if (peer?.paymentMethods && !peer.paymentMethods[card.id]) return `${card.name} is off in this chat`;
    if (peer?.dataLink === "open" && peer.capabilities?.methods && !peer.capabilities.methods[card.id]) return `Your contact does not accept ${card.name} in this chat`;
    return undefined;
  };
  const [rail, setRail] = useState<ChatRail>(() => {
    const allowed = (id: ChatRail) => !peer?.paymentMethods || peer.paymentMethods[id];
    try { const saved = localStorage.getItem(RAIL_KEY); if ((RAILS as readonly string[]).includes(saved ?? "") && allowed(saved as ChatRail)) return saved as ChatRail; } catch { /* storage unavailable */ }
    return RAILS.find(allowed) ?? "cashu";
  });
  // The cards, then the chosen one turned over. Without a wallet to show, only the back.
  const [side, setSide] = useState<"cards" | "back">(state && wallet ? "cards" : "back");
  const [flipped, setFlipped] = useState(!(state && wallet));
  const [review, setReview] = useState<Review | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"send" | "request" | null>(null);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(containerRef, true, onClose);

  const method: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" = rail === "lightning" ? "cashu" : rail;
  const usdt = state?.usdt;
  const unit = method === "usdt" ? (usdt?.chainId && usdt.chainId !== 1 ? "TEST-USDT" : "USDT") : method === "arkade" ? (state?.ark?.network && state.ark.network !== "bitcoin" ? "test sats" : "sats") : method === "bark" ? (state?.bark?.network !== "bitcoin" ? "test sats" : "sats") : method === "bitcoin" ? (state?.bitcoin?.network && state.bitcoin.network !== "bitcoin" ? "test sats" : "sats") : state?.mode === "testnet" ? "test sats" : "sats";
  const decimals = method === "usdt" ? usdt?.decimals ?? 6 : 0;
  const value = Number(amount);
  // Ecash goes straight to the contact; Ark, Bark, on-chain and USDT ask the contact's app for an address first. Lightning
  // pays a request the contact sends.
  const canSend = rail !== "lightning";
  const [asking, setAsking] = useState<string | null>(null);
  const cards = state && wallet ? walletCards(state, wallet.testMintUrls) : [];
  const card = cards.find((c) => c.id === rail);
  const blocked = card ? unavailable(card) : undefined;
  // A card that cannot be used says so on its face, briefly; its title says why in full.
  const shown = cards.map((c) => { const why = unavailable(c); return !why || !c.ready ? c : { ...c, status: why.startsWith("Your contact") ? "Not accepted" : "Off here" }; });

  /** Turn the chosen card over, and back to the cards. */
  const use = (next: ChatRail) => {
    setRail(next); setError("");
    try { localStorage.setItem(RAIL_KEY, next); } catch { /* storage unavailable */ }
    setSide("back");
  };
  useLayoutEffect(() => {
    if (side !== "back") return;
    // Mounted face up, then turned: the turn is a transition from the front.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setFlipped(true)); });
    return () => cancelAnimationFrame(frame);
  }, [side]);
  const backToCards = () => {
    setFlipped(false); setError("");
    setTimeout(() => setSide("cards"), reducedMotion() ? 0 : FLIP_MS);
  };
  // On the cards, the keyboard starts on the chosen one: arrows move, Enter turns it over. Once turned, on the amount
  // (not as the back mounts: it is still face down then, and a hidden field takes no focus).
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (side === "cards") containerRef.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"]')?.focus({ preventScroll: true });
    else if (flipped) amountRef.current?.focus({ preventScroll: true });
  }, [side, flipped]);

  // The back grows to what it holds (a review is long); the card follows its height as it turns.
  const backRef = useRef<HTMLDivElement>(null), flipRef = useRef<HTMLDivElement>(null);
  const [backHeight, setBackHeight] = useState(0), [cardWidth, setCardWidth] = useState(0);
  useLayoutEffect(() => {
    const back = backRef.current, box = flipRef.current;
    if (!back || !box) return;
    const measure = () => { setBackHeight(back.offsetHeight); setCardWidth(box.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(back); observer.observe(box);
    return () => observer.disconnect();
  }, [side]);
  const cardHeight = Math.round(cardWidth / 1.586);

  const send = async () => {
    setError(""); setBusy("send");
    try {
      if (reviewContext && (method === "arkade" || method === "bark" || method === "bitcoin" || method === "usdt")) {
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
        void context.wallet.preparePayment({ target: answer.target, amount: answer.amount, feeCap: token ? parsePaymentAmount("0.001", 18) : answer.target.method === "bitcoin" ? ONCHAIN_FEE_CAP : CASHU_FEE_CAP, payee: context.peer, linkId: answer.linkId, requestId: answer.id })
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

  // USDT's balance is in the token's smallest units; the amount is typed in whole tokens.
  const spendable = method === "cashu" ? balance : method === "arkade" ? state?.ark?.balance : method === "bark" ? state?.bark?.balance : method === "bitcoin" ? state?.bitcoin?.balance : usdt ? Number(formatPaymentAmount(usdt.balance, decimals)) : undefined;
  const tooMuch = spendable !== undefined && value > spendable;
  /** What Send and Request do on this card, with this contact. */
  const how = (id: ChatRail) => id === "cashu"
    ? `Send gives ${who} ecash straight away; a request also carries a Lightning invoice.`
    : id === "lightning" ? `Request with a Lightning invoice. To pay ${who} over Lightning, tap Pay on their request.`
    : `Send asks ${who}'s app for a ${id === "arkade" ? "fresh Ark" : id === "bark" ? "fresh Bark" : id === "bitcoin" ? "fresh Bitcoin" : "USDT"} address, then shows the payment to approve.${id === "bitcoin" ? " Paid once it confirms on-chain." : ""}`;

  const back = (
    <div ref={backRef} className={`payment-back${card ? ` wallet-card-${card.id}` : ""}`} data-testid="payment-back">
      <div className="payment-back-stripe" aria-hidden="true" />
      <div className="payment-back-body">
        <div className="payment-back-head">
          {card && <span className="payment-back-mark" aria-hidden="true"><WalletMark rail={card.id} /></span>}
          <span className="payment-back-title">
            <span className="payment-back-name">{card?.name ?? "Payment"}</span>
            <span className="payment-back-meta">{card ? `${card.balance} · with ${who}` : `With ${who}`}</span>
          </span>
          {cards.length > 0 && !review && (
            <button type="button" className="payment-back-turn" data-testid="payment-change-card" aria-label="Choose another card" title="Choose another card" onClick={backToCards}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2v3.2h3.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>Cards</span>
            </button>
          )}
        </div>
        {review && reviewContext ? <PaymentReview key={review.id} review={review} wallet={reviewContext.wallet} onClose={onClose} /> : <>
          <label className="payment-back-amount" data-over={tooMuch || undefined}>
            <input ref={amountRef} data-testid="payment-amount" inputMode={decimals ? "decimal" : "numeric"} placeholder="0" aria-label={`Amount in ${unit}`}
              value={amount} onChange={(e) => setAmount(e.target.value.replace(decimals ? /[^0-9.]/g : /\D/g, ""))} />
            <span>{unit}</span>
          </label>
          <input className="payment-back-memo" placeholder="What for? (optional)" aria-label="What for? (optional)" maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />
          <p className="payment-back-hint">{blocked ?? (tooMuch ? `More than the ${spendable!.toLocaleString()} ${unit} on this card.` : how(rail))}</p>
          <div className="payment-back-actions">
            <button data-testid="payment-request" disabled={!value || busy !== null || !!asking || !!blocked} onClick={() => void request()} className="payment-back-secondary">
              {busy === "request" ? "Requesting…" : "Request"}
            </button>
            <button data-testid="payment-send" disabled={!canSend || !!blocked || !value || busy !== null || !!asking || tooMuch} onClick={() => void send()}
              title={canSend ? undefined : "To pay on this card, tap Pay on your contact's request"} className="payment-back-primary">
              {asking ? "Asking for an address…" : busy === "send" ? "Preparing…" : "Send"}
            </button>
          </div>
        </>}
        {error && <p role="alert" className="text-danger text-xs m-0">{error}</p>}
      </div>
    </div>
  );

  return (
    <>
    <div className="sheet-backdrop" />
    <div
      ref={containerRef}
      data-testid="payment-composer"
      data-side={side}
      className={`payment-composer wallet-card-${rail} sheet sheet-padded absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[400px] max-w-[calc(100vw-1.5rem)] bg-panel-header border border-border rounded-2xl shadow-2xl p-3`}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {side === "cards" ? <>
        <div className="payment-composer-head">
          <span>Pay or request</span>
          <span className="payment-composer-who">with {who}</span>
        </div>
        <CardDeck compact kind="radios" label="Pay with" name="payment-deck" cards={shown} selected={rail} onSelect={(id) => { setRail(id); setError(""); }} onChoose={use}
          testId={(id) => `payment-card-${id}`} blocked={(c) => unavailable(c)} size={{ max: 250, share: .62 }} />
        <p className="payment-composer-hint" data-blocked={blocked ? true : undefined}>{blocked ?? how(rail)}</p>
        <button type="button" data-testid="payment-use" className="payment-composer-use" disabled={!!blocked} onClick={() => use(rail)}>
          {card ? `Use ${card.name}` : "Continue"}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </> : card ? (
        <div ref={flipRef} className="payment-flip" data-flipped={flipped} style={{ "--card-w": `${cardWidth}px`, "--card-h": `${cardHeight}px`, height: flipped ? backHeight : cardHeight } as CSSProperties}>
          <div className="payment-flip-card">
            <div className={`payment-flip-front wallet-card-${card.id}`} aria-hidden="true"><WalletCardFace card={card} /></div>
            <div className="payment-flip-back">{back}</div>
          </div>
        </div>
      ) : <div ref={flipRef}>{back}</div>}
    </div>
    </>
  );
}
