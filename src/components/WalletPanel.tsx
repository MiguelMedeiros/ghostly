import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

type View = "closed" | "receive" | "send" | "mints" | "history";

const field =
  "w-full bg-input-bg rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent";
const primary =
  "px-3 py-2 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const secondary =
  "px-3 py-2 text-xs font-bold text-text-muted bg-surface-hover rounded-lg hover:text-text-secondary transition-colors cursor-pointer";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TX_LABEL = {
  "lightning-in": "Received over Lightning",
  "lightning-out": "Paid over Lightning",
  "ecash-in": "Received ecash",
  "ecash-out": "Sent ecash",
  reclaimed: "Took a payment back",
} as const;

/** `input_fee_ppk` in words: a payment usually spends two to five proofs. */
function describeInputFee(ppk: number): string {
  if (ppk === 0) return "Spending ecash is free";
  return `Spending ecash: ${ppk / 1000} sat per proof, rounded up (about 1 sat per payment)`;
}

function describeBounds(bounds: { min: number | null; max: number | null } | null): string {
  if (!bounds) return "not offered";
  const min = Math.max(1, bounds.min ?? 1).toLocaleString();
  return bounds.max === null ? `from ${min} sat, no upper limit` : `${min} to ${bounds.max.toLocaleString()} sats`;
}

/**
 * Sidebar section: an ecash wallet. Sats are held by the mints the user picks,
 * come in over Lightning or from contacts, and go out the same ways.
 */
export function WalletPanel() {
  const wallet = useServicesPlatform()?.wallet;
  const [view, setView] = useState<View>("closed");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<string | null>(null);
  /** Balance when the invoice was created: once it grew by the amount, the invoice was paid. */
  const [balanceBefore, setBalanceBefore] = useState(0);
  const [copied, setCopied] = useState(false);
  const [payInput, setPayInput] = useState("");
  const [quote, setQuote] = useState<{ quote: string; mint: string; amount: number; feeReserve: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [mintUrl, setMintUrl] = useState("");

  const state = wallet?.getState();
  if (!wallet || !state) return null;

  const open = (next: View) => {
    setView(view === next ? "closed" : next);
    setError("");
    setNotice("");
    setInvoice(null);
    setQuote(null);
  };
  const run = async (task: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const addMint = (url: string) =>
    run(async () => {
      await wallet.addMint(url);
      setMintUrl("");
    });

  const isToken = /^cashu[AB]/i.test(payInput.trim());
  // Test sats are worth nothing and must never be added to real ones.
  const testMint = state.mints.find((m) => m.url === wallet.testMintUrl);
  const usesTestMint = testMint !== undefined;
  const realBalance = state.balance - (testMint?.balance ?? 0);

  return (
    <div className="border-t border-border bg-sidebar-bg" data-testid="wallet">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-text-secondary text-xs font-bold uppercase tracking-wider">Wallet</span>
        <button
          data-testid="wallet-settings"
          onClick={() => open("mints")}
          className={`p-1 rounded-full transition-colors cursor-pointer ${view === "mints" ? "text-accent" : "text-text-muted hover:text-text-primary"}`}
          title="Mints"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div className="px-3 pb-3 space-y-2 max-h-[55vh] overflow-y-auto">
        {state.mints.length > 0 && (
          <div className="bg-surface-alt rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <p className="m-0 text-text-primary leading-tight">
              <span data-testid="wallet-balance">
                <span className="text-lg font-semibold">{realBalance.toLocaleString()}</span>
                <span className="text-text-muted text-xs ml-1">sats</span>
              </span>
              {testMint && (
                <span className="block text-[11px] text-yellow-500" data-testid="wallet-test-balance">
                  {testMint.balance.toLocaleString()} test sats (worthless)
                </span>
              )}
            </p>
            <div className="flex gap-1">
              <button data-testid="wallet-history" className={view === "history" ? primary : secondary} onClick={() => open("history")} title="History and fees">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </button>
              <button data-testid="wallet-receive" className={view === "receive" ? primary : secondary} onClick={() => open("receive")}>
                Receive
              </button>
              <button data-testid="wallet-send" className={view === "send" ? primary : secondary} onClick={() => open("send")}>
                Send
              </button>
            </div>
          </div>
        )}

        {view === "receive" && (
          <div className="bg-surface-alt rounded-lg p-3 space-y-2 animate-fade-in">
            {invoice && state.balance >= balanceBefore + Number(amount) ? (
              <div className="text-center py-3 space-y-2">
                <p className="text-accent text-sm font-semibold m-0" data-testid="wallet-paid">
                  ⚡ {Number(amount).toLocaleString()} sats received
                </p>
                <button className={secondary} onClick={() => open("closed")}>
                  Done
                </button>
              </div>
            ) : invoice ? (
              <>
                <div className="bg-white rounded-lg p-2 w-fit mx-auto">
                  <QRCodeSVG value={invoice.toUpperCase()} size={168} />
                </div>
                <code className="block bg-input-bg rounded-lg px-2 py-1.5 text-[10px] text-text-muted font-mono break-all max-h-16 overflow-y-auto select-all" data-testid="wallet-invoice">
                  {invoice}
                </code>
                <button
                  className={`${primary} w-full`}
                  onClick={() => {
                    void navigator.clipboard.writeText(invoice);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied!" : "Copy Lightning invoice"}
                </button>
                <p className="text-text-muted text-[11px] leading-snug m-0">
                  Pay it from any Lightning wallet. The sats show up here as soon as {state.mints[0]?.name ?? "the mint"},
                  which holds them for you, sees the payment.
                </p>
              </>
            ) : (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    setBalanceBefore(state.balance);
                    setInvoice((await wallet.receiveLightning(Number(amount))).invoice);
                  });
                }}
              >
                <input data-testid="wallet-receive-amount" className={field} inputMode="numeric" placeholder="Amount in sats" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} autoFocus />
                <button data-testid="wallet-create-invoice" className={`${primary} w-full`} disabled={busy || !amount}>
                  {busy ? "Asking the mint…" : "Create Lightning invoice"}
                </button>
              </form>
            )}
          </div>
        )}

        {view === "send" && (
          <div className="bg-surface-alt rounded-lg p-3 space-y-2 animate-fade-in">
            {quote ? (
              <>
                <p className="text-text-primary text-sm m-0">
                  Pay <b>{quote.amount.toLocaleString()} sats</b>
                  <span className="text-text-muted"> + up to {quote.feeReserve.toLocaleString()} in fees</span>
                </p>
                <div className="flex gap-2">
                  <button
                    className={`${primary} flex-1`}
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const paid = await wallet.payQuote(quote.quote, quote.mint);
                        setQuote(null);
                        setPayInput("");
                        setNotice(paid ? "Paid." : "The payment is still pending at the mint.");
                      })
                    }
                  >
                    {busy ? "Paying…" : "Pay"}
                  </button>
                  <button className={secondary} onClick={() => setQuote(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (isToken) {
                      const received = await wallet.receiveToken(payInput);
                      setPayInput("");
                      setNotice(`Redeemed ${received.toLocaleString()} sats.`);
                    } else {
                      setQuote(await wallet.quoteInvoice(payInput));
                    }
                  });
                }}
              >
                <textarea className={`${field} font-mono text-xs resize-none`} rows={3} placeholder="Lightning invoice to pay, or an ecash token to redeem" value={payInput} onChange={(e) => setPayInput(e.target.value)} />
                <button className={`${primary} w-full`} disabled={busy || !payInput.trim()}>
                  {busy ? "Working…" : isToken ? "Redeem token" : "Check invoice"}
                </button>
                <p className="text-text-muted text-[11px] leading-snug m-0">To pay a contact, use the ⚡ button in the chat.</p>
              </form>
            )}
          </div>
        )}

        {view === "history" && (
          <div className="bg-surface-alt rounded-lg p-3 space-y-2 animate-fade-in" data-testid="wallet-history-list">
            <div className="flex items-center justify-between text-[11px] text-text-muted">
              <span>{state.history.length === 0 ? "Nothing yet" : `Last ${state.history.length} movements`}</span>
              <span data-testid="wallet-fees-paid">Fees paid so far: {state.feesPaid.toLocaleString()} sats</span>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
              {state.history.map((tx) => {
                const incoming = tx.kind === "lightning-in" || tx.kind === "ecash-in" || tx.kind === "reclaimed";
                const mint = state.mints.find((m) => m.url === tx.mint);
                return (
                  <div key={tx.id} className="text-xs border-b border-border/60 pb-1.5 last:border-0" data-testid="wallet-tx">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-text-primary truncate">{TX_LABEL[tx.kind]}</span>
                      <span className={`font-semibold shrink-0 ${incoming ? "text-accent" : "text-text-primary"}`}>
                        {incoming ? "+" : "−"}
                        {tx.amount.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-[11px] text-text-muted">
                      <span className="truncate">
                        {new Date(tx.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {" · "}
                        {mint?.name ?? new URL(tx.mint).hostname}
                        {tx.note ? ` · ${tx.note}` : ""}
                      </span>
                      <span className={`shrink-0 ${tx.fee > 0 ? "text-yellow-500" : ""}`}>{tx.fee > 0 ? `fee ${tx.fee.toLocaleString()}` : "no fee"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {(view === "mints" || state.mints.length === 0) && (
          <div className="bg-surface-alt rounded-lg p-3 space-y-2 animate-fade-in">
            <p className="text-text-muted text-[11px] leading-snug m-0">
              Your sats are ecash, <b className="text-text-secondary">held by these mints</b>. A mint could lose them
              or disappear, so keep pocket money only. There is no seed backup yet. New Lightning invoices come from
              the first mint.
            </p>
            {state.mints.map((mint, index) => (
              <div key={mint.url} className="flex items-start justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="text-text-primary block truncate">
                    {mint.name}
                    {index === 0 ? (
                      <span className="text-accent ml-1.5 text-[10px] uppercase tracking-wider">primary</span>
                    ) : (
                      <button className="text-text-muted hover:text-accent ml-1.5 text-[10px] uppercase tracking-wider cursor-pointer" onClick={() => run(() => wallet.setPrimaryMint(mint.url))}>
                        make primary
                      </button>
                    )}
                  </span>
                  <span className="text-text-muted font-mono block truncate">{mint.url.replace(/^https?:\/\//, "")}</span>
                  {mint.info ? (
                    <span className="text-text-muted block text-[10px] leading-snug mt-0.5" data-testid="mint-fees">
                      {describeInputFee(mint.info.inputFeePpk)}. Lightning in: {describeBounds(mint.info.receive)}, no mint
                      fee. Lightning out: {describeBounds(mint.info.send)}, routing fee quoted before you pay.
                      {mint.info.motd ? ` “${mint.info.motd}”` : ""}
                    </span>
                  ) : (
                    <span className="text-text-muted block text-[10px] mt-0.5">Not reachable right now</span>
                  )}
                </span>
                <span className="text-text-secondary shrink-0">{mint.balance.toLocaleString()} sats</span>
                <button className="text-text-muted hover:text-danger cursor-pointer text-base leading-none" title="Remove mint" onClick={() => run(() => wallet.removeMint(mint.url))}>
                  &times;
                </button>
              </div>
            ))}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addMint(mintUrl);
              }}
            >
              <input data-testid="wallet-mint-url" className={`${field} font-mono text-xs`} placeholder="https://your.mint" value={mintUrl} onChange={(e) => setMintUrl(e.target.value)} />
              <button data-testid="wallet-add-mint" className={primary} disabled={busy || !mintUrl.trim()}>
                Add
              </button>
            </form>
            {!usesTestMint && (
              <button data-testid="wallet-test-mint" className={`${secondary} w-full`} disabled={busy} onClick={() => addMint(wallet.testMintUrl)}>
                Try with worthless test sats
              </button>
            )}
            {state.balance > 0 && (
              <button
                className={`${secondary} w-full`}
                onClick={() =>
                  run(async () => {
                    const tokens = await wallet.exportTokens();
                    await navigator.clipboard.writeText(tokens.map((t) => t.token).join("\n"));
                    setNotice("Backup copied. Whoever has these tokens has the sats; redeeming them elsewhere empties this wallet.");
                  })
                }
              >
                Copy backup tokens
              </button>
            )}
          </div>
        )}

        {notice && <p className="text-accent text-xs px-1 m-0">{notice}</p>}
        {error && <p className="text-danger text-xs px-1 m-0" data-testid="wallet-error">{error}</p>}
      </div>
    </div>
  );
}
