import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { decodeBolt11, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { useCountUp } from "../../hooks/useCountUp";
import { PaymentReview } from "../PaymentReview";
import { Actions, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./ui";
import { useRun } from "./run";
import { ButtonGroup, InputGroup, Truncate } from "../layout";

const TX_LABEL = {
  "lightning-in": "Received over Lightning",
  "lightning-out": "Paid over Lightning",
  "ecash-in": "Received ecash",
  "ecash-out": "Sent ecash",
  reclaimed: "Took a payment back",
} as const;

/** `input_fee_ppk` in a few words: a payment usually spends two to five proofs. */
const shortFee = (ppk: number) => (ppk === 0 ? "No fee to spend" : `${ppk / 1000} sat per proof (about 1 sat a payment)`);

/**
 * Cashu and Lightning share one balance: ecash held by the mints, filled and emptied over Lightning.
 * The Cashu card also holds the mint settings; the Lightning card is about invoices.
 */
export function CashuWallet({ wallet, state, rail, onOpenCashu }: { wallet: WalletPlatform; state: WalletState; rail: "cashu" | "lightning"; onOpenCashu: () => void }) {
  const [action, setAction] = useState<Action>("receive");
  const { busy, error, setError, run } = useRun();
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<string | null>(null);
  /** Balance when the invoice was created: once it grew by the amount, the invoice was paid. */
  const [balanceBefore, setBalanceBefore] = useState(0);
  const [copied, setCopied] = useState(false);
  const [payInput, setPayInput] = useState("");
  const [quote, setQuote] = useState<{ quote: string; mint: string; amount: number; feeReserve: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [mintUrl, setMintUrl] = useState("");
  const [review, setReview] = useState<Review | null>(null);

  // Test sats are worth nothing and must never be added to real ones. In Testnet the mints shown are
  // the test ones, so the whole balance is test sats.
  const testnet = state.mode === "testnet";
  const testMints = testnet ? state.mints : state.mints.filter((m) => wallet.testMintUrls.includes(m.url));
  const testMint = testMints.length > 0;
  const testBalance = testMints.reduce((sum, m) => sum + m.balance, 0);
  const realShown = useCountUp(state.balance - testBalance);
  const testShown = useCountUp(testBalance);
  const invoicePaid = invoice !== null && state.balance >= balanceBefore + Number(amount);
  const isToken = /^cashu[AB]/i.test(payInput.trim());
  const pasted = isToken ? null : decodeBolt11(payInput);

  const choose = (next: Action) => { setAction(next); setError(""); setNotice(""); setInvoice(null); setQuote(null); };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <p className="text-text-primary" data-testid="wallet-balance">
          <span className="text-4xl font-semibold tabular-nums">{(testnet ? testShown : realShown).toLocaleString()}</span>
          <span className="text-text-muted text-sm ml-2">{testnet ? "test sats" : "sats"}</span>
          {testMint && <span className="block text-xs text-yellow-500 mt-1" data-testid="wallet-test-balance">{testShown.toLocaleString()} test sats (worthless)</span>}
        </p>
        {!testnet && !!state.waitingTestSats && (
          <Notice tone="warning" testId="wallet-waiting-test-sats">
            {state.waitingTestSats.toLocaleString()} test sats are waiting in Testnet.{" "}
            <button type="button" className="underline cursor-pointer" onClick={() => void run(() => wallet.setMode("testnet"))}>Switch to Testnet</button>
          </Notice>
        )}
        <Actions value={action} onChange={choose} actions={rail === "cashu" ? ["receive", "send", "history"] : ["receive", "send"]} />

        {action === "receive" && (
          <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
            {invoicePaid ? (
              <div className="text-center py-3 space-y-3">
                <svg width="56" height="56" viewBox="0 0 56 56" className="mx-auto text-accent animate-check-ring" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="28" cy="28" r="25" /><polyline points="16 29 25 38 41 20" className="animate-check-draw" />
                </svg>
                <p className="text-accent text-sm font-semibold" data-testid="wallet-paid">⚡ {Number(amount).toLocaleString()} {testnet ? "test sats" : "sats"} received</p>
                <Button onClick={() => { setInvoice(null); setAmount(""); }}>Done</Button>
              </div>
            ) : invoice ? (
              <div className="flex flex-wrap gap-4 items-center justify-center">
                <div className="bg-white rounded-xl p-2.5 shrink-0"><QRCodeSVG value={invoice.toUpperCase()} size={168} /></div>
                <div className="min-w-0 flex-[1_1_14rem] space-y-2.5">
                  <p className="text-text-primary text-sm">Invoice for <b>{Number(amount).toLocaleString()} sats</b></p>
                  <code className="block bg-surface-alt rounded-lg p-2 text-[10px] text-text-muted font-mono break-all max-h-20 overflow-y-auto select-all" data-testid="wallet-invoice">{invoice}</code>
                  <ButtonGroup>
                    <Button variant="primary" onClick={() => { void navigator.clipboard.writeText(invoice); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy invoice"}</Button>
                    <Button onClick={() => setInvoice(null)}>New amount</Button>
                  </ButtonGroup>
                  <Notice>Waiting for the payment…</Notice>
                </div>
              </div>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { setBalanceBefore(state.balance); setInvoice((await wallet.receiveLightning(Number(amount))).invoice); }); }}>
                <Amount value={amount} onChange={setAmount} unit="sats" testId="wallet-receive-amount" autoFocus />
                <Button type="submit" variant="primary" className="w-full" data-testid="wallet-create-invoice" disabled={busy || !amount || !state.mints.length}>{busy ? "Asking the mint…" : "Create Lightning invoice"}</Button>
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
                  <Button variant="primary" disabled={busy} onClick={() => void run(async () => { const paid = await wallet.payQuote(quote.quote, quote.mint); setQuote(null); setPayInput(""); setNotice(paid ? "Paid." : "The payment is still pending at the mint."); })}>{busy ? "Paying…" : "Pay"}</Button>
                  <Button onClick={() => setQuote(null)}>Cancel</Button>
                </ButtonGroup>
              </>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => { if (isToken) { const received = await wallet.receiveToken(payInput); setPayInput(""); setNotice(`Redeemed ${received.toLocaleString()} sats.`); } else setQuote(await wallet.quoteInvoice(payInput)); }); }}>
                <textarea data-testid="wallet-pay-input" className={`${input} font-mono text-xs resize-none`} rows={3} autoFocus
                  placeholder={rail === "cashu" ? "Paste a Lightning invoice or an ecash token" : "Paste a Lightning invoice"} value={payInput} onChange={(e) => setPayInput(e.target.value)} />
                {pasted && (
                  <p className="text-text-primary text-sm" data-testid="wallet-pay-preview">
                    <span className="text-accent">⚡</span> <b>{pasted.amountSat === null ? "Any amount" : `${pasted.amountSat.toLocaleString()} sats`}</b>
                    {pasted.description && <span className="text-text-muted"> · {pasted.description}</span>}
                    {pasted.expiresAt * 1000 < Date.now() && <span className="text-danger"> · expired</span>}
                  </p>
                )}
                <Button type="submit" variant="primary" className="w-full" disabled={busy || !payInput.trim() || (!isToken && !pasted)}>
                  {busy ? "Working…" : isToken ? "Redeem ecash token" : pasted?.amountSat ? `Pay ${pasted.amountSat.toLocaleString()} sats` : "Pay"}
                </Button>
                {payInput.trim() && !isToken && !pasted ? <Notice tone="error">That is not a Lightning invoice.</Notice> : <Notice>Paying a contact? Use ⚡ in the chat.</Notice>}
              </form>
            )}
          </div>
        )}

        {action === "history" && (
          <div className="bg-surface rounded-xl p-4 space-y-2 animate-fade-in" data-testid="wallet-history-list">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
              <span>{state.history.length === 0 ? "Nothing yet" : `${state.history.length} movement${state.history.length === 1 ? "" : "s"}`}</span>
              <span data-testid="wallet-fees-paid">Fees paid: {state.feesPaid.toLocaleString()} sats</span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {state.history.map((tx) => {
                const incoming = tx.kind === "lightning-in" || tx.kind === "ecash-in" || tx.kind === "reclaimed";
                const mint = state.mints.find((m) => m.url === tx.mint);
                return (
                  <div key={tx.id} className="text-sm py-2" data-testid="wallet-tx">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-text-primary truncate">{TX_LABEL[tx.kind]}</span>
                      <span className={`font-semibold shrink-0 tabular-nums ${incoming ? "text-accent" : "text-text-primary"}`}>{incoming ? "+" : "−"}{tx.amount.toLocaleString()}</span>
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
          <Button key={i.id} className="block w-full text-left" onClick={() => setReview(i)}>{i.amount} sats · {i.state}</Button>
        ))}
        {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
      </div>

      {rail === "lightning" ? (
        <Section title="Settings">
          <Row label="Balance" hint="Lightning uses your Cashu balance: invoices are paid into, and paid from, your Cashu mints."><Button onClick={onOpenCashu}>Cashu settings</Button></Row>
        </Section>
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
