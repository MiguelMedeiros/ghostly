import { formatPaymentAmount, parsePaymentAmount } from "@ghostly/core";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { rememberRail, rememberedRail, type ChatPaymentMethods } from "../lib/chatPayments";
import type { WalletPlatform } from "../lib/platform";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "./PaymentReview";
import { WalletMark, type ChatRail } from "./WalletCards";
import { CardDeck, WalletCardFace } from "./WalletDeck";
import { ONCHAIN_FEE_CAP, walletCards, type WalletCard } from "./walletCardData";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { ComposerSheet, ComposerSheetHead, ForwardArrow } from "./ComposerSheet";
import { CardFlip, FlipTurnButton } from "./deck/Flip";
import { useCardFlip } from "./deck/useCardFlip";
import { ChatPaymentAccept } from "./ChatPaymentAccept";
import "./payment-composer.css";

interface PaymentComposerProps {
  balance: number;
  onSend: (amount: number, memo: string) => Promise<string | null>;
  /** `rail`: the card it was made on, for a request that must carry that way of paying only (groups). */
  onRequest: (amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark", rail?: ChatRail) => Promise<string | null>;
  onClose: () => void;
  reviewContext?:{wallet:WalletPlatform;peer:string;linkId:string};
  /** Who the chat is with, as the chat shows them. */
  contact?: string;
  /** Only these cards can be used here (a request to a whole group); the others say why not. */
  rails?: readonly ChatRail[];
  /** Why Send cannot be used here, when it cannot (a request to a whole group has nobody to send to). */
  sendUnavailable?: string;
  /** Goes back to whatever came before the cards (choosing whom to pay, in a group). */
  onBack?: () => void;
  /** What Send and Request do on a card here, when it is not what they do in a chat. */
  describe?: (rail: ChatRail) => string;
  /** Why no card can pay or request here now (the contact takes no payments in this chat): Accept still opens. */
  payUnavailable?: string;
  /**
   * A chat's own ways of paying: with this, the composer has an Accept side beside Pay, where they are chosen, and
   * Pay shows only the cards this chat has on. Without it (a group) every card shows, and one off here says so.
   */
  onSaveMethods?: (methods: ChatPaymentMethods) => Promise<void>;
}

type Mode = "pay" | "accept";
/** Cashu fees are per proof: a few sats at most. The review shows the real fee before anything is spent. */
const CASHU_FEE_CAP = 10;
const RAILS = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const;

/**
 * Popover over the message input, as a wallet: the cards in a stack, one comes up as the pointer passes over it
 * (or a finger swipes to it), and the one clicked turns over. Its back is where the amount and what it is for are
 * written, then Request or Send. The wallets are already set up, so there is nothing else to choose; every send
 * still stops at a review.
 */
export function PaymentComposer({ balance, onSend, onRequest, onClose, reviewContext, contact, rails, sendUnavailable, onBack, describe, payUnavailable, onSaveMethods }: PaymentComposerProps) {
  const { t } = useI18n();
  const wallet = reviewContext?.wallet;
  const state = wallet?.getState();
  const chat = reviewContext?.peer;
  const peer = useServicesPlatform()?.getPeer(chat ?? "");
  const who = contact || "your contact";
  /** Why a card cannot be used in this chat: not set up, off here, or off for the contact. */
  const unavailable = (card: Pick<WalletCard, "name" | "ready" | "balance" | "status"> & { id: ChatRail }) => {
    // A card with nothing to connect to yet (no mint, no source) says so; one on its way says where it is ("Ark is connecting…").
    if (payUnavailable) return payUnavailable;
    if (rails && !rails.includes(card.id)) return `${card.name} cannot be used here`;
    if (!card.ready) return card.status === "Set up" || card.status === "Shared balance" ? `${card.name} is not set up yet` : `${card.name} is ${card.balance.toLowerCase()}`;
    if (peer?.paymentMethods && !peer.paymentMethods[card.id]) return `${card.name} is off in this chat`;
    if (peer?.dataLink === "open" && peer.capabilities?.methods && !peer.capabilities.methods[card.id]) return `Your contact does not accept ${card.name} in this chat`;
    return undefined;
  };
  const cards = state && wallet ? walletCards(state, wallet.testMintUrls) : [];
  // With an Accept side, a card this chat has off is chosen there, not shown on Pay.
  const offHere = (id: ChatRail) => !!peer?.paymentMethods && !peer.paymentMethods[id];
  const payCards = onSaveMethods ? cards.filter((c) => !offHere(c.id)) : cards;
  /**
   * The card Pay starts on: the one this chat used last, while it can still be used, else the first one that can, in
   * the deck's order. Without a wallet to show (only the back), as the chat allows.
   */
  const firstUsable = (): ChatRail | undefined => {
    if (!cards.length) return RAILS.find((id) => (!rails || rails.includes(id)) && !offHere(id));
    const last = rememberedRail(chat);
    return payCards.find((c) => c.id === last && !unavailable(c))?.id ?? payCards.find((c) => !unavailable(c))?.id;
  };
  const [rail, setRail] = useState<ChatRail>(() => firstUsable() ?? payCards[0]?.id ?? "cashu");
  // Until a card is picked, the deck follows the wallet as it comes up (a mint still loading, Ark connecting): it
  // moves to the first card that can be used, and never rests on one Pay does not show.
  const picked = useRef(false);
  const pick = (id: ChatRail) => { picked.current = true; setRail(id); };
  const railShown = payCards.some((c) => c.id === rail);
  const railBlocked = !!payCards.find((c) => c.id === rail && unavailable(c));
  const usable = firstUsable();
  useEffect(() => {
    if (railShown && (picked.current || !railBlocked)) return;
    const next = usable ?? (railShown ? undefined : payCards[0]?.id);
    if (next && next !== rail) setRail(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railShown, railBlocked, usable, payCards.length]);
  // Pay, or Accept: which ways this chat takes. A chat that has every way off opens on Accept, to turn one on.
  const [mode, setMode] = useState<Mode>(() => onSaveMethods && cards.length && !payCards.length ? "accept" : "pay");
  // The cards, then the chosen one turned over (deck/Flip.tsx). Without a wallet to show, only the back.
  const { side, flipped, turn, turnBack } = useCardFlip(state && wallet ? "cards" : "back");
  const [review, setReview] = useState<Review | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"send" | "request" | null>(null);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(containerRef, true, onClose);

  const method: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark" = rail === "lightning" ? "cashu" : rail;
  const usdt = state?.usdt;
  const unit = method === "usdt" ? (usdt?.chainId && usdt.chainId !== 1 ? "TEST-USDT" : "USDT") : method === "arkade" ? (state?.ark?.network && state.ark.network !== "bitcoin" ? "test sats" : "sats") : method === "bark" ? (state?.bark?.network !== "bitcoin" ? "test sats" : "sats") : method === "spark" ? (state?.spark?.network !== "bitcoin" ? "test sats" : "sats") : method === "bitcoin" ? (state?.bitcoin?.network && state.bitcoin.network !== "bitcoin" ? "test sats" : "sats")
    : method === "fedimint" ? (state?.fedimint?.federations.some((f) => f.network === "bitcoin") && state.mode !== "testnet" ? "sats" : "test sats") : state?.mode === "testnet" ? "test sats" : "sats";
  const decimals = method === "usdt" ? usdt?.decimals ?? 6 : 0;
  const value = Number(amount);
  // Ecash goes straight to the contact; Ark, Bark, Spark, on-chain and USDT ask the contact's app for an address first. Lightning
  // pays a request the contact sends.
  const canSend = rail !== "lightning" && !sendUnavailable;
  const [asking, setAsking] = useState<string | null>(null);
  const card = cards.find((c) => c.id === rail);
  const blocked = card ? unavailable(card) : undefined;
  // A card that cannot be used says so on its face, briefly; its title says why in full.
  const shown = payCards.map((c) => { const why = unavailable(c); return !why || !c.ready ? c : { ...c, status: why.startsWith("Your contact") ? "Not accepted" : "Off here" }; });

  /** Turn the chosen card over, and back to the cards. */
  const use = (next: ChatRail) => {
    pick(next); setError("");
    rememberRail(chat, next);
    turn();
  };
  const backToCards = () => { setError(""); turnBack(); };
  // On the cards, the keyboard starts on the chosen one: arrows move, Enter turns it over. Once turned, on the amount
  // (not as the back mounts: it is still face down then, and a hidden field takes no focus).
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (side === "cards") containerRef.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"], [role=checkbox][tabindex="0"]')?.focus({ preventScroll: true });
    else if (flipped) amountRef.current?.focus({ preventScroll: true });
  }, [side, flipped]);
  useSheetRoom(containerRef);

  const send = async () => {
    setError(""); setBusy("send");
    try {
      if (reviewContext && (method === "arkade" || method === "bark" || method === "spark" || method === "bitcoin" || method === "usdt" || method === "fedimint")) {
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
      if (answer && !answer.target && answer.federations) {
        // Fedimint, but no federation in common: their request carries an invoice of their federation instead.
        clearInterval(timer);
        setAsking(null);
        setError(answer.invoice ? `You and ${who} share no federation: pay their request over Lightning, with Review payment on it in the chat.` : `You and ${who} share no federation, and their request has no Lightning invoice.`);
      } else if (answer?.target) {
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
  }, [asking, reviewContext, who]);

  const request = async () => {
    setError(""); setBusy("request");
    try {
      const err = await onRequest(method === "usdt" ? parsePaymentAmount(amount, decimals) : value, memo, method, rail);
      if (err) setError(err); else onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not prepare request"); }
    finally { setBusy(null); }
  };

  // USDT's balance is in the token's smallest units; the amount is typed in whole tokens.
  const spendable = method === "cashu" ? balance : method === "arkade" ? state?.ark?.balance : method === "bark" ? state?.bark?.balance : method === "spark" ? state?.spark?.balance : method === "bitcoin" ? state?.bitcoin?.balance : method === "fedimint" ? state?.fedimint?.balance : usdt ? Number(formatPaymentAmount(usdt.balance, decimals)) : undefined;
  const tooMuch = spendable !== undefined && value > spendable;
  /** What Send and Request do on this card, with this contact. */
  const how = (id: ChatRail) => describe ? describe(id) : id === "cashu"
    ? `Send gives ${who} ecash straight away; a request also carries a Lightning invoice.`
    : id === "lightning" ? `Request with a Lightning invoice. To pay ${who} over Lightning, tap Pay on their request.`
    : id === "fedimint" ? `Send asks ${who}'s app which federations it takes: ecash of one you share, after a review. Otherwise their request carries a Lightning invoice.`
    : id === "spark" ? `Send asks ${who}'s app for a Spark invoice, then shows the payment to approve: Spark to Spark, instant, no Lightning hop.`
    : `Send asks ${who}'s app for a ${id === "arkade" ? "fresh Ark" : id === "bark" ? "fresh Bark" : id === "bitcoin" ? "fresh Bitcoin" : "USDT"} address, then shows the payment to approve.${id === "bitcoin" ? " Paid once it confirms on-chain." : ""}`;

  const back = (
    <div className={`payment-back${card ? ` wallet-card-${card.id}` : ""}`} data-testid="payment-back">
      <div className="payment-back-stripe" aria-hidden="true" />
      <div className="payment-back-body">
        <div className="payment-back-head">
          {card && <span className="payment-back-mark" aria-hidden="true"><WalletMark rail={card.id} /></span>}
          <span className="payment-back-title">
            <span className="payment-back-name">{card?.name ?? "Payment"}</span>
            <span className="payment-back-meta">{card ? `${card.balance} · with ${who}` : `With ${who}`}</span>
          </span>
          {cards.length > 0 && !review && (
            <FlipTurnButton testId="payment-change-card" label="Choose another card" onClick={backToCards} />
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
              title={canSend ? undefined : sendUnavailable ?? "To pay on this card, tap Pay on your contact's request"} className="payment-back-primary">
              {asking ? "Asking for an address…" : busy === "send" ? "Preparing…" : "Send"}
            </button>
          </div>
        </>}
        {error && <p role="alert" className="text-danger text-xs m-0">{error}</p>}
      </div>
    </div>
  );

  const switchMode = (next: Mode) => { setMode(next); setError(""); };
  const MODES: Mode[] = ["pay", "accept"];
  const modeKeys = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    switchMode(next);
    containerRef.current?.querySelector<HTMLElement>(`[data-testid="payment-mode-${next}"]`)?.focus();
  };
  // Pay, and Accept beside it: two sides of one sheet, chosen in its head.
  const modes = onSaveMethods && (
    <span role="tablist" aria-label={t("payments.mode.label", { name: who })} className="payment-modes" onKeyDown={modeKeys}>
      {MODES.map((m) => (
        <button key={m} type="button" role="tab" data-testid={`payment-mode-${m}`} aria-selected={mode === m} tabIndex={mode === m ? 0 : -1} onClick={() => switchMode(m)}>
          {t(m === "pay" ? "payments.mode.pay" : "payments.mode.accept")}
        </button>
      ))}
    </span>
  );
  const accepting = !!onSaveMethods && mode === "accept";

  return (
    <ComposerSheet
      ref={containerRef}
      data-testid="payment-composer"
      data-side={side}
      data-mode={onSaveMethods ? mode : undefined}
      className={`payment-composer${accepting ? "" : ` wallet-card-${rail}`}`}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {side === "cards" ? <>
        <ComposerSheetHead title={modes || (sendUnavailable ? "Request" : "Pay or request")} who={`with ${who}`} before={onBack && <button type="button" className="deck-flip-turn" data-testid="payment-recipient-change" aria-label="Choose someone else" title="Choose someone else" onClick={onBack}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>} />
        {accepting && onSaveMethods ? <ChatPaymentAccept peer={peer} contact={who} cards={cards} onSave={onSaveMethods} />
          : !shown.length && onSaveMethods ? <div className="payment-none" data-testid="payment-none">
            <p className="composer-sheet-hint">{t("payments.none.text")}</p>
            <button type="button" data-testid="payment-none-accept" className="composer-sheet-action" data-variant="secondary" onClick={() => switchMode("accept")}>
              {t("payments.none.action")}
            </button>
          </div>
          : <>
            <CardDeck compact kind="radios" label="Pay with" name="payment-deck" cards={shown} selected={rail} onSelect={(id) => { pick(id); setError(""); }} onChoose={use}
              testId={(id) => `payment-card-${id}`} blocked={(c) => unavailable(c)} size={{ max: 250, share: .62 }} />
            <p className="composer-sheet-hint" data-blocked={blocked ? true : undefined}>{blocked ?? how(rail)}</p>
            <button type="button" data-testid="payment-use" className="composer-sheet-action" disabled={!!blocked} onClick={() => use(rail)}>
              {card ? `Use ${card.name}` : "Continue"}
              <ForwardArrow />
            </button>
          </>}
      </> : card ? <CardFlip className="payment" flipped={flipped} tone={`wallet-card-${card.id}`} front={<WalletCardFace card={card} />} back={back} /> : back}
    </ComposerSheet>
  );
}

/**
 * The room the sheet has over the composer on a desktop: from its bottom edge (over the message field) up to the
 * window's top. Past that it scrolls, its action kept in view (payment-composer.css), so a short window (the
 * extension's side panel, a laptop split in two) still reaches Use and Save. A phone's sheet has its own height.
 */
function useSheetRoom(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--sheet-room", `${Math.max(180, Math.floor(el.getBoundingClientRect().bottom - 8))}px`);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref]);
}
