import { WALLET_NETWORKS, parsePaymentAmount } from "@ghostly/core";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { cardOn, rememberNetwork, rememberRail, rememberedRail, startNetwork, type ChatAccepts } from "../lib/chatPayments";
import type { WalletNetwork, WalletPlatform } from "../lib/platform";
import { useAppNavigation } from "../hooks/useAppNavigation";
import type { PaymentReview as Review } from "@ghostly/core";
import { NetworkTag, satsIn } from "./NetworkTag";
import { PaymentReview } from "./PaymentReview";
import { WalletMark, type ChatRail } from "./WalletCards";
import { CardDeck, WalletCardFace } from "./WalletDeck";
import { ONCHAIN_FEE_CAP, byNetwork, cardNotSetUp, cardWallet, networkState, receivingFirst, spendable, walletCards, type InstanceCard } from "./walletCardData";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { ComposerSheet, ComposerSheetHead, ForwardArrow } from "./ComposerSheet";
import { CardFlip, FlipTurnButton } from "./deck/Flip";
import { useCardFlip } from "./deck/useCardFlip";
import { ChatPaymentAccept } from "./ChatPaymentAccept";
import { ConfirmRealMoney } from "./ConfirmRealMoney";
import { deckArrows } from "./deck/arrows";
import { NetworkTabs } from "./wallet/NetworkTabs";
import { NETWORK_NAME } from "./wallet/names";
import "./payment-composer.css";
import { formatAmount } from "../lib/amount";
import { useAmountText } from "../hooks/useAmountText";
import { errorText } from "../lib/errorText";

interface PaymentComposerProps {
  balance: number;
  /** `network`: the card's (a Cashu wallet of that network sends). */
  /** `confirmedReal`: the person confirmed a Mainnet send as real money (the engine refuses one without it). */
  onSend: (amount: number, memo: string, network?: WalletNetwork, confirmedReal?: boolean) => Promise<string | null>;
  /** `rail`: the card it was made on, for a request that must carry that way of paying only (groups). `network`: the card's. */
  /** `lightningCard`: the Lightning card picked (one of several on its network), whose invoice the request carries. */
  onRequest: (amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark", rail?: ChatRail, network?: WalletNetwork, lightningCard?: string) => Promise<string | null>;
  onClose: () => void;
  /**
   * A payment sent or a request made: the sheet is done, and the chat's bubble shows the rest. Without it, `onClose`.
   * A failure never calls it: the sheet stays with its error.
   */
  onDone?: () => void;
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
  /** `payUnavailable` is about the contact's side (no wallet, payments off there): the card's face says "Not accepted". */
  payUnavailableContact?: boolean;
  /**
   * A chat's own ways of paying: with this, the composer has an Accept side beside Pay, where they are chosen, and
   * Pay shows only the cards this chat has on. Without it (a group) every card shows, and one off here says so.
   */
  onSaveMethods?: (accepts: ChatAccepts) => Promise<void>;
}

type Mode = "pay" | "accept";
/** What Send and Request do on each card, with this contact (`{{name}}`). */
const HOW = {
  cashu: "payments.composer.how.cashu",
  lightning: "payments.composer.how.lightning",
  fedimint: "payments.composer.how.fedimint",
  spark: "payments.composer.how.spark",
  arkade: "payments.composer.how.arkade",
  bark: "payments.composer.how.bark",
  bitcoin: "payments.composer.how.bitcoin",
  usdt: "payments.composer.how.usdt",
} as const satisfies Record<ChatRail, string>;
/** Cashu fees are per proof: a few sats at most. The review shows the real fee before anything is spent. */
const CASHU_FEE_CAP = 10;

/**
 * Popover over the message input, as a wallet: the cards in a stack, one comes up as the pointer passes over it
 * (or a finger swipes to it), and the one clicked turns over. Its back is where the amount and what it is for are
 * written, then Request or Send. Each card is one wallet on one network; every send still stops at a review, and a
 * card is offered only where the contact has a wallet of its network.
 */
export function PaymentComposer({ balance, onSend, onRequest, onClose, onDone = onClose, reviewContext, contact, rails, sendUnavailable, onBack, describe, payUnavailable, payUnavailableContact, onSaveMethods }: PaymentComposerProps) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const wallet = reviewContext?.wallet;
  const state = wallet?.getState();
  const chat = reviewContext?.peer;
  const peer = useServicesPlatform()?.getPeer(chat ?? "");
  const who = contact || t("payments.composer.yourContact");
  const networkName = (card: InstanceCard) => `${card.network === "testnet" ? "Testnet" : "Mainnet"} ${card.name}`;
  /**
   * Why a card cannot be used in this chat: not set up, off here, off for the contact, or no wallet of its network
   * there. `contact`: it is the contact's side that says no (the card's face says "Not accepted", else "Off here").
   */
  const blockedBy = (card: InstanceCard): { why: string; contact?: boolean } | undefined => {
    // A card with nothing to connect to yet (no mint, no source) says so; one on its way says where it is ("Ark is connecting…").
    // The chat's own reason, in the person's language; its page says whether it is about the contact.
    if (payUnavailable) return { why: payUnavailable, contact: !!payUnavailableContact };
    if (rails && !rails.includes(card.rail)) return { why: t("payments.composer.unavailable.notHere", { card: card.name }) };
    if (!card.ready) return { why: cardNotSetUp(card, t) ? t("payments.composer.unavailable.notSetUp", { card: card.name }) : t("payments.composer.unavailable.status", { card: card.name, status: card.balance.toLowerCase() }) };
    if (peer && !cardOn(peer, card.rail, card.network)) return { why: t("payments.composer.unavailable.offHere", { card: networkName(card) }) };
    // The contact said which networks it has wallets on (none for a kind it has no wallet of): a test card meets only
    // a test wallet, and real money only real.
    const theirs = peer?.dataLink === "open" ? peer.capabilities?.networks : undefined;
    if (theirs && !theirs[card.rail]) return { why: t("payments.composer.unavailable.noWallet", { card: networkName(card) }), contact: true };
    if (peer?.dataLink === "open" && peer.capabilities?.methods && !peer.capabilities.methods[card.rail]) return { why: t("payments.composer.unavailable.notAccepted", { card: card.name }), contact: true };
    if (theirs && !theirs[card.rail]!.includes(card.network)) return { why: t("payments.composer.unavailable.noWallet", { card: networkName(card) }), contact: true };
    return undefined;
  };
  const unavailable = (card: InstanceCard) => blockedBy(card)?.why;
  // Real money, then test money: the two never mingle in the deck, and every card says its network.
  // A network's default Lightning card leads its Lightning cards: a request starts on it unless another is picked.
  const cards = state && wallet ? byNetwork(receivingFirst(walletCards(state, { t }))) : [];
  // Accept keeps one Lightning card per network: a request's invoice comes from the default for receiving.
  const acceptCards = state && wallet ? byNetwork(walletCards(state, { lightning: "default", t })) : [];
  // With an Accept side, a card this chat has off is chosen there, not shown on Pay.
  const offHere = (c: InstanceCard) => !!peer && !cardOn(peer, c.rail, c.network);
  const payCards = onSaveMethods ? cards.filter((c) => !offHere(c)) : cards;
  /**
   * Mainnet | Testnet: the sheet shows one network's cards at a time, on Pay and on Accept. The tab chosen here; before
   * that, the one this chat used last, else the one the contact takes, else real money when there is some
   * (lib/chatPayments.ts `startNetwork`). The tab only filters: every card pays on its own network.
   */
  const [tab, setTab] = useState<WalletNetwork | null>(null);
  const mine = WALLET_NETWORKS.filter((n) => cards.some((c) => c.network === n));
  const open = peer?.dataLink === "open";
  const net: WalletNetwork = tab ?? startNetwork(chat, cards, open ? peer.capabilities?.networks : undefined, open ? peer.capabilities?.methods : undefined);
  const netPayCards = payCards.filter((c) => c.network === net);
  // How the last switch went, for the deck's way in (none as the sheet opens).
  const [swap, setSwap] = useState<"next" | "prev" | null>(null);
  /**
   * The card Pay starts on, among a network's cards: the one this chat used last (a wallet's id, or a rail from before
   * networks), while it can still be used, else the first one that can, in the deck's order.
   */
  const firstUsable = (among = netPayCards): string | undefined => {
    const last = rememberedRail(chat);
    return among.find((c) => (c.id === last || c.rail === last) && !unavailable(c))?.id ?? among.find((c) => !unavailable(c))?.id;
  };
  const [selected, setSelected] = useState<string>(() => firstUsable() ?? netPayCards[0]?.id ?? "");
  // Until a card is picked, the deck follows the wallet as it comes up (a mint still loading, Ark connecting): it
  // moves to the first card that can be used, and never rests on one Pay does not show.
  const picked = useRef(false);
  const pick = (id: string) => { picked.current = true; setSelected(id); };
  const shownHere = netPayCards.some((c) => c.id === selected);
  const selectedBlocked = !!netPayCards.find((c) => c.id === selected && unavailable(c));
  const usable = firstUsable();
  useEffect(() => {
    if (shownHere && (picked.current || !selectedBlocked)) return;
    const next = usable ?? (shownHere ? undefined : netPayCards[0]?.id);
    if (next && next !== selected) setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownHere, selectedBlocked, usable, netPayCards.length]);
  // Pay, or Accept: which ways this chat takes. A chat that has every way off opens on Accept, to turn one on.
  const [mode, setMode] = useState<Mode>(() => onSaveMethods && cards.length && !payCards.length ? "accept" : "pay");
  // The cards, then the chosen one turned over (deck/Flip.tsx). Without a wallet platform, only the back; with one but
  // no wallet yet, the cards' side says how to make one.
  const { side, flipped, turn, turnBack } = useCardFlip(state && wallet ? "cards" : "back");
  /**
   * The turned card is still (deck/Flip.tsx): until then Request and Send wait, faded out, so that a click cannot land
   * on a card still swinging round and reach nothing (#762). A back shown without a card to turn never waits.
   */
  const [atRest, setAtRest] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"send" | "request" | null>(null);
  /** A send with no review on real money: the second step is open, and only it sends. */
  const [confirmSend, setConfirmSend] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(containerRef, true, onClose);
  // The review takes the amount's place after Send, and is taller: on a short screen (a phone with its keyboard up) it
  // ran past the sheet's bottom, Approve below the fold. The sheet scrolls to the card's end, where Approve is, in full.
  const reviewId = review?.id;
  useEffect(() => {
    if (reviewId) containerRef.current?.querySelector<HTMLElement>('[data-testid="payment-back"]')?.scrollIntoView?.({ block: "end" });
  }, [reviewId]);

  const card = cards.find((c) => c.id === selected);
  const rail: ChatRail = card?.rail ?? rails?.[0] ?? "cashu";
  const network: WalletNetwork | undefined = card?.network;
  /** The chosen card's own network: its state, and the calls that go through its wallets. */
  const here = state && network ? networkState(state, network, card?.card) : state;
  const bound = wallet && card ? cardWallet(wallet, card) : wallet;
  const method: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark" = rail === "lightning" ? "cashu" : rail;
  const usdt = here?.usdt;
  const unit = method === "usdt" ? (network === "testnet" || (usdt?.chainId && usdt.chainId !== 1) ? "TEST-USDT" : "USDT") : satsIn(t, network ?? "mainnet");
  const decimals = method === "usdt" ? usdt?.decimals ?? 6 : 0;
  /** The amount typed the person's way ("1.000,5" in Portuguese); `amount` is what it means ("1000.5"), or "". */
  const amountField = useAmountText(amount, setAmount, t.language ?? "en", decimals, t);
  const value = Number(amount);
  // What the second step names is what it sends: another amount or card asks again.
  useEffect(() => setConfirmSend(false), [amount, selected]);
  // Ecash goes straight to the contact; Ark, Bark, Spark, on-chain and USDT ask the contact's app for an address first. Lightning
  // pays a request the contact sends.
  const canSend = rail !== "lightning" && !sendUnavailable;
  const [asking, setAsking] = useState<string | null>(null);
  const blocked = card ? unavailable(card) : undefined;
  const turning = !!card && !atRest;
  // A card that cannot be used says so on its face, briefly; its title says why in full.
  const shown = netPayCards.map((c) => { const why = blockedBy(c); return !why || !c.ready ? c : { ...c, status: t(why.contact ? "payments.composer.cardStatus.notAccepted" : "payments.composer.cardStatus.offHere") }; });

  /** Turn the chosen card over, and back to the cards. */
  const use = (next: string) => {
    pick(next); setError("");
    rememberRail(chat, next);
    leaving.current = false;
    turn();
  };
  /** The card is turning back to the deck (until another is turned over). */
  const leaving = useRef(false);
  const backToCards = () => { leaving.current = true; setError(""); turnBack(); };
  /**
   * Escape steps back: from a turned card to the deck, and only then out of the sheet. Wherever the focus is (a click
   * on the card's text leaves it on the page), so this listens on the document before anything else does; the
   * sheet's dismissal (useOutsideDismiss) leaves an Escape handled here alone. A card under review stays: its
   * review has taken the card's place.
   */
  const escapeToCards = useRef<() => boolean>(() => false);
  escapeToCards.current = () => {
    // Already on its way back to the deck: a second Escape closes.
    if (side !== "back" || leaving.current || !cards.length || review) return false;
    backToCards();
    return true;
  };
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && escapeToCards.current()) e.preventDefault(); };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, []);
  // On the cards, the keyboard starts on the chosen one: arrows move, Enter turns it over. Once turned, on the amount
  // (not as the back mounts: it is still face down then, and a hidden field takes no focus).
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (side === "cards") containerRef.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"], [role=switch][tabindex="0"]')?.focus({ preventScroll: true });
    else if (flipped) amountRef.current?.focus({ preventScroll: true });
  }, [side, flipped]);
  useSheetRoom(containerRef);

  const send = async (confirmedReal = false) => {
    setError(""); setBusy("send");
    try {
      if (reviewContext && bound && (method === "arkade" || method === "bark" || method === "spark" || method === "bitcoin" || method === "usdt" || method === "fedimint")) {
        const units = method === "usdt" ? parsePaymentAmount(amount, decimals) : value;
        setAsking((await bound.askToPay(reviewContext.peer, units, method, memo || undefined)).askId);
        return;
      }
      if (reviewContext && bound && here) {
        // The mint that can pay, of this card's network: test sats and real ones never mix.
        const mint = [...here.mints].sort((a, b) => b.balance - a.balance).find((m) => m.balance >= value + CASHU_FEE_CAP) ?? [...here.mints].sort((a, b) => b.balance - a.balance)[0];
        if (!mint) throw new Error(t("payments.composer.error.noMint"));
        setReview(await bound.preparePayment({ target: { method: "cashu", network: network === "testnet" ? "cashu-test" : "bitcoin", provider: mint.url, address: reviewContext.peer, asset: "BTC", unit: "sat", expiresAt: Date.now() + 15 * 60 * 1000 }, amount: value, feeCap: CASHU_FEE_CAP, payee: reviewContext.peer, linkId: reviewContext.linkId, memo: memo || undefined }));
      } else {
        // Ecash sent without a review: on real money, only once the second step confirms it (no network is Mainnet).
        if (network !== "testnet" && !confirmedReal) { setConfirmSend(true); return; }
        const err = await onSend(value, memo, network, confirmedReal || undefined);
        if (err) setError(err); else onDone();
      }
    } catch (e) { setError(e instanceof Error ? errorText(e, t) : t("payments.composer.error.prepare")); }
    finally { setBusy(null); }
  };
  // The contact's app answers an ask with a request: review it here, as Pay on that request would.
  useEffect(() => {
    if (!asking || !reviewContext || !bound) return;
    const context = reviewContext, started = Date.now();
    const timer = setInterval(() => {
      const answer = context.wallet.answerTo(asking);
      if (answer && !answer.target && answer.federations) {
        // Fedimint, but no federation in common: their request carries an invoice of their federation instead.
        clearInterval(timer);
        setAsking(null);
        setError(t(answer.invoice ? "payments.composer.error.noFederationInvoice" : "payments.composer.error.noFederation", { name: who }));
      } else if (answer?.target) {
        clearInterval(timer);
        const token = answer.target.method === "usdt";
        void bound.preparePayment({ target: answer.target, amount: answer.amount, feeCap: token ? parsePaymentAmount("0.001", 18) : answer.target.method === "bitcoin" ? ONCHAIN_FEE_CAP : CASHU_FEE_CAP, payee: context.peer, linkId: answer.linkId, requestId: answer.id })
          .then(setReview, (e: unknown) => setError(e instanceof Error ? errorText(e, t) : t("payments.composer.error.prepare")))
          .finally(() => setAsking(null));
      } else if (Date.now() - started > 45_000) {
        clearInterval(timer);
        setAsking(null);
        setError(t("payments.composer.error.noAnswer"));
      }
    }, 400);
    return () => clearInterval(timer);
  }, [asking, reviewContext, bound, who, t]);

  const request = async () => {
    setError(""); setBusy("request");
    try {
      const err = await onRequest(method === "usdt" ? parsePaymentAmount(amount, decimals) : value, memo, method, rail, network, ...(card?.card ? [card.card] : []));
      if (err) setError(err); else onDone();
    } catch (e) { setError(e instanceof Error ? errorText(e, t) : t("payments.composer.error.request")); }
    finally { setBusy(null); }
  };

  // What this card holds, from its own wallet (Lightning's from its source, not the Cashu mints unless they are its
  // source): none claimed where the card cannot say. Without a wallet platform, the chat's Cashu balance.
  const holds = card && here ? spendable(card.rail, here) : method === "cashu" ? balance : undefined;
  // Only Send spends from this card: a Request (all Lightning can do in a chat, all a request to a group is) asks for
  // money, so no amount is too much for it.
  const tooMuch = canSend && holds !== undefined && value > holds;
  /** What Send and Request do on this card, with this contact. */
  const how = (id: ChatRail) => describe ? describe(id) : t(HOW[id], { name: who });

  const back = (
    <div className={`payment-back${card ? ` wallet-card-${card.rail}` : ""}`} data-testid="payment-back" data-network={network}>
      <div className="payment-back-stripe" aria-hidden="true" />
      <div className="payment-back-body">
        <div className="payment-back-head">
          {cards.length > 0 && !review && (
            <FlipTurnButton testId="payment-change-card" label={t("payments.composer.backToCards")} onClick={backToCards} />
          )}
          {card && <span className="payment-back-mark" aria-hidden="true"><WalletMark rail={card.rail} /></span>}
          <span className="payment-back-title">
            <span className="payment-back-name">{card ? (card.network === "testnet" ? `${card.name} · Testnet` : card.name) : t("payments.composer.payment")}</span>
            {card && <NetworkTag network={card.network} testId="payment-back-network" className="payment-back-network" />}
            <span className="payment-back-meta">{card ? t("payments.composer.balanceWith", { balance: card.balance, name: who }) : t("payments.composer.withTitle", { name: who })}</span>
          </span>
        </div>
        {review && bound ? <PaymentReview key={review.id} review={review} wallet={bound} onClose={onClose} onSent={onDone} /> : <>
          <label className="payment-back-amount" data-over={tooMuch || undefined}>
            <input ref={amountRef} data-testid="payment-amount" inputMode={decimals ? "decimal" : "numeric"} placeholder="0" aria-label={t("payments.composer.amountIn", { unit })}
              aria-invalid={amountField.hint ? true : undefined} value={amountField.text} onChange={(e) => amountField.change(e.target.value)} />
            <span>{unit}</span>
          </label>
          <input className="payment-back-memo" placeholder={t("payments.composer.memo")} aria-label={t("payments.composer.memo")} maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />
          <p className="payment-back-hint" data-testid={amountField.hint && !blocked ? "amount-unclear" : undefined}>{blocked ?? amountField.hint ?? (tooMuch ? t("payments.composer.tooMuch", { amount: formatAmount(holds!, t.language), unit }) : how(rail))}</p>
          {confirmSend ? <ConfirmRealMoney what={`${formatAmount(value, t.language)} ${unit}`} busy={busy !== null} onSend={() => void send(true)} onBack={() => setConfirmSend(false)} /> : <div className="payment-back-actions" data-turning={turning || undefined}>
            <button data-testid="payment-request" disabled={turning || !value || busy !== null || !!asking || !!blocked} onClick={() => void request()} className="payment-back-secondary">
              {busy === "request" ? t("payments.composer.requesting") : t("payments.composer.request")}
            </button>
            <button data-testid="payment-send" disabled={turning || !canSend || !!blocked || !value || busy !== null || !!asking || tooMuch} onClick={() => void send()}
              title={canSend ? undefined : sendUnavailable ?? t("payments.composer.sendHint")} className="payment-back-primary">
              {asking ? t("payments.composer.asking") : busy === "send" ? t("payments.composer.preparing") : t("payments.composer.send")}
            </button>
          </div>}
        </>}
        {error && <p role="alert" className="text-danger text-xs m-0">{error}</p>}
      </div>
    </div>
  );

  const switchMode = (next: Mode) => { setMode(next); setError(""); };
  /** Another network's cards: Pay starts on its usable card, as the sheet does, and the chat remembers the tab. */
  const showNetwork = (next: WalletNetwork) => {
    if (next === net) return;
    setSwap(WALLET_NETWORKS.indexOf(next) > WALLET_NETWORKS.indexOf(net) ? "next" : "prev");
    setTab(next); setError("");
    rememberNetwork(chat, next);
    const among = payCards.filter((c) => c.network === next);
    picked.current = false;
    setSelected(firstUsable(among) ?? among[0]?.id ?? selected);
  };
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
  // No wallet of the tab's network: say so, and where to make one, rather than an empty deck.
  const noWallet = (
    <div className="payment-none" data-testid="payment-network-empty">
      <p className="composer-sheet-hint">{t("payments.composer.noNetworkWallets", { network: NETWORK_NAME[net] })}</p>
      <button type="button" data-testid="payment-network-new" className="payment-network-new" onClick={() => { onClose(); nav.place("/wallet", { newWallet: { network: net } }); }}>
        {t("payments.composer.newNetworkWallet", { network: NETWORK_NAME[net] })}
        <ForwardArrow />
      </button>
    </div>
  );

  return (
    <ComposerSheet
      ref={containerRef}
      data-testid="payment-composer"
      data-side={side}
      data-mode={onSaveMethods ? mode : undefined}
      className={`payment-composer${accepting ? "" : ` wallet-card-${rail}`}`}
      data-network={accepting ? undefined : network}
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}
    >
      {side === "cards" ? <>
        <ComposerSheetHead title={modes || (sendUnavailable ? t("payments.composer.request") : t("payments.mode.pay"))} who={t("payments.composer.with", { name: who })} before={onBack && <button type="button" className="deck-flip-turn" data-testid="payment-recipient-change" aria-label={t("payments.composer.chooseOther")} title={t("payments.composer.chooseOther")} onClick={onBack}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>} />
        {!cards.length && state ? <div className="payment-none" data-testid="payment-no-wallet">
            <p className="composer-sheet-hint">{t("payments.composer.noWallet.text", { name: who })}</p>
            <button type="button" data-testid="payment-no-wallet-create" className="composer-sheet-action" onClick={() => { onClose(); nav.place("/wallet"); }}>
              {t("payments.composer.noWallet.action")}
              <ForwardArrow />
            </button>
          </div> : cards.length > 0 && <>
          <NetworkTabs compact network={net} onChange={showNetwork} label={t("payments.composer.networks")} testId="payment-tabs" tabTestId="payment-tab" idPrefix="payment-tab" controls="payment-tab-panel"
            counts={{ mainnet: (accepting ? cards : payCards).filter((c) => c.network === "mainnet").length, testnet: (accepting ? cards : payCards).filter((c) => c.network === "testnet").length }} />
          {/* Not keyed by the network: Accept keeps both networks' switches while the tab changes. Each deck is. */}
          <div role="tabpanel" id="payment-tab-panel" aria-labelledby={`payment-tab-${net}`} data-testid="payment-tab-panel" data-network={net}
            className="payment-tab-panel wallet-network-view" data-swap={swap ?? undefined} onAnimationEnd={(e) => { if (e.target === e.currentTarget) setSwap(null); }}>
          {accepting && onSaveMethods ? <ChatPaymentAccept peer={peer} contact={who} cards={acceptCards} network={net} onSave={onSaveMethods} empty={noWallet} />
          : !mine.includes(net) ? noWallet
          : !shown.length && onSaveMethods ? <div className="payment-none" data-testid="payment-none">
            <p className="composer-sheet-hint">{t("payments.none.text")}</p>
            <button type="button" data-testid="payment-none-accept" className="composer-sheet-action" data-variant="secondary" onClick={() => switchMode("accept")}>
              {t("payments.none.action")}
            </button>
          </div>
          : <>
            <CardDeck<string> key={net} compact tagAll kind="radios" label={t("payments.composer.payWith")} name="payment-deck" arrows={deckArrows(t)} cards={shown} selected={selected} onSelect={(id) => { pick(id); setError(""); }} onChoose={use}
              testId={paymentCardTestId} blocked={(c) => unavailable(c as InstanceCard)} size={{ max: 250, share: .62 }} />
            <p className="composer-sheet-hint" data-blocked={blocked ? true : undefined}>{blocked ?? how(rail)}</p>
            <button type="button" data-testid="payment-use" className="composer-sheet-action" disabled={!!blocked || !card} onClick={() => use(selected)}>
              {card ? t("payments.composer.use", { card: card.name }) : t("payments.composer.continue")}
              <ForwardArrow />
            </button>
          </>}
          </div>
        </>}
      </> : card ? <CardFlip className="payment" flipped={flipped} onSettle={setAtRest} tone={`wallet-card-${card.rail}`} front={<WalletCardFace card={card} tagAll />} back={back} /> : back}
    </ComposerSheet>
  );
}

/** A card's test id in the chat: its kind and its network (`payment-card-cashu-testnet`). */
export const paymentCardTestId = (id: string) => `payment-card-${id.replace(/:/g, "-")}`;

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
