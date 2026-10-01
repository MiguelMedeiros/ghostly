import { Fragment, useState } from "react";
import { decodeBolt11, parseLightningDestination, paymentUri, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { useCountUp } from "../../hooks/useCountUp";
import { PaymentReview } from "../PaymentReview";
import { ConfirmRealMoney } from "../ConfirmRealMoney";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./ui";
import { LightningAddressPay } from "./LightningAddressPay";
import { RemoveMintConfirm } from "./RemoveMint";
import { useRun } from "./run";
import { ButtonGroup, InputGroup, Truncate } from "../layout";
import { SourcePicker } from "./providers/SourcePicker";
import { LightningCardSettings } from "./LightningCardSettings";
import { CASHU_MINT_SOURCE } from "../walletCardData";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { fillNodes } from "../../lib/fillNodes";
import { satsIn } from "../NetworkTag";
import { mintNetwork } from "@ghostly/browser/shared/mints";
import { lightningStateLabel, paymentStateLabel } from "../paymentWords";
import { formatAmount } from "../../lib/amount";
import { formatAt } from "../../lib/time";
import { errorText } from "../../lib/errorText";

const TX_LABEL = {
  "lightning-in": "wallet.cashu.tx.lightningIn",
  "lightning-out": "wallet.cashu.tx.lightningOut",
  "ecash-in": "wallet.cashu.tx.ecashIn",
  "ecash-out": "wallet.cashu.tx.ecashOut",
  reclaimed: "wallet.cashu.tx.reclaimed",
  fee: "wallet.cashu.tx.fee",
} as const;

/**
 * A test mint marks every invoice paid by itself, so its word is not a payment: the invoice waits for a payer that says
 * it paid (a contact paying it in a chat). Nothing arrives by itself; test sats come from Get test coins.
 */
/** The history note of test coins (engine/wallet.ts `testCoins`): not a payment of an invoice. */
const TEST_COINS_NOTE = "Test coins from the test mint";
/** The notes the engine writes itself (engine/wallet.ts), in English: shown in the app's language. A memo is shown as written. */
const ENGINE_NOTES: Record<string, "wallet.cashu.history.note.testCoins" | "wallet.cashu.history.note.requestPaid" | "wallet.cashu.history.note.paymentFailed"> = {
  [TEST_COINS_NOTE]: "wallet.cashu.history.note.testCoins",
  "Request paid over Lightning": "wallet.cashu.history.note.requestPaid",
  "A Lightning payment failed": "wallet.cashu.history.note.paymentFailed",
};
/** When a movement happened, as the history writes it ("Sep 30, 03:15 PM"; "30 de set., 15:15" in Portuguese). */
const MOVED_AT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

/** `input_fee_ppk` in a few words, test sats on Testnet: a payment usually spends two to five proofs. */
const shortFee = (t: Translate, ppk: number, testnet: boolean) => (ppk === 0 ? t("wallet.cashu.fee.none") : t(testnet ? "wallet.cashu.fee.perProofTest" : "wallet.cashu.fee.perProof", { fee: ppk / 1000 }));

/**
 * Cashu and Lightning share one balance while Lightning goes through the mints (the default source):
 * ecash held by the mints, filled and emptied over Lightning. The Cashu card also holds the mint
 * settings; the Lightning card is about invoices, and where they are paid into and from (its source).
 */
export function CashuWallet({ wallet, state, rail, onOpenCashu, focusAmount = false }: { wallet: WalletPlatform; state: WalletState; rail: "cashu" | "lightning"; onOpenCashu: () => void; focusAmount?: boolean }) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action>("receive");
  // The amount takes the focus when the person chose this wallet (`focusAmount`) or chose Receive here.
  const [actionChosen, setActionChosen] = useState(false);
  const { busy, error, setError, run } = useRun();
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<string | null>(null);
  const [paymentHash, setPaymentHash] = useState<string | undefined>();
  /** Balance when the invoice was created: once it grew by the amount, the invoice was paid. */
  const [balanceBefore, setBalanceBefore] = useState(0);
  const [invoiceAt, setInvoiceAt] = useState(0);
  const [payInput, setPayInput] = useState("");
  const [quote, setQuote] = useState<{ quote: string; mint: string; amount: number; feeReserve: number } | null>(null);
  /** Real money: Pay opens the second step, and only it pays. */
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [mintUrl, setMintUrl] = useState("");
  /** The mint whose Remove was pressed: asked about below its row (the last one: the wallet's removal). */
  const [removingMint, setRemovingMint] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);

  // Test sats are worth nothing and must never be added to real ones. A Testnet Cashu wallet has only test
  // mints, so its whole balance is test sats; a Mainnet one never shows a test mint's.
  const testnet = state.mode === "testnet";
  const testMints = testnet ? state.mints : state.mints.filter((m) => wallet.testMintUrls.includes(m.url));
  const testMint = testMints.length > 0;
  const testBalance = testMints.reduce((sum, m) => sum + m.balance, 0);
  const realShown = useCountUp(state.balance - testBalance);
  const testShown = useCountUp(testBalance);
  // The Cashu card always uses the mints; the Lightning card uses its network's source (the mints by default).
  const ln = state.lightning;
  const viaMint = rail === "cashu" || !ln?.providerId || ln.providerId === CASHU_MINT_SOURCE;
  const sourceName = ln?.alias ?? ln?.label;
  const unit = satsIn(t, testnet ? "testnet" : "mainnet");
  // Test sats say so wherever an amount shows on a Testnet wallet: its invoice, its mints, what came in.
  const sats = (amount: number) => t("wallet.cards.amount", { amount: formatAmount(amount, t.language), unit });
  // On Testnet, Get test coins also grows the balance: only a Lightning receive of this amount since the invoice counts.
  const mintPaid = testnet
    ? state.history.some((tx) => tx.kind === "lightning-in" && tx.timestamp >= invoiceAt && tx.amount + tx.fee === Number(amount) && tx.note !== TEST_COINS_NOTE && state.mints.some((m) => m.url === tx.mint))
    : state.balance >= balanceBefore + Number(amount);
  const invoicePaid = invoice !== null && ((viaMint && mintPaid)
    || !!ln?.recent.some((op) => op.direction === "in" && op.paymentHash === paymentHash && op.state === "paid"));
  const isToken = /^cashu[AB]/i.test(payInput.trim());
  const payQuote = (payable: { quote: string; mint: string }, confirmedReal: boolean) => void run(async () => {
    const paid = await wallet.payQuote(payable.quote, payable.mint, undefined, confirmedReal);
    setQuote(null); setConfirming(false); setPayInput("");
    setNotice(paid ? t("wallet.cashu.paid") : viaMint ? t("wallet.cashu.pendingMint") : t("wallet.lightning.pending"));
  });
  const pasted = isToken ? null : decodeBolt11(payInput);
  /** A Lightning address or LNURL: resolved and paid step by step, through the same source. */
  const [destination, destinationError] = (() => {
    if (isToken || pasted) return [null, ""] as const;
    try { return [parseLightningDestination(payInput)?.text ?? null, ""] as const; } catch (e) { return [null, errorText(e, t)] as const; }
  })();

  const choose = (next: Action) => { setAction(next); setActionChosen(true); setError(""); setNotice(""); setInvoice(null); setQuote(null); setConfirming(false); };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {viaMint ? (
          <p className="text-text-primary" data-testid="wallet-balance">
            <span className="text-4xl font-semibold tabular-nums">{formatAmount(testnet ? testShown : realShown, t.language)}</span>
            <span className="text-text-muted text-sm ms-2">{unit}</span>
            {/* A Testnet wallet's whole balance is test sats; a test mint's sats never count in a Mainnet one. */}
            {testMint && !testnet && <span className="block text-xs text-yellow-500 mt-1" data-testid="wallet-test-balance">{t("wallet.cashu.testBalance", { amount: formatAmount(testShown, t.language) })}</span>}
          </p>
        ) : (
          <p className="text-text-primary" data-testid="wallet-balance">
            <span className="text-4xl font-semibold tabular-nums">{ln?.balance === undefined ? "—" : formatAmount(ln.balance, t.language)}</span>
            <span className="text-text-muted text-sm ms-2">{t("wallet.lightning.balanceSource", { unit, source: sourceName ?? t("wallet.lightning.theSource") })}</span>
            {ln?.status !== "ready" && <span className="block text-xs text-yellow-500 mt-1" data-testid="lightning-source-state">{ln?.error ? errorText(ln.error, t) : t("wallet.lightning.connecting")}</span>}
          </p>
        )}
        <Actions value={action} onChange={choose} actions={rail === "cashu" ? ["receive", "send", "history"] : ["receive", "send"]} />

        {action === "receive" && (
          <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
            {invoicePaid ? (
              <div className="text-center py-3 space-y-3">
                <svg width="56" height="56" viewBox="0 0 56 56" className="mx-auto text-accent animate-check-ring" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="28" cy="28" r="25" /><polyline points="16 29 25 38 41 20" className="animate-check-draw" />
                </svg>
                <p className="text-accent text-sm font-semibold" data-testid="wallet-paid">{t("wallet.cashu.received", { amount: formatAmount(Number(amount), t.language), unit })}</p>
                <Button onClick={() => { setInvoice(null); setAmount(""); }}>{t("wallet.lightning.done")}</Button>
              </div>
            ) : invoice ? (
              <div className="space-y-3">
                <p className="text-text-primary text-sm">{fillNodes(t("wallet.cashu.invoiceFor"), { amount: <b>{sats(Number(amount))}</b> })}</p>
                <Address value={invoice} uri={paymentUri({ kind: "lightning", invoice })} testId="wallet-invoice" note={testnet && viaMint ? t("wallet.cashu.testMintInvoice") : t("wallet.lightning.waiting")}
                  actions={<button type="button" className="px-3 py-1.5 min-h-9 max-md:min-h-11 rounded-lg text-xs font-bold bg-black/20 hover:bg-black/30 transition-colors cursor-pointer" onClick={() => setInvoice(null)}>{t("wallet.cashu.newAmount")}</button>} />
              </div>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { setBalanceBefore(state.balance); setInvoiceAt(Date.now()); const created = await wallet.receiveLightning(Number(amount), rail === "cashu" ? "cashu" : undefined); setPaymentHash(created.paymentHash); setInvoice(created.invoice); }); }}>
                <Amount value={amount} onChange={setAmount} unit={unit} testId="wallet-receive-amount" autoFocus={focusAmount || actionChosen} />
                <Button type="submit" variant="primary" className="w-full" data-testid="wallet-create-invoice" disabled={busy || !amount || (viaMint ? !state.mints.length : ln?.status !== "ready")}>{busy ? (viaMint ? t("wallet.cashu.askingMint") : sourceName ? t("wallet.lightning.asking", { source: sourceName }) : t("wallet.lightning.askingSource")) : t("wallet.cashu.createInvoice")}</Button>
                <Notice>{rail === "cashu" ? t("wallet.cashu.tokenHint") : t("wallet.lightning.anyonePays")}</Notice>
              </form>
            )}
          </div>
        )}

        {action === "send" && (
          <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
            {quote ? (
              <>
                <p className="text-text-primary text-sm">{fillNodes(t("wallet.cashu.payLine"), {
                  amount: <b>{sats(quote.amount)}</b>,
                  fees: <span className="text-text-muted"> {t("wallet.lightning.feesUpTo", { fee: formatAmount(quote.feeReserve, t.language) })}</span>,
                })}</p>
                {confirming ? <ConfirmRealMoney what={t("wallet.lightning.confirmWhat", { amount: formatAmount(quote.amount, t.language), fee: formatAmount(quote.feeReserve, t.language) })} busy={busy} onSend={() => payQuote(quote, true)} onBack={() => setConfirming(false)} /> : (
                  <ButtonGroup fill>
                    <Button variant="primary" data-testid="wallet-pay-confirm" disabled={busy} onClick={() => testnet ? payQuote(quote, false) : setConfirming(true)}>{busy ? t("wallet.lightning.paying") : t("wallet.lightning.pay")}</Button>
                    <Button onClick={() => setQuote(null)}>{t("common.cancel")}</Button>
                  </ButtonGroup>
                )}
              </>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { if (isToken) { const received = await wallet.receiveToken(payInput); setPayInput(""); setNotice(t("wallet.cashu.redeemed", { amount: formatAmount(received, t.language), unit })); } else setQuote(await wallet.quoteInvoice(payInput, rail === "cashu" ? "cashu" : undefined)); }); }}>
                <textarea data-testid="wallet-pay-input" className={`${input} font-mono text-xs resize-none`} rows={3} autoFocus
                  placeholder={rail === "cashu" ? t("wallet.cashu.pastePlaceholder") : t("wallet.lightning.pastePlaceholder")} value={payInput} onChange={(e) => setPayInput(e.target.value)} />
                {destination && <div className="bg-surface-alt rounded-xl p-3 text-text-primary" data-testid="wallet-lnurl"><LightningAddressPay key={destination} wallet={wallet} text={destination} via={rail === "cashu" ? "cashu" : undefined} onDone={() => setPayInput("")} /></div>}
                {pasted && (
                  <p className="text-text-primary text-sm" data-testid="wallet-pay-preview">
                    <span className="text-accent">⚡</span> <b>{pasted.amountSat === null ? t("wallet.lightning.anyAmount") : sats(pasted.amountSat)}</b>
                    {pasted.description && <span className="text-text-muted"> · {pasted.description}</span>}
                    {pasted.expiresAt * 1000 < Date.now() && <span className="text-danger"> · {t("wallet.lightning.expired")}</span>}
                  </p>
                )}
                {!destination && <Button type="submit" variant="primary" className="w-full" disabled={busy || !payInput.trim() || (!isToken && !pasted)}>
                  {busy ? t("wallet.cashu.working") : isToken ? t("wallet.cashu.redeem") : pasted?.amountSat ? t("wallet.cashu.payAmount", { amount: formatAmount(pasted.amountSat, t.language), unit }) : t("wallet.lightning.pay")}
                </Button>}
                {destinationError ? <Notice tone="error">{destinationError}</Notice> : payInput.trim() && !isToken && !pasted && !destination ? <Notice tone="error">{t("wallet.lightning.notInvoice")}</Notice> : !destination && <Notice>{t("wallet.cashu.contactHint")}</Notice>}
              </form>
            )}
          </div>
        )}

        {action === "history" && (
          <div className="bg-surface rounded-xl p-4 space-y-2 animate-fade-in" data-testid="wallet-history-list">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
              <span>{state.history.length === 0 ? t("wallet.cashu.history.none") : state.history.length === 1 ? t("wallet.cashu.history.movementsOne") : t("wallet.cashu.history.movements", { count: state.history.length })}</span>
              <span data-testid="wallet-fees-paid">{t("wallet.cashu.history.feesPaid", { amount: formatAmount(state.feesPaid, t.language), unit })}</span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {state.history.map((tx) => {
                const incoming = tx.kind === "lightning-in" || tx.kind === "ecash-in" || tx.kind === "reclaimed";
                const mint = state.mints.find((m) => m.url === tx.mint);
                return (
                  <div key={tx.id} className="text-sm py-2" data-testid="wallet-tx">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-text-primary truncate">{t(TX_LABEL[tx.kind])}</span>
                      <span className={`font-semibold shrink-0 tabular-nums ${incoming ? "text-accent" : "text-text-primary"}`}>{incoming ? "+" : "−"}{formatAmount(tx.amount, t.language)} <span className="text-xs font-normal text-text-muted">{unit}</span></span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs text-text-muted">
                      <span className="truncate">{formatAt(tx.timestamp, MOVED_AT, t.language)} · {mint?.name ?? new URL(tx.mint).hostname}{tx.note ? ` · ${ENGINE_NOTES[tx.note] ? t(ENGINE_NOTES[tx.note]) : tx.note}` : ""}</span>
                      <span className={`shrink-0 ${tx.fee > 0 ? "text-yellow-500" : ""}`}>{tx.fee > 0 ? t("wallet.cashu.history.fee", { amount: formatAmount(tx.fee, t.language) }) : t("wallet.cashu.history.noFee")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {notice && <Notice tone="success" testId="wallet-notice">{notice}</Notice>}
        {error && <Notice tone="error" testId="wallet-error">{error}</Notice>}
        {/* The reviewed payments with something left to do or read: a settled one is in the history, and a cancelled
            one (by Cancel, or past its expiry) moved nothing. Pending, on its way, unknown or failed stay. */}
        {(state.intents ?? []).filter((i) => i.method === "cashu" && i.id !== review?.id && i.state !== "settled" && i.state !== "cancelled").map((i) => (
          <Button key={i.id} className="block w-full text-start" data-testid="wallet-intent" onClick={() => setReview(i)}>{t("wallet.cashu.intent", { amount: formatAmount(i.amount, t.language), unit, state: paymentStateLabel(t, i.state) })}</Button>
        ))}
        {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
      </div>

      {rail === "lightning" ? (
        <>
          {!viaMint && !!ln?.recent.length && (
            <Section title={t("wallet.lightning.recent")} testId="lightning-recent">
              {ln.recent.map((op) => (
                <Row key={`${op.direction}-${op.paymentHash}`} testId="lightning-op" label={t(op.direction === "in" ? "wallet.lightning.recentIn" : "wallet.lightning.recentOut", { amount: formatAmount(op.amount, t.language), unit })}
                  hint={`${formatAt(op.createdAt, MOVED_AT, t.language)} · ${lightningStateLabel(t, op.state)}${op.fee ? ` · ${t("wallet.cashu.history.fee", { amount: formatAmount(op.fee, t.language) })}` : ""}${op.error ? ` · ${errorText(op.error, t)}` : ""}`} />
              ))}
            </Section>
          )}
          <LightningCardSettings key={ln?.card} wallet={wallet} state={state} />
          {/* A card keeps its source: another source is another card (New). */}
          {ln && <SourcePicker kind="lightning" view={ln} onRetry={() => wallet.lightningRetrySource()} onReconfigure={(values) => wallet.lightningReconfigureSource(values)} />}
          {viaMint && (
            <Section title={t("wallet.cashu.settings")}>
              <Row label={t("wallet.lightning.balance")} hint={t("wallet.lightning.balanceHint")}><Button onClick={onOpenCashu}>{t("wallet.lightning.cashuSettings")}</Button></Row>
            </Section>
          )}
        </>
      ) : (
        <>
          <Section title={t("wallet.cashu.mints")} testId="wallet-mints">
            <Block><Notice>{t("wallet.cashu.mintsHint")}</Notice></Block>
            {state.mints.map((mint, index) => <Fragment key={mint.url}>
              <Row testId="mint-row" label={<>{mint.name}{index === 0 && <span className="text-accent ms-2 text-[10px] uppercase tracking-wider">{t("wallet.cashu.primary")}</span>}</>}
                hint={<><span data-testid="mint-fees">{mint.info ? shortFee(t, mint.info.inputFeePpk, mintNetwork(mint.url) === "testnet") : t("wallet.cashu.unreachable")}</span><Truncate className="font-mono" title={mint.url}>{mint.url.replace(/^https?:\/\//, "")}</Truncate></>}
                value={sats(mint.balance)}>
                {index !== 0 && <Button onClick={() => void run(() => wallet.setPrimaryMint(mint.url))}>{t("wallet.cashu.makePrimary")}</Button>}
                <Button variant="danger" data-testid="mint-remove" aria-expanded={state.mints.length > 1 ? removingMint === mint.url : undefined} aria-haspopup={state.mints.length === 1 ? "dialog" : undefined}
                  onClick={() => setRemovingMint(mint.url)} aria-label={t("wallet.cashu.removeMint", { name: mint.name })}>{t("wallet.cashu.remove")}</Button>
              </Row>
              {removingMint === mint.url && <RemoveMintConfirm mint={mint} wallet={wallet} state={state} onClose={() => setRemovingMint(null)} />}
            </Fragment>)}
            <Block>
              <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await wallet.addMint(mintUrl); setMintUrl(""); }); }}>
                <input data-testid="wallet-mint-url" className={`${input} font-mono text-xs`} placeholder={t("wallet.cashu.addMintPlaceholder")} value={mintUrl} onChange={(e) => setMintUrl(e.target.value)} />
                <Button type="submit" variant="primary" data-testid="wallet-add-mint" disabled={busy || !mintUrl.trim()}>{t("wallet.cashu.add")}</Button>
              </InputGroup>
            </Block>
          </Section>
          <Section title={t("wallet.cashu.settings")}>
            <Row label={t("wallet.cashu.copyEcash")} hint={t("wallet.cashu.copyEcashHint")}>
              <Button disabled={busy || state.balance === 0} onClick={() => void run(async () => { const tokens = await wallet.exportTokens(); await navigator.clipboard.writeText(tokens.map((token) => token.token).join("\n")); setNotice(t("wallet.cashu.backupCopied")); })}>{t("wallet.cashu.copyBackup")}</Button>
            </Row>
          </Section>
        </>
      )}
    </div>
  );
}
