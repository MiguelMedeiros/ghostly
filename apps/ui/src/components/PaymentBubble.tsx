import { decodeBolt11, parsePaymentAmount, paymentUri } from "@ghostly/core";
import { PayExternally } from "./PayExternally";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "./PaymentReview";
import { useEffect, useRef, useState } from "react";
import { useCountUp } from "../hooks/useCountUp";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { isWorthlessMint, mintNetwork } from "@ghostly/browser/shared/mints";
import { ONCHAIN_FEE_CAP } from "./walletCardData";
import { LightningPayWith, lightningPayer as payerOf } from "./LightningPayWith";
import { Select } from "./ui/Select";
import { NetworkTag, satsIn } from "./NetworkTag";
import { useI18n } from "../contexts/I18nContext";
import { ConfirmRealMoney } from "./ConfirmRealMoney";
import { railLine } from "./paymentWords";
import { decimalInput, formatAmount, formatTokenAmount } from "../lib/amount";
import { errorText } from "../lib/errorText";

/** A mint as a person knows it: its own name, else its host (the full URL says nothing more to them). */
const mintLabel = (m: { url: string; name: string }) => {
  if (m.name && m.name !== m.url) return m.name;
  try { return new URL(m.url).host; } catch { return m.url; }
};

/** A payment or a payment request in the chat. The amounts are live: they follow what the wallet knows. */
export function PaymentBubble({ paymentId, peerPubKey, fallbackText }: { paymentId: string; peerPubKey: string; fallbackText: string }) {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const wallet = platform?.wallet;
  const payment = wallet?.getPayment(paymentId) ?? null;
  /** Its way of paying is off in this chat: the request stays readable, but nothing here can pay it. */
  const allowed = platform?.getPeer(peerPubKey)?.paymentMethods;
  const paymentsOff = !!allowed && !!payment && (payment.target ? !(allowed as Partial<Record<string, boolean>>)[payment.target.method] : !(allowed.cashu || allowed.lightning));
  const [review,setReview] = useState<Review|null>(null);
  /** The unfinished payment of this request that was put away with Close: shown again only once it moves on. */
  const [putAway,setPutAway] = useState<string|null>(null);
  /** A Lightning payment of the request's invoice, reviewed here before the Lightning source is asked to pay. */
  const [lnReview,setLnReview] = useState<{ fee: number; source: string } | null>(null);
  /** Real money over Lightning: Approve opens the second step, and only it pays. */
  const [lnConfirming,setLnConfirming] = useState(false);
  /** The Lightning card that pays, when the network has several (the first eligible one until another is picked). */
  const lnCard = useState("");
  const [mint,setMint] = useState("");
  const [feeCap,setFeeCap] = useState<string|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [external, setExternal] = useState(false);

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
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  // A payment of this request already approved and not finished (its outcome unknown, or on its way) is shown with its
  // state and Check, also after the chat was left and opened again: a second one would be refused anyway.
  const unfinished = payment.kind === "request" && payment.direction === "in"
    ? wallet.getState()?.intents?.find((r) => r.requestId === payment.id && r.linkId === payment.linkId && (r.state === "submitted" || r.state === "unknown"))
    : undefined;
  const shownReview = review ?? (unfinished && `${unfinished.id}:${unfinished.state}` !== putAway ? unfinished : null);
  const tokenPayment=payment.target?.method==='usdt';
  const outgoing = payment.direction === "out";
  const isRequest = payment.kind === "request";
  const title = t(isRequest ? (outgoing ? "payments.bubble.title.youRequested" : "payments.bubble.title.requests") : outgoing ? "payments.bubble.title.youSent" : "payments.bubble.title.sentYou");
  // Test sats are worth nothing, and the bubble says so: a contact must not pass them off as money. The payment says
  // its network; one from before networks carries it (a target's chain, a test mint, an invoice's chain).
  // Fedimint: the network of the federation it names, when we joined it.
  const fedimint = payment.federation ?? payment.federations?.[0];
  const networks = wallet.getState()?.networks;
  const federationNetwork = fedimint ? [...(networks?.mainnet.fedimint?.federations ?? []), ...(networks?.testnet.fedimint?.federations ?? []), ...(wallet.getState()?.fedimint?.federations ?? [])].find((f) => f.id === fedimint)?.network : undefined;
  const testSats = payment.network ? payment.network === "testnet"
    : payment.target?.method === "arkade" || payment.target?.method === "bark" || payment.target?.method === "bitcoin" || payment.target?.method === "fedimint" || payment.target?.method === "spark" ? payment.target.network !== "bitcoin"
    : fedimint ? !!federationNetwork && federationNetwork !== "bitcoin"
    : payment.target?.method === "cashu" ? payment.target.network === "cashu-test"
    : payment.target?.method === "usdt" ? payment.target.network !== "ethereum"
    : !tokenPayment && (payment.mint ? isWorthlessMint(payment.mint) : payment.mints?.length ? payment.mints.every(isWorthlessMint)
      // A request with only an invoice: its chain says (test mints use lnbc, but they come with their mints).
      : !!payment.invoice && (decodeBolt11(payment.invoice)?.network ?? "bitcoin") !== "bitcoin");
  const network = testSats ? "testnet" : "mainnet";
  const sats = satsIn(t, network);
  const stateLabel = payment.kind === "payment" ? t(`payments.bubble.state.payment.${payment.state}`) : payment.state === "reclaimed" ? "" : t(`payments.bubble.state.request.${payment.state}`);
  /** The wallets of the payment's own network: only they pay it, quote its invoice or show its mints. */
  const onNet = wallet.forNetwork(network);
  const lightningPayer = payerOf(onNet, payment.amount, lnCard);
  const payer = lightningPayer.payer ?? onNet, payerCard = lightningPayer.card;
  // A request for money of a network this profile has no wallet on: said in words, and nothing here can pay it.
  const known = wallet.getState()?.wallets;
  const noWallet = isRequest && !outgoing && !!known && !known.some((w) => w.network === network);
  const sharedMints=(onNet.getState()?.mints??[]).filter(m=>payment.mints?.includes(m.url));
  const selectedMint=sharedMints.find(m=>m.url===mint)?.url ?? sharedMints[0]?.url;
  // Its invoice, through the Lightning source, when ecash cannot pay it here: no shared mint, or Cashu off.
  const viaLightning = !payment.target && !!payment.invoice && allowed?.lightning !== false && (!sharedMints.length || allowed?.cashu === false);
  // Lightning's default ceiling is the one the engine pays requests under.
  const feeInput=feeCap??(tokenPayment?'0.001':payment.target?.method==='bitcoin'?String(ONCHAIN_FEE_CAP):viaLightning?String(Math.max(10,Math.ceil(payment.amount*0.03))):'10');
  const payLightning = (confirmedReal: boolean) => run(async () => {
    await payer.payRequest(peerPubKey, payment.id, { via: "lightning", maxFee: Number(feeInput), ...(confirmedReal ? { confirmedReal } : {}) });
    setLnReview(null); setLnConfirming(false);
  });
  /** What another wallet can pay: the request's invoice, or the address it carries. Ecash-only requests have nothing to show. */
  const externalUri = (() => {
    try {
      if (payment.target?.method === "bitcoin") return { uri: paymentUri({ kind: "bitcoin", address: payment.target.address, amountSat: payment.amount, lightning: payment.invoice }), value: payment.target.address };
      if (payment.target?.method === "arkade" || payment.target?.method === "bark") return { uri: paymentUri({ kind: "ark", address: payment.target.address, amountSat: payment.amount }), value: payment.target.address };
      // A Spark invoice has no URI scheme wallets agree on: the invoice itself is what another Spark wallet pastes.
      if (payment.target?.method === "spark") return { uri: payment.target.address, value: payment.target.address };
      if ((!payment.target || payment.target.method === "fedimint") && payment.invoice) return { uri: paymentUri({ kind: "lightning", invoice: payment.invoice }), value: payment.invoice };
    } catch { /* not something another wallet can open */ }
    return null;
  })();
  const button =
    "px-3 py-1.5 bg-accent text-on-accent rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  const quiet = "px-3 py-1.5 bg-black/20 hover:bg-black/30 rounded-lg text-xs font-bold transition-colors cursor-pointer";

  return (
    <div
      className={`min-w-[210px] max-md:min-w-[min(210px,68vw)] max-w-[min(300px,72vw)] px-1 py-0.5 rounded-md ${celebrate ? "animate-sats-shine" : ""} ${
        fresh && isRequest && !outgoing && payment.state === "pending" ? "animate-nudge" : ""
      }`}
      data-testid="payment-bubble"
      data-state={payment.state}
      data-closed={payment.closed ? "" : undefined}
    >
      <p className="text-[11px] uppercase tracking-wider text-text-primary/65 m-0 flex items-center gap-2">{title}<NetworkTag network={network} testId="payment-network" /></p>
      <p className="m-0 leading-tight">
        <span className="text-[22px] font-semibold">

          {tokenPayment?formatTokenAmount(payment.amount,payment.target?.decimals,t.language):formatAmount(celebrate ? amountShown : payment.amount, t.language)}
        </span>
        {" "}<span className="text-xs ms-1 text-text-primary/75">{tokenPayment?payment.target?.asset:sats}</span>
      </p>
      {payment.target && <p className="text-xs text-text-primary/65" data-testid="payment-rail">{railLine(t, payment.target.method, payment.target.network)}</p>}
      {!payment.target && fedimint && <p className="text-xs text-text-primary/65" data-testid="payment-fedimint">{isRequest && !outgoing && payment.state === "pending" ? t("payments.bubble.fedimintNoFederation") : "Fedimint"}</p>}
      {shownReview && <PaymentReview key={shownReview.id} review={shownReview} wallet={wallet} onClose={()=>{ setReview(null); if (!review && unfinished) setPutAway(`${unfinished.id}:${unfinished.state}`); }}/>}
      {payment.memo && <p className="text-[13px] m-0 mt-0.5 wrap-break-word">{payment.memo}</p>}
      <p
        className={`text-[11px] m-0 mt-1 ${payment.state === "failed" ? "text-danger-ink" : payment.state === "settled" ? "text-accent-hover" : "text-text-primary/65"}`}
        data-testid="payment-state"
      >
        {payment.lightningPending && payment.state === "pending" ? t("payments.bubble.state.lightningPending") : payment.kind === "payment" && payment.state === "pending" && payment.target?.method === "bitcoin" ? t("payments.bubble.state.waitingConfirmation") : payment.closed ? t("payments.bubble.state.closed") : stateLabel}
        {payment.error && payment.state !== "settled" ? ` · ${payment.error}` : ""}
      </p>

      {isRequest && !outgoing && !payment.closed && paymentsOff && (payment.state === "pending" || payment.state === "failed") && (
        <p className="text-xs text-text-primary/65 mt-2" data-testid="payment-off">{t("payments.bubble.off")}</p>
      )}
      {isRequest && !outgoing && !payment.closed && !paymentsOff && noWallet && (payment.state === "pending" || payment.state === "failed") && (
        <p className="text-xs text-text-primary/65 mt-2" data-testid="payment-network-missing">{t(`payments.bubble.noWallet.${network}`, { unit: (tokenPayment ? payment.target?.asset : undefined) ?? sats })}</p>
      )}
      {isRequest && !outgoing && !payment.closed && !paymentsOff && (payment.state === "pending" || payment.state === "failed") && !payment.lightningPending && (
        <div className="flex flex-col gap-2 mt-2">
          {/* Paying from here needs a wallet of the request's network; another wallet can still be pointed at it. */}
          {!noWallet && <>
          {!payment.target && !viaLightning && <label className="block space-y-1 text-xs">{t("payments.bubble.cashuMint")}<Select size="sm" aria-label={t("payments.bubble.cashuMint")} value={selectedMint ?? ""} onChange={setMint} disabled={!sharedMints.length} placeholder={t("payments.bubble.noSharedMint")} options={sharedMints.map(m => ({ value: m.url, label: mintLabel(m), description: t("payments.bubble.balance", { amount: formatAmount(m.balance, t.language), unit: sats }) }))} /></label>}
          {viaLightning && <LightningPayWith payer={lightningPayer} unit={sats} disabled={busy || !!lnReview} testId="payment-lightning-card" />}
          <label className="text-xs">{t(tokenPayment?"payments.bubble.maxGas":"payments.bubble.maxFee")}<input aria-label={t(tokenPayment?"payments.bubble.maxGas":"payments.bubble.maxFee")} className="block w-20 bg-input-bg rounded p-1" inputMode="numeric" value={feeInput} onChange={e=>setFeeCap(tokenPayment?decimalInput(e.target.value,t.language):e.target.value.replace(/\D/g,""))}/></label>
          {lnReview && (
            <div data-testid="payment-review" className="rounded-lg bg-black/20 p-2 space-y-1 text-xs">
              <p className="m-0 flex items-center gap-2">{t("payments.bubble.payOverLightning", { amount: formatAmount(payment.amount, t.language), unit: sats })}<NetworkTag network={network} testId="payment-lightning-network" /></p>
              <p className="m-0 text-text-primary/75">{t("payments.bubble.through", { source: lnReview.source, fee: formatAmount(lnReview.fee, t.language) })}</p>
              {lnConfirming ? <ConfirmRealMoney what={t("payments.bubble.amountSats", { amount: formatAmount(payment.amount, t.language) })} busy={busy} onSend={() => payLightning(true)} onBack={() => setLnConfirming(false)} /> : (
                <div className="flex gap-2">
                  <button className={button} data-testid="payment-lightning-approve" disabled={busy} onClick={() => network === "mainnet" ? setLnConfirming(true) : payLightning(false)}>{t("payments.bubble.approve")}</button>
                  <button className={quiet} disabled={busy} onClick={() => setLnReview(null)}>{t("common.cancel")}</button>
                </div>
              )}
            </div>
          )}
          <button data-testid="payment-pay" className={button} disabled={busy || (!payment.target && !viaLightning && !selectedMint) || !!review || !!unfinished || !!lnReview} onClick={() => run(async () => {
            if (viaLightning) {
              // What the Lightning source would spend, shown before anything is asked of it.
              const quote = await payer.quoteInvoice(payment.invoice!);
              if (quote.amount !== payment.amount) throw new Error(t("payments.bubble.error.amountMismatch"));
              if (quote.feeReserve > Number(feeInput)) throw new Error(t("payments.bubble.error.feeAbove", { fee: quote.feeReserve }));
              const ln = payer.getState()?.lightning;
              setLnReview({ fee: quote.feeReserve, source: quote.source && quote.source === ln?.providerId ? (payerCard && ln.name) || ln.alias || ln.label || quote.source : quote.source ?? t("payments.bubble.cashuMints") });
              return;
            }
            const target=payment.target ?? {method:"cashu" as const,network:mintNetwork(selectedMint!) === "testnet" ? "cashu-test" as const : "bitcoin" as const,provider:selectedMint!,asset:"BTC" as const,unit:"sat" as const,address:payment.id,expiresAt:Date.now()+15*60*1000};
            setReview(await onNet.preparePayment({target,amount:payment.amount,feeCap:tokenPayment?parsePaymentAmount(feeInput,18):Number(feeInput),payee:peerPubKey,linkId:payment.linkId,requestId:payment.id}));
          })}>
            {busy ? t("payments.bubble.preparing") : t("payments.bubble.review")}
          </button>
          </>}
          {externalUri && (
            <button className={quiet} data-testid="payment-external" aria-expanded={external} title={t("payments.bubble.externalTitle")} onClick={() => setExternal((open) => !open)}>
              {external ? t("payments.bubble.hide") : t("payments.bubble.payElsewhere")}
            </button>
          )}
          {external && externalUri && (
            <PayExternally uri={externalUri.uri} value={externalUri.value} testId="payment-external" size={128}
              note={t(payment.target?.method === "bitcoin" ? "payments.bubble.externalNote.bitcoin" : payment.target && payment.target.method !== "fedimint" ? "payments.bubble.externalNote.ark" : "payments.bubble.externalNote.lightning")}
              onPaid={() => wallet.checkPayment(peerPubKey, payment.id)} />
          )}
        </div>
      )}
      {/* Ecash nobody picked up is still ours, whether it went out through a review or not. */}
      {(!payment.target || payment.target.method === "cashu" || payment.target.method === "fedimint") && !isRequest && outgoing && (payment.state === "pending" || payment.state === "failed") && (
        <button className={`${quiet} mt-2`} disabled={busy} onClick={() => run(() => wallet.reclaim(payment.id))} title={t("payments.bubble.takeBackTitle")}>
          {t("payments.bubble.takeBack")}
        </button>
      )}
      {error && <p className="text-danger-ink text-[11px] m-0 mt-1">{error}</p>}
    </div>
  );
}
