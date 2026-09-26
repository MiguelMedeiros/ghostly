import { decodeBolt11, formatPaymentAmount, parsePaymentAmount, paymentUri } from "@ghostly/core";
import { PayExternally } from "./PayExternally";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "./PaymentReview";
import { useEffect, useRef, useState } from "react";
import { useCountUp } from "../hooks/useCountUp";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { isWorthlessMint, mintNetwork } from "@ghostly/browser/shared/mints";
import { ONCHAIN_FEE_CAP } from "./walletCardData";
import { Select } from "./ui/Select";
import { MONEY_LABEL, NetworkTag } from "./NetworkTag";

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
  const paymentsOff = !!allowed && !!payment && (payment.target ? !(allowed as Partial<Record<string, boolean>>)[payment.target.method] : !(allowed.cashu || allowed.lightning));
  const [review,setReview] = useState<Review|null>(null);
  /** A Lightning payment of the request's invoice, reviewed here before the Lightning source is asked to pay. */
  const [lnReview,setLnReview] = useState<{ fee: number; source: string } | null>(null);
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tokenPayment=payment.target?.method==='usdt';
  const outgoing = payment.direction === "out";
  const isRequest = payment.kind === "request";
  const title = isRequest ? (outgoing ? "You requested" : "Requests") : outgoing ? "You sent" : "Sent you";
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
  /** The wallets of the payment's own network: only they pay it, quote its invoice or show its mints. */
  const onNet = wallet.forNetwork(network);
  // A request for money of a network this profile has no wallet on: said in words, and nothing here can pay it.
  const known = wallet.getState()?.wallets;
  const noWallet = isRequest && !outgoing && !!known && !known.some((w) => w.network === network);
  const sharedMints=(onNet.getState()?.mints??[]).filter(m=>payment.mints?.includes(m.url));
  const selectedMint=sharedMints.find(m=>m.url===mint)?.url ?? sharedMints[0]?.url;
  // Its invoice, through the Lightning source, when ecash cannot pay it here: no shared mint, or Cashu off.
  const viaLightning = !payment.target && !!payment.invoice && allowed?.lightning !== false && (!sharedMints.length || allowed?.cashu === false);
  // Lightning's default ceiling is the one the engine pays requests under.
  const feeInput=feeCap??(tokenPayment?'0.001':payment.target?.method==='bitcoin'?String(ONCHAIN_FEE_CAP):viaLightning?String(Math.max(10,Math.ceil(payment.amount*0.03))):'10');
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
    >
      <p className="text-[11px] uppercase tracking-wider text-text-primary/65 m-0 flex items-center gap-2">{title}<NetworkTag network={network} testId="payment-network" /></p>
      <p className="m-0 leading-tight">
        <span className="text-[22px] font-semibold">

          {tokenPayment?formatPaymentAmount(payment.amount,payment.target?.decimals):(celebrate ? amountShown : payment.amount).toLocaleString()}
        </span>
        {" "}<span className="text-xs ml-1 text-text-primary/75">{tokenPayment?payment.target?.asset:testSats?'test sats':'sats'}</span>
      </p>
      {payment.target && <p className="text-xs text-text-primary/65">{payment.target.method==="usdt"?"USDT":payment.target.method==="arkade"?"Ark":payment.target.method==="bark"?"Bark":payment.target.method==="spark"?"Spark":payment.target.method==="bitcoin"?"Bitcoin on-chain":payment.target.method==="fedimint"?"Fedimint":"Cashu"} · {payment.target.network}</p>}
      {!payment.target && fedimint && <p className="text-xs text-text-primary/65" data-testid="payment-fedimint">Fedimint{isRequest && !outgoing && payment.state === "pending" ? " · you share no federation: Lightning" : ""}</p>}
      {review && <PaymentReview review={review} wallet={wallet} onClose={()=>setReview(null)}/>}
      {payment.memo && <p className="text-[13px] m-0 mt-0.5 wrap-break-word">{payment.memo}</p>}
      <p
        className={`text-[11px] m-0 mt-1 ${payment.state === "failed" ? "text-danger-ink" : payment.state === "settled" ? "text-accent-hover" : "text-text-primary/65"}`}
        data-testid="payment-state"
      >
        {payment.lightningPending && payment.state === "pending" ? "Lightning payment pending…" : payment.kind === "payment" && payment.state === "pending" && payment.target?.method === "bitcoin" ? "Waiting for a confirmation…" : STATE_LABEL[payment.kind][payment.state]}
        {payment.error && payment.state !== "settled" ? ` · ${payment.error}` : ""}
      </p>

      {isRequest && !outgoing && paymentsOff && (payment.state === "pending" || payment.state === "failed") && (
        <p className="text-xs text-text-primary/65 mt-2" data-testid="payment-off">This way of paying is off in this chat.</p>
      )}
      {isRequest && !outgoing && !paymentsOff && noWallet && (payment.state === "pending" || payment.state === "failed") && (
        <p className="text-xs text-text-primary/65 mt-2" data-testid="payment-network-missing">{MONEY_LABEL[network]} is asked for ({tokenPayment ? payment.target?.asset : testSats ? "test sats" : "sats"}), and you have no {network === "testnet" ? "Testnet" : "Mainnet"} wallet to pay it from. Make one under Wallets, or ask for {MONEY_LABEL[network === "testnet" ? "mainnet" : "testnet"].toLowerCase()} instead.</p>
      )}
      {isRequest && !outgoing && !paymentsOff && (payment.state === "pending" || payment.state === "failed") && !payment.lightningPending && (
        <div className="flex flex-col gap-2 mt-2">
          {/* Paying from here needs a wallet of the request's network; another wallet can still be pointed at it. */}
          {!noWallet && <>
          {!payment.target && !viaLightning && <label className="block space-y-1 text-xs">Cashu mint<Select size="sm" aria-label="Cashu mint" value={selectedMint ?? ""} onChange={setMint} disabled={!sharedMints.length} placeholder="No shared configured mint" options={sharedMints.map(m => ({ value: m.url, label: m.url, description: `${m.balance.toLocaleString()} ${testSats ? "test sats" : "sats"}` }))} /></label>}
          <label className="text-xs">{tokenPayment?'Maximum gas (ETH)':'Maximum fee (sats)'}<input aria-label={tokenPayment?'Maximum gas (ETH)':'Maximum fee (sats)'} className="block w-20 bg-input-bg rounded p-1" inputMode="numeric" value={feeInput} onChange={e=>setFeeCap(e.target.value.replace(tokenPayment?/[^0-9.]/g:/\D/g,""))}/></label>
          {lnReview && (
            <div data-testid="payment-review" className="rounded-lg bg-black/20 p-2 space-y-1 text-xs">
              <p className="m-0 flex items-center gap-2">Pay {payment.amount.toLocaleString()} {testSats ? "test sats" : "sats"} over Lightning<NetworkTag network={network} testId="payment-lightning-network" /></p>
              <p className="m-0 text-text-primary/75">Through {lnReview.source} · fee up to {lnReview.fee.toLocaleString()} sats</p>
              <div className="flex gap-2">
                <button className={button} disabled={busy} onClick={() => run(async () => { await onNet.payRequest(peerPubKey, payment.id, { via: "lightning", maxFee: Number(feeInput) }); setLnReview(null); })}>Approve payment</button>
                <button className={quiet} disabled={busy} onClick={() => setLnReview(null)}>Cancel</button>
              </div>
            </div>
          )}
          <button data-testid="payment-pay" className={button} disabled={busy || (!payment.target && !viaLightning && !selectedMint) || !!review || !!lnReview} onClick={() => run(async () => {
            if (viaLightning) {
              // What the Lightning source would spend, shown before anything is asked of it.
              const quote = await onNet.quoteInvoice(payment.invoice!);
              if (quote.amount !== payment.amount) throw new Error("The invoice does not match the requested amount");
              if (quote.feeReserve > Number(feeInput)) throw new Error(`The Lightning fee (up to ${quote.feeReserve} sats) is above your maximum`);
              const ln = onNet.getState()?.lightning;
              setLnReview({ fee: quote.feeReserve, source: quote.source && quote.source === ln?.providerId ? ln.alias ?? ln.label ?? quote.source : quote.source ?? "the Cashu mints" });
              return;
            }
            const target=payment.target ?? {method:"cashu" as const,network:mintNetwork(selectedMint!) === "testnet" ? "cashu-test" as const : "bitcoin" as const,provider:selectedMint!,asset:"BTC" as const,unit:"sat" as const,address:payment.id,expiresAt:Date.now()+15*60*1000};
            setReview(await onNet.preparePayment({target,amount:payment.amount,feeCap:tokenPayment?parsePaymentAmount(feeInput,18):Number(feeInput),payee:peerPubKey,linkId:payment.linkId,requestId:payment.id}));
          })}>
            {busy ? "Preparing…" : "Review payment"}
          </button>
          </>}
          {externalUri && (
            <button className={quiet} data-testid="payment-external" aria-expanded={external} title="Scan, copy or open it in a wallet that is not Ghostly" onClick={() => setExternal((open) => !open)}>
              {external ? "Hide" : "Pay with another wallet"}
            </button>
          )}
          {external && externalUri && (
            <PayExternally uri={externalUri.uri} value={externalUri.value} testId="payment-external" size={128}
              note={`Paid from any ${payment.target?.method === "bitcoin" ? "Bitcoin" : payment.target && payment.target.method !== "fedimint" ? "Ark" : "Lightning"} wallet. Your contact's wallet marks it paid once it sees the money${payment.target?.method === "bitcoin" ? ", after one confirmation" : ""}.`}
              onPaid={() => wallet.checkPayment(peerPubKey, payment.id)} />
          )}
        </div>
      )}
      {/* Ecash nobody picked up is still ours, whether it went out through a review or not. */}
      {(!payment.target || payment.target.method === "cashu" || payment.target.method === "fedimint") && !isRequest && outgoing && (payment.state === "pending" || payment.state === "failed") && (
        <button className={`${quiet} mt-2`} disabled={busy} onClick={() => run(() => wallet.reclaim(payment.id))} title="If your contact never picks it up, the ecash is still yours">
          Take it back
        </button>
      )}
      {error && <p className="text-danger-ink text-[11px] m-0 mt-1">{error}</p>}
    </div>
  );
}
