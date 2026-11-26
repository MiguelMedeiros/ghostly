import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { parseEngineError, paymentUri, type Bolt11Invoice, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { useCountUp } from "../../hooks/useCountUp";
import { usePageShown } from "../../hooks/usePageShown";
import { PaymentReview } from "../PaymentReview";
import { ConfirmRealMoney } from "../ConfirmRealMoney";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, Signed, input, type Action } from "./ui";
import { LightningAddressPay } from "./LightningAddressPay";
import { SendScan } from "./SendScan";
import { routeSend } from "../../lib/sendRoute";
import { touchOnly } from "../../lib/touchOnly";
import { RemoveMintConfirm } from "./RemoveMint";
import { useRun } from "./run";
import { ButtonGroup, InfoButton, InputGroup, Truncate } from "../layout";
import { SourcePicker } from "./providers/SourcePicker";
import { LightningCardSettings } from "./LightningCardSettings";
import { CASHU_MINT_SOURCE, holdsLess, pendingPayEnd } from "../walletCardData";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { NAME, withName } from "../apps/aroundName";
import { fillNames, fillNodes } from "../../lib/fillNodes";
import { satsIn, unitFor } from "../NetworkTag";
import { mintNetwork } from "@ghostly/browser/shared/mints";
import { lightningStateLabel, paymentStateLabel } from "../paymentWords";
import { formatAmount } from "../../lib/amount";
import { formatAtWithYear } from "../../lib/time";
import { problemLine, problemText } from "../../lib/problemText";
import { exactText } from "../../lib/exactText";
import { copySecret } from "../../lib/shareLink";
import { FocusSafeButton } from "../ui/FocusSafeButton";
import { providerLabel } from "./providers/providerText";

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
/**
 * The notes the engine writes itself (engine/wallet.ts), in English: shown in the app's language. Each is only ever on
 * its kind of movement, where no memo goes: a contact's memo (ecash in, a payment out) is shown as written, even one
 * that reads like a note of the engine's. A payment out's own note stands in the place of a request's missing memo: one
 * written word for word like it says the same thing.
 */
type EngineNote = "wallet.cashu.history.note.testCoins" | "wallet.cashu.history.note.requestPaid" | "wallet.cashu.history.note.paymentFailed"
  | "wallet.cashu.history.note.notSent" | "wallet.cashu.history.note.paidRequest";
/** A contact's request paid without a memo of its own (engine/payments.ts): the note of its payment, its memo's place. */
const PAID_REQUEST_NOTE = "Paid a contact's request";
const ENGINE_NOTES: Partial<Record<keyof typeof TX_LABEL, Record<string, EngineNote>>> = {
  "lightning-in": { [TEST_COINS_NOTE]: "wallet.cashu.history.note.testCoins", "Request paid over Lightning": "wallet.cashu.history.note.requestPaid" },
  "lightning-out": { [PAID_REQUEST_NOTE]: "wallet.cashu.history.note.paidRequest" },
  fee: { "A Lightning payment failed": "wallet.cashu.history.note.paymentFailed", "A payment was not sent": "wallet.cashu.history.note.notSent" },
};
/** What the mint kept when a payment with a note failed (engine/wallet.ts): the note is the payment's, as it was written. */
const FAILED_WITH_NOTE = "Payment failed: ";
const noteText = (t: Translate, { kind, note = "" }: { kind: keyof typeof TX_LABEL; note?: string }): ReactNode => {
  const key = ENGINE_NOTES[kind]?.[note];
  if (key) return t(key);
  if (kind !== "fee" || !note.startsWith(FAILED_WITH_NOTE)) return note;
  const paid = note.slice(FAILED_WITH_NOTE.length);
  return fillNames(t("wallet.cashu.history.note.paymentFailedFor"), { note: paid === PAID_REQUEST_NOTE ? t("wallet.cashu.history.note.paidRequest") : paid });
};
/** How often the Receive screen says again that it shows its invoice (the engine's watch lasts 90 s). */
const INVOICE_WATCH_AGAIN_MS = 60_000;

/**
 * When a movement happened, as the history writes it ("Sep 30, 03:15 PM"; "30 de set., 15:15" in Portuguese), with
 * the year when it is not this one's ("Dec 31, 2026, 11:30 PM"): "Dec 31" alone reads as this December.
 */
const MOVED_AT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

/**
 * `input_fee_ppk` in a few words, test sats on Testnet: a payment usually spends two to five proofs. The fee per proof
 * is a fraction ("0.1"), written with the language's decimal mark ("0,1 sat por prova") like every other amount.
 */
const shortFee = (t: Translate, ppk: number, testnet: boolean) => (ppk === 0 ? t("wallet.cashu.fee.none") : t(testnet ? "wallet.cashu.fee.perProofTest" : "wallet.cashu.fee.perProof", { fee: formatAmount(ppk / 1000, t.language) }));

/** A number counting up to `value`: each frame draws only what shows it, not the whole card (its History's 100 rows). */
function CountUp({ value, children }: { value: number; children: (shown: number) => ReactNode }) {
  return <>{children(useCountUp(value))}</>;
}

/**
 * Cashu and Lightning share one balance while Lightning goes through the mints (the default source):
 * ecash held by the mints, filled and emptied over Lightning. The Cashu card also holds the mint
 * settings; the Lightning card is about invoices, and where they are paid into and from (its source).
 */
export function CashuWallet({ wallet, state, rail, sharedWith, onOpenCashu, focusAmount = false }: { wallet: WalletPlatform; state: WalletState; rail: "cashu" | "lightning"; sharedWith?: string; onOpenCashu: () => void; focusAmount?: boolean }) {
  const { t } = useI18n();
  // A card that spends another card's balance (Lightning through the mints, Breez on the Spark wallet): its number
  // stays, it is what it can spend, and a line says whose balance it is.
  const sharedLine = sharedWith ? <span className="block text-xs text-text-muted mt-1" data-testid="wallet-shared-balance">{withName(t("wallet.cards.sameBalance", { name: NAME }), sharedWith)}</span> : null;
  const [action, setAction] = useState<Action>("receive");
  // The amount takes the focus when the person chose this wallet (`focusAmount`), chose Receive here, or pressed Done or
  // New amount.
  const [actionChosen, setActionChosen] = useState(false);
  const { busy, running, error, failed, setError, run } = useRun();
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<string | null>(null);
  const [paymentHash, setPaymentHash] = useState<string | undefined>();
  /** The invoice's mint quote: once its ecash is minted, its Lightning receipt carries it. */
  const [invoiceQuote, setInvoiceQuote] = useState<string | undefined>();
  /** When the invoice can no longer be paid (the mint's or the source's word), and whether that time has come. */
  const [invoiceExpiresAt, setInvoiceExpiresAt] = useState<number | null>(null);
  const [invoiceExpired, setInvoiceExpired] = useState(false);
  const [payInput, setPayInput] = useState("");
  /** What the person chose to pay on an invoice with no amount: it goes with the text it was typed for. */
  const [payAmount, setPayAmount] = useState("");
  /** Max was pressed and the amount not typed over: it comes down by the fee, as all the card holds leaves none for it. */
  const maxed = useRef(false);
  /** Send was just opened, and nothing given to it yet: on a phone its camera starts (`SendScan`), once. */
  const [sendOpened, setSendOpened] = useState(false);
  /**
   * Done after paying an address takes its panel away with the button pressed, and a redeemed token turns the button
   * pressed into an unavailable Pay: either way the keys go to the emptied field.
   */
  const payField = useRef<HTMLTextAreaElement>(null);
  const sendSubmit = useRef<HTMLButtonElement>(null);
  const [quote, setQuote] = useState<{ quote: string; mint: string; amount: number; feeReserve: number } | null>(null);
  /** The invoice the quote is for: its description shows in the review. */
  const [quoted, setQuoted] = useState<Bolt11Invoice | null>(null);
  /**
   * The last payment's end, shown in Send's place until Done: paid, or on its way. One the mint left pending reads as
   * waiting (never as paid, it may still come back) and says what happens next.
   */
  const [sent, setSent] = useState<{ line: string; next?: string; paid: boolean; quote?: string; hash?: string; held?: boolean; ended?: { paid: boolean; fee: number } } | null>(null);
  /** Real money: Pay opens the second step, and only it pays. */
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  /** The backup was just copied: said below Copy backup, where it was pressed. */
  const [copied, setCopied] = useState(false);
  // On a phone the card is one long column: what Add, Make primary and Copy backup answer is said by them, below, not
  // above the Mints section, off the screen.
  const mintsFailed = failed === "add-mint" || failed === "primary";
  const backupFailed = failed === "backup";
  const [mintUrl, setMintUrl] = useState("");
  /** The mint whose Remove was pressed: asked about below its row (the last one: the wallet's removal). */
  const [removingMint, setRemovingMint] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [setAsideInfo, setSetAsideInfo] = useState(false);
  const [unconfirmedInfo, setUnconfirmedInfo] = useState(false);
  const infoId = useId();

  // Test sats are worth nothing and must never be added to real ones. A Testnet Cashu wallet has only test
  // mints, so its whole balance is test sats; a Mainnet one never shows a test mint's.
  const testnet = state.mode === "testnet";
  const testMints = testnet ? state.mints : state.mints.filter((m) => wallet.testMintUrls.includes(m.url));
  const testMint = testMints.length > 0;
  const testBalance = testMints.reduce((sum, m) => sum + m.balance, 0);
  // The Cashu card always uses the mints; the Lightning card uses its network's source (the mints by default).
  const ln = state.lightning;
  const viaMint = rail === "cashu" || !ln?.providerId || ln.providerId === CASHU_MINT_SOURCE;
  const sourceName = ln?.alias ?? (ln?.providerId && ln.label ? providerLabel(t, ln.providerId, ln.label) : ln?.label);
  const unit = satsIn(t, testnet ? "testnet" : "mainnet");
  // Test sats say so wherever an amount shows on a Testnet wallet: its invoice, its mints, what came in.
  const sats = (amount: number) => t("wallet.cards.amount", { amount: formatAmount(amount, t.language), unit });
  // A redeemed token says what arrived and, at a mint that charges to take ecash in, what it kept: the face value
  // the person was handed is the two together (agents#2255).
  const redeemedLine = ({ amount, fee }: { amount: number; fee: number }) => fee > 0
    ? t(testnet ? "wallet.cashu.tokenRedeemedFeeTest" : "wallet.cashu.tokenRedeemedFee", { count: amount, amount: formatAmount(amount, t.language), fee: formatAmount(fee, t.language) })
    : t("wallet.cashu.redeemed", { amount: formatAmount(amount, t.language), unit });
  // Only this invoice's own receipt: other money of the same amount (a contact's ecash, a token taken back, a chat
  // request paid, test coins) is not a payment of it. A Lightning card's invoice is matched by its hash below.
  const mintPaid = !!invoiceQuote && state.history.some((tx) => tx.kind === "lightning-in" && tx.quote === invoiceQuote);
  const invoicePaid = invoice !== null && ((viaMint && mintPaid)
    || !!ln?.recent.some((op) => op.direction === "in" && op.paymentHash === paymentHash && op.state === "paid"));
  // What Send was given (typed, pasted, scanned or read from a picture): an invoice, an address or LNURL, a token.
  const route = routeSend(payInput);
  const isToken = route.kind === "token";
  const payQuote = (payable: { quote: string; mint: string }, confirmedReal: boolean) => void run(async () => {
    const paid = await wallet.payQuote(payable.quote, payable.mint, undefined, confirmedReal);
    // What a pending one is followed by: the Cashu card's melt quote, a Lightning card's invoice in its journal.
    const follow = rail === "cashu" ? { quote: payable.quote } : { hash: quoted?.paymentHash };
    setQuote(null); setQuoted(null); setConfirming(false); setPayInput("");
    setSent(paid ? { line: t("wallet.cashu.paid"), paid } : viaMint ? { line: t("wallet.cashu.pendingMint"), next: t("wallet.cashu.pendingMintNext"), paid, ...follow } : { line: t("wallet.lightning.pending"), paid, ...follow });
  }, "pay");
  // A payment left pending is followed while its result shows (`pendingPayEnd`): the result line was what the mint said
  // when Pay was answered. Once it ended it stays so: its History row or journal entry may later leave the newest ones the
  // view keeps.
  const ended = !sent || sent.paid ? undefined : sent.ended ?? pendingPayEnd(sent, state);
  useEffect(() => {
    if (!sent || sent.ended) return;
    if (ended) setSent({ ...sent, ended });
    else if (sent.quote && !sent.held && state.setAside) setSent({ ...sent, held: true });
  }, [sent, ended, state.setAside]);
  const result = !sent || !ended ? sent
    : ended.paid ? { line: t("wallet.cashu.paid"), paid: true }
    : { line: t("wallet.cashu.payFailed"), next: !viaMint ? undefined : ended.fee > 0 ? t("wallet.cashu.payFailedFee", { amount: formatAmount(ended.fee, t.language), unit: unitFor(t, unit, ended.fee) }) : t("wallet.cashu.payFailedBack"), paid: false, failed: true };
  /** The invoice's review: what paying it costs, from the mint or the source. */
  // `chosen`: the amount typed for an invoice with no amount, which only the mints are asked.
  const quoteFor = (invoice: Bolt11Invoice, chosen?: number) => void run(async () => {
    setSendOpened(false);
    const got = chosen === undefined ? await wallet.quoteInvoice(invoice.invoice, rail === "cashu" ? "cashu" : undefined) : await quoteChosen(invoice.invoice, chosen);
    setQuoted(invoice); setQuote(got);
  }, "send");
  // A Max comes down to what the mint says leaves room for its fee, known only once it is asked: twice at most, as a
  // fee may grow a little. An amount typed is the person's: it is refused, never lowered.
  const quoteChosen = async (invoice: string, chosen: number) => {
    for (let sats = chosen, again = maxed.current ? 2 : 0; ; again--) {
      try {
        const got = await wallet.quoteInvoice(invoice, "cashu", sats);
        setPayAmount(String(sats));
        return got;
      } catch (cause) {
        const refusal = parseEngineError(cause instanceof Error ? cause.message : String(cause));
        const room = refusal?.code === "notEnoughForFee" ? Number(refusal.values.amount) : 0;
        if (!again || room <= 0 || room >= sats) throw cause;
        sats = room;
      }
    }
  };
  // A scanned, pasted or pictured invoice with its amount goes straight to its review, as a phone wallet does; anything
  // else fills the field, where it is shown, asked about or refused as typed text is.
  const given = (text: string) => {
    setError(""); setNotice(""); setPayInput(text); setPayAmount(""); maxed.current = false;
    const found = routeSend(text);
    if (found.kind === "invoice") quoteFor(found.invoice);
  };
  // More than this card holds is never approved: the mint or the node would only refuse it afterwards.
  const over = quote ? holdsLess(rail, state, quote.amount) : undefined;
  const pasted = route.kind === "invoice" || route.kind === "no-amount" ? route.invoice : null;
  // The mints take an amount for an invoice with none; any other source refuses one (WISP 203).
  const choosing = route.kind === "no-amount" && viaMint;
  const chosen = choosing && pasted && pasted.expiresAt * 1000 >= Date.now() ? Number(payAmount) : 0;
  /** A Lightning address or LNURL: resolved and paid step by step, through the same source. */
  const destination = route.kind === "destination" ? route.text : null;
  const destinationError = route.kind === "bad-destination" ? problemText(route.error, t).title : "";

  // The invoice and the quote take the place of the form that had the focus: the focus goes to their first line, so the
  // keys go on from there (to Copy, to Pay) and a screen reader says what came. Not when it went somewhere else meanwhile.
  const invoiceLine = useRef<HTMLParagraphElement>(null);
  const quoteLine = useRef<HTMLParagraphElement>(null);
  // An expired invoice goes with the Copy that may have had the focus: New amount takes it.
  const expiredNew = useRef<HTMLButtonElement>(null);
  const showing = invoice ? (invoiceExpired ? "expired" : "invoice") : quote ? "quote" : null;
  useEffect(() => {
    const line = showing === "invoice" ? invoiceLine.current : showing === "expired" ? expiredNew.current : showing === "quote" ? quoteLine.current : null;
    if (line && (!document.activeElement || document.activeElement === document.body)) line.focus();
  }, [showing]);
  // Past its expiry nobody can pay the invoice: it is no longer offered to be copied or scanned.
  useEffect(() => {
    setInvoiceExpired(false);
    // Past setTimeout's longest wait (24.8 days) a page is not left open: no timer, rather than one that fires at once.
    if (!invoice || invoiceExpiresAt === null || invoiceExpiresAt - Date.now() > 0x7fffffff) return;
    const timer = setTimeout(() => setInvoiceExpired(true), Math.max(0, invoiceExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [invoice, invoiceExpiresAt]);
  // While the invoice shows, its mint or source is asked about it every few seconds: the engine asks less and less about
  // an invoice nobody looks at (agents#2447). Said again before the engine's watch (90 s) runs out. Not while the page
  // is hidden: nobody sees it there, and the engine's watch lapses by itself into its own pace. Shown again, it is said
  // at once, so a payment made meanwhile shows within seconds.
  const walletNow = useRef(wallet);
  useEffect(() => { walletNow.current = wallet; });
  const pageShown = usePageShown();
  useEffect(() => {
    if (showing !== "invoice" || invoicePaid || !invoice || !pageShown) return;
    const watch = () => void walletNow.current.watchInvoice?.(invoice)?.catch(() => {});
    watch();
    const timer = setInterval(watch, INVOICE_WATCH_AGAIN_MS);
    return () => clearInterval(timer);
  }, [showing, invoicePaid, invoice, pageShown]);

  // The button pressed keeps the keys while it works (Button's `loading`, by the key `run` was given); the others wait,
  // disabled. A mint's question closed hands them back to its Remove, or (the mint gone) to the field that adds one.
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const mintField = useRef<HTMLInputElement>(null);
  const addMint = useRef<HTMLButtonElement>(null);
  const closeRemoval = (url: string, removed?: boolean) => {
    (removed ? mintField.current : removeButtons.current.get(url))?.focus();
    setRemovingMint(null);
  };

  // The paid line takes the invoice's place in turn: the focus that was in the invoice goes to Done (Done, then, to the amount).
  const doneButton = useRef<HTMLButtonElement>(null);
  // The result takes the review's place: the keys that were on Pay go to its Done.
  const sentDone = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (sent && (!document.activeElement || document.activeElement === document.body)) sentDone.current?.focus();
  }, [sent]);
  useEffect(() => {
    if (invoicePaid && (!document.activeElement || document.activeElement === document.body)) doneButton.current?.focus();
  }, [invoicePaid]);

  // New amount (on the invoice, or on an expired one) takes away the button pressed: the keys go to the amount, as Done's do.
  const newAmount = () => { setInvoice(null); setActionChosen(true); };

  const choose = (next: Action) => { setAction(next); setActionChosen(true); setSendOpened(next === "send"); setError(""); setNotice(""); setCopied(false); setInvoice(null); setQuote(null); setQuoted(null); setConfirming(false); setSent(null); };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {viaMint ? (
          <p className="text-text-primary" data-testid="wallet-balance">
            {/* Only the number isolated, as an invoice's card does: in a right-to-left page the unit's Latin "sats" was one
                run with it, glued to it ("100,000sats"). The unit stays in the line's direction. */}
            <CountUp value={testnet ? testBalance : state.balance - testBalance}>{(shown) => <>
              <bdi className="text-4xl font-semibold tabular-nums">{formatAmount(shown, t.language)}</bdi>
              <span className="text-text-muted text-sm ms-2">{unitFor(t, unit, shown)}</span>
            </>}</CountUp>
            {sharedLine}
            {/* A Testnet wallet's whole balance is test sats; a test mint's sats never count in a Mainnet one. */}
            {testMint && !testnet && <CountUp value={testBalance}>{(shown) => <span className="block text-xs text-warn-ink mt-1" data-testid="wallet-test-balance">{t("wallet.cashu.testBalance", { amount: formatAmount(shown, t.language) })}</span>}</CountUp>}
            {!!state.setAside && (
              <span className="mt-1 flex items-center gap-1.5 text-xs text-text-muted max-md:min-h-[44px]" data-testid="wallet-set-aside">
                {t("wallet.cashu.setAside", { amount: formatAmount(state.setAside, t.language), unit })}
                <InfoButton open={setAsideInfo} onToggle={() => setSetAsideInfo(!setAsideInfo)} controls={`${infoId}-set-aside`} testId="wallet-set-aside-info" />
              </span>
            )}
            {!!state.setAside && setAsideInfo && <span id={`${infoId}-set-aside`} className="mt-1 block text-xs text-text-secondary" data-testid="wallet-set-aside-text">{t("wallet.cashu.setAsideInfo")}</span>}
            {!!state.unconfirmed && (
              <span className="mt-1 flex items-center gap-1.5 text-xs text-warn-ink max-md:min-h-[44px]" data-testid="wallet-unconfirmed">
                {t("wallet.cashu.unconfirmed", { amount: formatAmount(state.unconfirmed, t.language), unit })}
                <InfoButton open={unconfirmedInfo} onToggle={() => setUnconfirmedInfo(!unconfirmedInfo)} controls={`${infoId}-unconfirmed`} testId="wallet-unconfirmed-info" />
              </span>
            )}
            {!!state.unconfirmed && unconfirmedInfo && <span id={`${infoId}-unconfirmed`} className="mt-1 block text-xs text-text-secondary" data-testid="wallet-unconfirmed-text">{t("wallet.cashu.unconfirmedInfo")}</span>}
          </p>
        ) : (
          <p className="text-text-primary" data-testid="wallet-balance">
            <bdi className="text-4xl font-semibold tabular-nums">{ln?.balance === undefined ? "—" : formatAmount(ln.balance, t.language)}</bdi>
            <span className="text-text-muted text-sm ms-2">{t("wallet.lightning.balanceSource", { unit: ln?.balance === undefined ? unit : unitFor(t, unit, ln.balance), source: sourceName ?? t("wallet.lightning.theSource") })}</span>
            {sharedLine}
            {ln?.status !== "ready" && <span className="block text-xs text-warn-ink mt-1" data-testid="lightning-source-state">{ln?.error ? problemLine(ln.error, t) : t("wallet.lightning.connecting")}</span>}
          </p>
        )}
        <Actions value={action} onChange={choose} actions={rail === "cashu" ? ["receive", "send", "history"] : ["receive", "send"]} />

        {action === "receive" && (
          <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
            {/* Heard only when it was there before its text: it waits, empty, while the invoice shows. */}
            <p role="status" className="sr-only">{invoicePaid ? t("wallet.cashu.received", { amount: formatAmount(Number(amount), t.language), unit }) : ""}</p>
            {invoicePaid ? (
              <div className="text-center py-3 space-y-3">
                <svg width="56" height="56" viewBox="0 0 56 56" className="mx-auto text-accent animate-check-ring" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="28" cy="28" r="25" /><polyline points="16 29 25 38 41 20" className="animate-check-draw" />
                </svg>
                <p className="text-accent text-sm font-semibold" data-testid="wallet-paid" aria-hidden="true">{t("wallet.cashu.received", { amount: formatAmount(Number(amount), t.language), unit })}</p>
                <Button ref={doneButton} onClick={() => { setInvoice(null); setAmount(""); setActionChosen(true); }}>{t("wallet.lightning.done")}</Button>
              </div>
            ) : invoice && invoiceExpired ? (
              <div className="space-y-3">
                <Notice tone="error" testId="wallet-invoice-expired">{t("wallet.cashu.invoiceExpired")}</Notice>
                <Button ref={expiredNew} onClick={newAmount}>{t("wallet.cashu.newAmount")}</Button>
              </div>
            ) : invoice ? (
              <div className="space-y-3">
                <p ref={invoiceLine} tabIndex={-1} className="text-text-primary text-sm focus:outline-none">{fillNodes(t("wallet.cashu.invoiceFor"), { amount: <b>{sats(Number(amount))}</b> })}</p>
                <Address value={invoice} uri={paymentUri({ kind: "lightning", invoice })} testId="wallet-invoice" note={testnet && viaMint ? t("wallet.cashu.testMintInvoice") : t("wallet.lightning.waiting")}
                  actions={<button type="button" className="px-3 py-1.5 min-h-9 max-md:min-h-11 rounded-lg text-xs font-bold bg-black/20 hover:bg-black/30 transition-colors cursor-pointer" onClick={newAmount}>{t("wallet.cashu.newAmount")}</button>} />
              </div>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { const created = await wallet.receiveLightning(Number(amount), rail === "cashu" ? "cashu" : undefined); setInvoiceQuote(created.quote); setInvoiceExpiresAt(created.expiresAt); setPaymentHash(created.paymentHash); setInvoice(created.invoice); }, "invoice"); }}>
                <Amount value={amount} onChange={setAmount} unit={unit} testId="wallet-receive-amount" autoFocus={focusAmount || actionChosen} />
                <Button type="submit" variant="primary" className="w-full !whitespace-normal" data-testid="wallet-create-invoice" loading={running === "invoice"} disabled={busy || !amount || (viaMint ? !state.mints.length : ln?.status !== "ready")}>{busy ? (viaMint ? t("wallet.cashu.askingMint") : sourceName ? t("wallet.lightning.asking", { source: sourceName }) : t("wallet.lightning.askingSource")) : t("wallet.cashu.createInvoice")}</Button>
                <Notice>{rail === "cashu" ? t("wallet.cashu.tokenHint") : t("wallet.lightning.anyonePays")}</Notice>
              </form>
            )}
          </div>
        )}

        {action === "send" && (
          <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
            {/* The result, paid or pending, as Receive's: Done takes the keys, so only a line that was there, empty,
                before its text says which. A redeemed token is said here too, once (its line below is only drawn).
                Refusals are the error's own alert. */}
            <p role="status" className="sr-only">{result ? [result.line, result.next].filter(Boolean).join(" ") : notice}</p>
            {result ? (
              <div className="text-center py-3 space-y-3" data-testid="wallet-send-result">
                {result.paid && <svg width="56" height="56" viewBox="0 0 56 56" className="mx-auto text-accent animate-check-ring" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="28" cy="28" r="25" /><polyline points="16 29 25 38 41 20" className="animate-check-draw" />
                </svg>}
                {/* A failure is the status line's to say, once: not red with an alert of its own. */}
                <Notice tone={result.paid ? "success" : "failed" in result ? "warning" : "wait"} testId="wallet-notice" className={result.paid ? "text-sm font-semibold" : "text-sm"} title={result.line} next={result.next} />
                <Button ref={sentDone} data-testid="wallet-send-done" onClick={() => setSent(null)}>{t("wallet.lightning.done")}</Button>
              </div>
            ) : quote ? (
              <div className="space-y-3" data-testid="wallet-pay-review">
                <p ref={quoteLine} tabIndex={-1} className="text-text-primary text-sm focus:outline-none">{fillNodes(t("wallet.cashu.payLine"), {
                  amount: <b>{sats(quote.amount)}</b>,
                  fees: <span className="text-text-muted"> {t("wallet.lightning.feesUpTo", { fee: formatAmount(quote.feeReserve, t.language) })}</span>,
                })}</p>
                {/* A memo is text someone else wrote, in any script: laid out by its own direction. */}
                {quoted?.description && <p className="text-text-secondary text-sm" data-testid="wallet-pay-description"><bdi>{quoted.description}</bdi></p>}
                {over !== undefined && <p className="text-danger-ink text-xs" data-testid="wallet-pay-over">{t("payments.composer.tooMuch", { amount: formatAmount(over, t.language), unit })}</p>}
                {confirming && over === undefined ? <ConfirmRealMoney what={t("wallet.lightning.confirmWhat", { amount: formatAmount(quote.amount, t.language), unit, fee: formatAmount(quote.feeReserve, t.language), feeUnit: unitFor(t, unit, quote.feeReserve) })} busy={busy} onSend={() => payQuote(quote, true)} onBack={() => setConfirming(false)} /> : (
                  <ButtonGroup fill>
                    <Button variant="primary" data-testid="wallet-pay-confirm" loading={running === "pay"} disabled={busy || over !== undefined} onClick={() => testnet ? payQuote(quote, false) : setConfirming(true)}>{busy ? t("wallet.lightning.paying") : t("wallet.lightning.pay")}</Button>
                    <Button onClick={() => { setQuote(null); setQuoted(null); }}>{t("common.cancel")}</Button>
                  </ButtonGroup>
                )}
              </div>
            ) : (
              <SendScan onText={given} disabled={busy} scanOnOpen={sendOpened}>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (isToken) void run(async () => { const received = await wallet.receiveToken(route.text); setPayInput(""); setNotice(redeemedLine(received));
                  if (document.activeElement === sendSubmit.current) payField.current?.focus(); }, "send"); else if (route.kind === "invoice") quoteFor(route.invoice); else if (route.kind === "no-amount" && chosen) quoteFor(route.invoice, chosen); }}>
                <textarea ref={payField} data-testid="wallet-pay-input" className={`${input} font-mono text-xs resize-none`} rows={3} {...exactText} autoFocus={!touchOnly()}
                  placeholder={rail === "cashu" ? t("wallet.cashu.pastePlaceholder") : t("wallet.lightning.pastePlaceholder")} value={payInput} onChange={(e) => { setNotice(""); setPayInput(e.target.value); setPayAmount(""); maxed.current = false; }} />
                {destination && <div className="bg-surface-alt rounded-xl p-3 text-text-primary" data-testid="wallet-lnurl"><LightningAddressPay key={destination} wallet={wallet} text={destination} via={rail === "cashu" ? "cashu" : undefined} onDone={() => { setPayInput(""); payField.current?.focus(); }} /></div>}
                {pasted && (
                  <p className="text-text-primary text-sm" data-testid="wallet-pay-preview">
                    <span className="text-accent">⚡</span> <b>{pasted.amountSat === null ? t("wallet.lightning.anyAmount") : sats(pasted.amountSat)}</b>
                    {/* A memo is text someone else wrote, in any script: laid out by its own direction, as the chat's invoice card does. */}
                    {pasted.description && <span className="text-text-muted"> · <bdi>{pasted.description}</bdi></span>}
                    {pasted.expiresAt * 1000 < Date.now() && <span className="text-danger"> · {t("wallet.lightning.expired")}</span>}
                  </p>
                )}
                {choosing && <Amount value={payAmount} onChange={(next) => { maxed.current = false; setPayAmount(next); }} unit={unit} testId="wallet-pay-amount" />}
                {/* The line's dim is its text's only: Max keeps full-strength ink and a phone-sized target. */}
                {choosing && <p className="text-xs m-0 flex flex-wrap items-center gap-2" data-testid="wallet-pay-balance">
                  <span className="text-text-muted">{t("wallet.send.balance", { amount: formatAmount(state.balance, t.language), unit })}</span>
                  {state.balance > 0 && <FocusSafeButton type="button" className="min-h-6 max-md:min-h-11 rounded-md px-2.5 py-1 font-bold text-text-primary bg-surface-alt hover:bg-border cursor-pointer disabled:opacity-40" disabled={busy} data-testid="wallet-pay-max" onClick={() => { setPayAmount(String(state.balance)); maxed.current = true; }}>{t("wallet.send.max")}</FocusSafeButton>}
                </p>}
                {!destination && <Button ref={sendSubmit} type="submit" variant="primary" className="w-full !whitespace-normal" loading={running === "send"} disabled={busy || !payInput.trim() || (!isToken && route.kind !== "invoice" && !chosen)}>
                  {busy ? t("wallet.cashu.working") : isToken ? t("wallet.cashu.redeem") : chosen ? t("wallet.cashu.payAmount", { amount: formatAmount(chosen, t.language), unit }) : pasted?.amountSat ? t("wallet.cashu.payAmount", { amount: formatAmount(pasted.amountSat, t.language), unit }) : t("wallet.lightning.pay")}
                </Button>}
                {destinationError ? <Notice tone="error">{destinationError}</Notice> : choosing ? <Notice testId="wallet-pay-choose">{t("wallet.send.chooseAmount")}</Notice> : route.kind === "no-amount" ? <Notice tone="error" testId="wallet-pay-no-amount">{t("wallet.send.noAmount")}</Notice> : route.kind === "refused" ? <Notice tone="error" testId="wallet-pay-refused">{t("payments.formats.unsupported")}</Notice>: route.kind === "unknown" ? <Notice tone="error">{t("wallet.lightning.notInvoice")}</Notice> : !destination && <Notice>{t("wallet.cashu.contactHint")}</Notice>}
              </form>
              </SendScan>
            )}
          </div>
        )}

        {action === "history" && (
          <div className="bg-surface rounded-xl p-4 space-y-2 animate-fade-in" data-testid="wallet-history-list">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
              <span>{state.history.length === 0 ? t("wallet.cashu.history.none") : state.history.length === 1 ? t("wallet.cashu.history.movementsOne") : t("wallet.cashu.history.movements", { count: state.history.length })}</span>
              <span data-testid="wallet-fees-paid">{t("wallet.cashu.history.feesPaid", { amount: formatAmount(state.feesPaid, t.language), unit })}</span>
            </div>
            {/* Scrolls past a few movements: focusable, so the keys scroll it in WebKit too (as in PayExternally). */}
            <div tabIndex={0} aria-label={t("wallet.ui.history")} className="max-h-80 overflow-y-auto divide-y divide-border rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {state.history.map((tx) => {
                const incoming = tx.kind === "lightning-in" || tx.kind === "ecash-in" || tx.kind === "reclaimed";
                const mint = state.mints.find((m) => m.url === tx.mint);
                // What a mint kept of a failed or unsent payment is a "fee" row of amount 0: its fee is what it moved.
                const feeOnly = tx.kind === "fee";
                const moved = feeOnly ? tx.fee : tx.amount;
                return (
                  <div key={tx.id} className="text-sm py-2" data-testid="wallet-tx">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-text-primary truncate">{t(TX_LABEL[tx.kind])}</span>
                      <span className={`font-semibold shrink-0 tabular-nums ${incoming ? "text-accent" : "text-text-primary"}`}><Signed sign={incoming ? "+" : "−"} amount={formatAmount(moved, t.language)} /> <span className="text-xs font-normal text-text-muted">{unitFor(t, unit, moved)}</span></span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs text-text-muted">
                      {/* A mint's name and a contact's memo are someone else's text, in any script: each in its own
                          direction, so the two never swap around the " · " between them. */}
                      <span className="truncate">{formatAtWithYear(tx.timestamp, MOVED_AT, t.language)} · <bdi>{mint?.name ?? new URL(tx.mint).hostname}</bdi>{tx.note && <> · <bdi>{noteText(t, tx)}</bdi></>}</span>
                      {!feeOnly && <span className={`shrink-0 ${tx.fee > 0 ? "text-warn-ink" : ""}`}>{tx.fee > 0 ? t("wallet.cashu.history.fee", { amount: formatAmount(tx.fee, t.language), unit }) : t("wallet.cashu.history.noFee")}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {notice && <Notice tone="success" testId="wallet-notice">{notice}</Notice>}
        {error && !mintsFailed && !backupFailed && <Notice problem={error} testId="wallet-error" />}
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
                  hint={`${formatAtWithYear(op.createdAt, MOVED_AT, t.language)} · ${lightningStateLabel(t, op.state)}${op.fee ? ` · ${t("wallet.cashu.history.fee", { amount: formatAmount(op.fee, t.language), unit })}` : ""}${op.error ? ` · ${problemLine(op.error, t)}` : ""}`} />
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
              <Row testId="mint-row" label={<><bdi>{mint.name}</bdi>{index === 0 && <span className="text-accent ms-2 text-[10px] uppercase tracking-wider">{t("wallet.cashu.primary")}</span>}</>}
                hint={<><span data-testid="mint-fees">{mint.info ? shortFee(t, mint.info.inputFeePpk, mintNetwork(mint.url) === "testnet") : t("wallet.cashu.unreachable")}</span><Truncate className="font-mono" title={mint.url}>{mint.url.replace(/^https?:\/\//, "")}</Truncate></>}
                value={sats(mint.balance)}>
                {index !== 0 && <Button onClick={() => void run(() => wallet.setPrimaryMint(mint.url), "primary")}>{t("wallet.cashu.makePrimary")}</Button>}
                <Button ref={(button) => { if (button) removeButtons.current.set(mint.url, button); else removeButtons.current.delete(mint.url); }} variant="danger" data-testid="mint-remove" aria-expanded={state.mints.length > 1 ? removingMint === mint.url : undefined} aria-haspopup={state.mints.length === 1 ? "dialog" : undefined}
                  onClick={() => setRemovingMint(mint.url)} aria-label={t("wallet.cashu.removeMint", { name: mint.name })}>{t("wallet.cashu.remove")}</Button>
              </Row>
              {removingMint === mint.url && <RemoveMintConfirm mint={mint} wallet={wallet} state={state} onClose={(removed) => closeRemoval(mint.url, removed)} />}
            </Fragment>)}
            <Block>
              <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => {
                await wallet.addMint(mintUrl); setMintUrl("");
                // Add is disabled once the field is empty: the keys go back to the field, for another mint.
                if (document.activeElement === addMint.current) mintField.current?.focus();
              }, "add-mint"); }}>
                <input ref={mintField} data-testid="wallet-mint-url" className={`${input} font-mono text-xs`} inputMode="url" {...exactText} placeholder={t("wallet.cashu.addMintPlaceholder")} value={mintUrl} onChange={(e) => setMintUrl(e.target.value)} />
                <Button ref={addMint} type="submit" variant="primary" data-testid="wallet-add-mint" loading={running === "add-mint"} disabled={busy || !mintUrl.trim()}>{t("wallet.cashu.add")}</Button>
              </InputGroup>
              {error && mintsFailed && <Notice problem={error} testId="wallet-error" />}
            </Block>
          </Section>
          <Section title={t("wallet.cashu.settings")} testId="wallet-backup">
            <Row label={t("wallet.cashu.copyEcash")} hint={t("wallet.cashu.copyEcashHint")}>
              <Button loading={running === "backup"} disabled={busy || state.balance === 0} onClick={() => { setCopied(false); void run(async () => { const tokens = await wallet.exportTokens(); await copySecret(tokens.map((token) => token.token).join("\n")); setCopied(true); }, "backup"); }}>{t("wallet.cashu.copyBackup")}</Button>
              <p role="status" className="sr-only">{copied ? t("wallet.cashu.backupCopied") : ""}</p>
            </Row>
            {(copied || (error && backupFailed)) && <Block>{copied ? <Notice tone="success" testId="wallet-notice">{t("wallet.cashu.backupCopied")}</Notice> : error && <Notice problem={error} testId="wallet-error" />}</Block>}
          </Section>
        </>
      )}
    </div>
  );
}
