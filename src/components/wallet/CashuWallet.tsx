import { useState } from "react";
import { decodeBolt11, parseLightningDestination, paymentUri, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { useCountUp } from "../../hooks/useCountUp";
import { PaymentReview } from "../PaymentReview";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./ui";
import { LightningAddressPay } from "./LightningAddressPay";
import { useRun } from "./run";
import { ButtonGroup, InputGroup, Truncate } from "../layout";
import { SourcePicker } from "./providers/SourcePicker";
import { CASHU_MINT_SOURCE } from "../walletCardData";

const TX_LABEL = {
  "lightning-in": "Received over Lightning",
  "lightning-out": "Paid over Lightning",
  "ecash-in": "Received ecash",
  "ecash-out": "Sent ecash",
  reclaimed: "Took a payment back",
} as const;

/**
 * A test mint marks every invoice paid by itself, so its word is not a payment: the invoice waits for a payer that says
 * it paid (a contact paying it in a chat). Nothing arrives by itself; test sats come from Get test coins.
 */
/** The history note of test coins (engine/wallet.ts `testCoins`): not a payment of an invoice. */
const TEST_COINS_NOTE = "Test coins from the test mint";
const TEST_MINT_INVOICE = "Waiting for the payment… Test mints mark every invoice paid by themselves, so this one counts only once a contact pays it in a chat. For test sats now, use Get test coins above.";

/** `input_fee_ppk` in a few words: a payment usually spends two to five proofs. */
const shortFee = (ppk: number) => (ppk === 0 ? "No fee to spend" : `${ppk / 1000} sat per proof (about 1 sat a payment)`);

/**
 * Cashu and Lightning share one balance while Lightning goes through the mints (the default source):
 * ecash held by the mints, filled and emptied over Lightning. The Cashu card also holds the mint
 * settings; the Lightning card is about invoices, and where they are paid into and from (its source).
 */
export function CashuWallet({ wallet, state, rail, onOpenCashu, focusAmount = false }: { wallet: WalletPlatform; state: WalletState; rail: "cashu" | "lightning"; onOpenCashu: () => void; focusAmount?: boolean }) {
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
  const [notice, setNotice] = useState("");
  const [mintUrl, setMintUrl] = useState("");
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
  const sourceName = ln?.alias ?? ln?.label ?? "the source";
  // On Testnet, Get test coins also grows the balance: only a Lightning receive of this amount since the invoice counts.
  const mintPaid = testnet
    ? state.history.some((tx) => tx.kind === "lightning-in" && tx.timestamp >= invoiceAt && tx.amount + tx.fee === Number(amount) && tx.note !== TEST_COINS_NOTE && state.mints.some((m) => m.url === tx.mint))
    : state.balance >= balanceBefore + Number(amount);
  const invoicePaid = invoice !== null && ((viaMint && mintPaid)
    || !!ln?.recent.some((op) => op.direction === "in" && op.paymentHash === paymentHash && op.state === "paid"));
  const isToken = /^cashu[AB]/i.test(payInput.trim());
  const pasted = isToken ? null : decodeBolt11(payInput);
  /** A Lightning address or LNURL: resolved and paid step by step, through the same source. */
  const [destination, destinationError] = (() => {
    if (isToken || pasted) return [null, ""] as const;
    try { return [parseLightningDestination(payInput)?.text ?? null, ""] as const; } catch (e) { return [null, e instanceof Error ? e.message : String(e)] as const; }
  })();

  const choose = (next: Action) => { setAction(next); setActionChosen(true); setError(""); setNotice(""); setInvoice(null); setQuote(null); };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {viaMint ? (
          <p className="text-text-primary" data-testid="wallet-balance">
            <span className="text-4xl font-semibold tabular-nums">{(testnet ? testShown : realShown).toLocaleString()}</span>
            <span className="text-text-muted text-sm ml-2">{testnet ? "test sats" : "sats"}</span>
            {/* A Testnet wallet's whole balance is test sats; a test mint's sats never count in a Mainnet one. */}
            {testMint && !testnet && <span className="block text-xs text-yellow-500 mt-1" data-testid="wallet-test-balance">{testShown.toLocaleString()} test sats (worthless)</span>}
          </p>
        ) : (
          <p className="text-text-primary" data-testid="wallet-balance">
            <span className="text-4xl font-semibold tabular-nums">{ln?.balance === undefined ? "—" : ln.balance.toLocaleString()}</span>
            <span className="text-text-muted text-sm ml-2">{testnet ? "test sats" : "sats"} · {sourceName}</span>
            {ln?.status !== "ready" && <span className="block text-xs text-yellow-500 mt-1" data-testid="lightning-source-state">{ln?.error ?? "Connecting to the source…"}</span>}
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
                <p className="text-accent text-sm font-semibold" data-testid="wallet-paid">⚡ {Number(amount).toLocaleString()} sats received</p>
                <Button onClick={() => { setInvoice(null); setAmount(""); }}>Done</Button>
              </div>
            ) : invoice ? (
              <div className="space-y-3">
                <p className="text-text-primary text-sm">Invoice for <b>{Number(amount).toLocaleString()} sats</b></p>
                <Address value={invoice} uri={paymentUri({ kind: "lightning", invoice })} testId="wallet-invoice" note={testnet && viaMint ? TEST_MINT_INVOICE : "Waiting for the payment… Any Lightning wallet can pay it; it is marked paid here once the source sees it."}
                  actions={<button type="button" className="px-3 py-1.5 min-h-9 max-md:min-h-11 rounded-lg text-xs font-bold bg-black/20 hover:bg-black/30 transition-colors cursor-pointer" onClick={() => setInvoice(null)}>New amount</button>} />
              </div>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { setBalanceBefore(state.balance); setInvoiceAt(Date.now()); const created = await wallet.receiveLightning(Number(amount), rail === "cashu" ? "cashu" : undefined); setPaymentHash(created.paymentHash); setInvoice(created.invoice); }); }}>
                <Amount value={amount} onChange={setAmount} unit="sats" testId="wallet-receive-amount" autoFocus={focusAmount || actionChosen} />
                <Button type="submit" variant="primary" className="w-full" data-testid="wallet-create-invoice" disabled={busy || !amount || (viaMint ? !state.mints.length : ln?.status !== "ready")}>{busy ? (viaMint ? "Asking the mint…" : `Asking ${sourceName}…`) : "Create Lightning invoice"}</Button>
                <Notice>{rail === "cashu" ? "Got an ecash token instead? Paste it under Send." : "Anyone can pay this invoice from any Lightning wallet."}</Notice>
              </form>
            )}
          </div>
        )}

        {action === "send" && (
          <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
            {quote ? (
              <>
                <p className="text-text-primary text-sm">Pay <b>{quote.amount.toLocaleString()} sats</b><span className="text-text-muted"> + up to {quote.feeReserve.toLocaleString()} in fees</span></p>
                <ButtonGroup fill>
                  <Button variant="primary" disabled={busy} onClick={() => void run(async () => { const paid = await wallet.payQuote(quote.quote, quote.mint); setQuote(null); setPayInput(""); setNotice(paid ? "Paid." : viaMint ? "The payment is still pending at the mint." : "The payment is still pending. It is being checked; nothing is paid again."); })}>{busy ? "Paying…" : "Pay"}</Button>
                  <Button onClick={() => setQuote(null)}>Cancel</Button>
                </ButtonGroup>
              </>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { if (isToken) { const received = await wallet.receiveToken(payInput); setPayInput(""); setNotice(`Redeemed ${received.toLocaleString()} sats.`); } else setQuote(await wallet.quoteInvoice(payInput, rail === "cashu" ? "cashu" : undefined)); }); }}>
                <textarea data-testid="wallet-pay-input" className={`${input} font-mono text-xs resize-none`} rows={3} autoFocus
                  placeholder={rail === "cashu" ? "Paste a Lightning invoice, a Lightning address or an ecash token" : "Paste a Lightning invoice or a Lightning address"} value={payInput} onChange={(e) => setPayInput(e.target.value)} />
                {destination && <div className="bg-surface-alt rounded-xl p-3 text-text-primary" data-testid="wallet-lnurl"><LightningAddressPay key={destination} wallet={wallet} text={destination} via={rail === "cashu" ? "cashu" : undefined} onDone={() => setPayInput("")} /></div>}
                {pasted && (
                  <p className="text-text-primary text-sm" data-testid="wallet-pay-preview">
                    <span className="text-accent">⚡</span> <b>{pasted.amountSat === null ? "Any amount" : `${pasted.amountSat.toLocaleString()} sats`}</b>
                    {pasted.description && <span className="text-text-muted"> · {pasted.description}</span>}
                    {pasted.expiresAt * 1000 < Date.now() && <span className="text-danger"> · expired</span>}
                  </p>
                )}
                {!destination && <Button type="submit" variant="primary" className="w-full" disabled={busy || !payInput.trim() || (!isToken && !pasted)}>
                  {busy ? "Working…" : isToken ? "Redeem ecash token" : pasted?.amountSat ? `Pay ${pasted.amountSat.toLocaleString()} sats` : "Pay"}
                </Button>}
                {destinationError ? <Notice tone="error">{destinationError}</Notice> : payInput.trim() && !isToken && !pasted && !destination ? <Notice tone="error">That is not a Lightning invoice or a Lightning address.</Notice> : !destination && <Notice>Paying a contact? Use ⚡ in the chat.</Notice>}
              </form>
            )}
          </div>
        )}

        {action === "history" && (
          <div className="bg-surface rounded-xl p-4 space-y-2 animate-fade-in" data-testid="wallet-history-list">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
              <span>{state.history.length === 0 ? "Nothing yet" : `${state.history.length} movement${state.history.length === 1 ? "" : "s"}`}</span>
              <span data-testid="wallet-fees-paid">Fees paid: {state.feesPaid.toLocaleString()} {testnet ? "test sats" : "sats"}</span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {state.history.map((tx) => {
                const incoming = tx.kind === "lightning-in" || tx.kind === "ecash-in" || tx.kind === "reclaimed";
                const mint = state.mints.find((m) => m.url === tx.mint);
                return (
                  <div key={tx.id} className="text-sm py-2" data-testid="wallet-tx">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-text-primary truncate">{TX_LABEL[tx.kind]}</span>
                      <span className={`font-semibold shrink-0 tabular-nums ${incoming ? "text-accent" : "text-text-primary"}`}>{incoming ? "+" : "−"}{tx.amount.toLocaleString()} <span className="text-xs font-normal text-text-muted">{testnet ? "test sats" : "sats"}</span></span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs text-text-muted">
                      <span className="truncate">{new Date(tx.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {mint?.name ?? new URL(tx.mint).hostname}{tx.note ? ` · ${tx.note}` : ""}</span>
                      <span className={`shrink-0 ${tx.fee > 0 ? "text-yellow-500" : ""}`}>{tx.fee > 0 ? `fee ${tx.fee.toLocaleString()}` : "no fee"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {notice && <Notice tone="success" testId="wallet-notice">{notice}</Notice>}
        {error && <Notice tone="error" testId="wallet-error">{error}</Notice>}
        {(state.intents ?? []).filter((i) => i.method === "cashu" && i.id !== review?.id).map((i) => (
          <Button key={i.id} className="block w-full text-left" onClick={() => setReview(i)}>{i.amount} {testnet ? "test sats" : "sats"} · {i.state}</Button>
        ))}
        {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
      </div>

      {rail === "lightning" ? (
        <>
          {!viaMint && !!ln?.recent.length && (
            <Section title="Recent" testId="lightning-recent">
              {ln.recent.map((op) => (
                <Row key={`${op.direction}-${op.paymentHash}`} testId="lightning-op" label={<>{op.direction === "in" ? "Invoice" : "Payment"} · {op.amount.toLocaleString()} sats</>}
                  hint={`${new Date(op.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${op.state}${op.fee ? ` · fee ${op.fee}` : ""}${op.error ? ` · ${op.error}` : ""}`} />
              ))}
            </Section>
          )}
          {ln && <SourcePicker kind="lightning" view={ln} onSet={(id, values) => wallet.lightningSetSource(id, values)} onClear={() => wallet.lightningClearSource()}
            onRetry={() => wallet.lightningRetrySource()} onReconfigure={(values) => wallet.lightningReconfigureSource(values)} />}
          {viaMint && (
            <Section title="Settings">
              <Row label="Balance" hint="Lightning uses your Cashu balance: invoices are paid into, and paid from, your Cashu mints."><Button onClick={onOpenCashu}>Cashu settings</Button></Row>
            </Section>
          )}
        </>
      ) : (
        <>
          <Section title="Mints" testId="wallet-mints">
            <Block><Notice>Mints hold your sats. Keep pocket money only.</Notice></Block>
            {state.mints.map((mint, index) => (
              <Row key={mint.url} testId="mint-row" label={<>{mint.name}{index === 0 && <span className="text-accent ml-2 text-[10px] uppercase tracking-wider">Primary</span>}</>}
                hint={<><span data-testid="mint-fees">{mint.info ? shortFee(mint.info.inputFeePpk) : "Not reachable right now"}</span><Truncate className="font-mono" title={mint.url}>{mint.url.replace(/^https?:\/\//, "")}</Truncate></>}
                value={`${mint.balance.toLocaleString()} sats`}>
                {index !== 0 && <Button onClick={() => void run(() => wallet.setPrimaryMint(mint.url))}>Make primary</Button>}
                <Button variant="danger" onClick={() => void run(() => wallet.removeMint(mint.url))} aria-label={`Remove ${mint.name}`}>Remove</Button>
              </Row>
            ))}
            <Block>
              <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await wallet.addMint(mintUrl); setMintUrl(""); }); }}>
                <input data-testid="wallet-mint-url" className={`${input} font-mono text-xs`} placeholder="Add a mint: https://…" value={mintUrl} onChange={(e) => setMintUrl(e.target.value)} />
                <Button type="submit" variant="primary" data-testid="wallet-add-mint" disabled={busy || !mintUrl.trim()}>Add</Button>
              </InputGroup>
            </Block>
          </Section>
          <Section title="Settings">
            <Row label="Copy ecash" hint="Whoever has the tokens has the sats">
              <Button disabled={busy || state.balance === 0} onClick={() => void run(async () => { const tokens = await wallet.exportTokens(); await navigator.clipboard.writeText(tokens.map((t) => t.token).join("\n")); setNotice("Backup copied. Whoever has these tokens has the sats."); })}>Copy backup</Button>
            </Row>
          </Section>
        </>
      )}
    </div>
  );
}
