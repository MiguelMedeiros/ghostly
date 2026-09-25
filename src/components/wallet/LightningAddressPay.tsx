import { useState } from "react";
import type { LightningAddressInfo, WalletPlatform } from "../../lib/platform";
import { CASHU_MINT_SOURCE } from "../walletCardData";

interface Quote { quote: string; mint: string; amount: number; feeReserve: number; source?: string }
interface Invoice { invoice: string; note: string; successAction?: { tag: "message" | "url"; message?: string; description?: string; url?: string } }

/**
 * Paying a Lightning address or an LNURL, step by step: the domain that will learn of it, then what it
 * asks for and the amount, then the invoice it answered with (checked) as a normal review through the
 * Lightning source, then the payment. Used by the wallet's Send tab and by an address pasted in a chat.
 * `via: "cashu"`: the Cashu mints pay, whatever the Lightning source (the Cashu card).
 */
export function LightningAddressPay({ wallet, text, via, onDone, dense }: { wallet: WalletPlatform; text: string; via?: "cashu"; onDone?: () => void; dense?: boolean }) {
  const [info, setInfo] = useState<LightningAddressInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [outcome, setOutcome] = useState<"paid" | "pending" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ln = wallet.getState()?.lightning;
  const sourceName = (source?: string) => (via === "cashu" || !source || source === CASHU_MINT_SOURCE ? "the Cashu mints" : source === ln?.providerId ? ln.alias ?? ln.label ?? source : source);

  const run = async (task: () => Promise<void>) => {
    setError(""); setBusy(true);
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const primary = `${dense ? "px-3 py-1.5 text-xs" : "px-4 py-2 min-h-10 text-sm"} max-md:min-h-11 rounded-lg font-bold bg-accent text-on-accent hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed`;
  const quiet = `${dense ? "px-3 py-1.5 text-xs" : "px-4 py-2 min-h-10 text-sm"} max-md:min-h-11 rounded-lg font-bold bg-black/20 hover:bg-black/30 transition-colors cursor-pointer disabled:opacity-40`;
  const field = `w-full min-w-0 bg-black/20 rounded-lg px-3 py-2 ${dense ? "text-xs" : "text-sm"} placeholder-current/50 focus:outline-none focus:ring-1 focus:ring-accent`;
  const muted = `${dense ? "text-[11px]" : "text-xs"} opacity-70 m-0`;

  if (outcome) {
    return (
      <div className="space-y-1.5" data-testid="lnurl-done">
        <p className={`${dense ? "text-xs" : "text-sm"} font-semibold text-accent m-0`} data-testid={outcome === "paid" ? "lnurl-paid" : "lnurl-pending"}>{outcome === "paid" ? `Paid ${quote?.amount.toLocaleString()} sats to ${text} ✓` : "The payment is still pending. It is being checked; nothing is paid again."}</p>
        {invoice?.successAction?.tag === "message" && invoice.successAction.message && <p className={muted} data-testid="lnurl-success">{info?.domain} says: {invoice.successAction.message}</p>}
        {invoice?.successAction?.tag === "url" && invoice.successAction.url && <p className={muted}>{invoice.successAction.description || `${info?.domain} left a link`}: <a className="underline" href={invoice.successAction.url} target="_blank" rel="noopener noreferrer">{invoice.successAction.url}</a></p>}
        {onDone && <button type="button" className={quiet} onClick={onDone}>Done</button>}
      </div>
    );
  }

  if (!info) {
    return (
      <div className="space-y-2" data-testid="lnurl-resolve">
        <p className={muted}>Looking this up asks <b>{domainOf(text)}</b> what it accepts: that server learns that you are about to pay it.</p>
        <button type="button" className={primary} disabled={busy} data-testid="lnurl-lookup" onClick={() => void run(async () => {
          const resolved = await wallet.resolveLightningAddress(text);
          setInfo(resolved);
          if (resolved.minSat === resolved.maxSat) setAmount(String(resolved.minSat));
        })}>{busy ? "Looking up…" : "Look up"}</button>
        {error && <p className={`${dense ? "text-[11px]" : "text-xs"} text-danger-ink m-0`} role="alert" data-testid="lnurl-error">{error}</p>}
      </div>
    );
  }

  if (quote && invoice) {
    return (
      <div className="space-y-2" data-testid="lnurl-review">
        <p className={`${dense ? "text-xs" : "text-sm"} m-0`}>Pay <b>{quote.amount.toLocaleString()} sats</b> to {info.text}<span className="opacity-70"> + up to {quote.feeReserve.toLocaleString()} in fees · through {sourceName(quote.source)}</span></p>
        {info.description && <p className={muted}>{info.description}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={busy} data-testid="lnurl-pay" onClick={() => void run(async () => {
            const paid = await wallet.payQuote(quote.quote, quote.mint, invoice.note);
            setOutcome(paid ? "paid" : "pending");
          })}>{busy ? "Paying…" : "Pay"}</button>
          <button type="button" className={quiet} disabled={busy} onClick={() => { setQuote(null); setInvoice(null); }}>Cancel</button>
        </div>
        {error && <p className={`${dense ? "text-[11px]" : "text-xs"} text-danger-ink m-0`} role="alert" data-testid="lnurl-error">{error}</p>}
      </div>
    );
  }

  const fixed = info.minSat === info.maxSat;
  // Not a <form>: this panel lives inside the wallet's Send form, and a form in a form submits the page.
  const getInvoice = () => { if (!busy && Number(amount)) void run(async () => {
    const got = await wallet.lightningAddressInvoice(info.id, Number(amount), comment || undefined);
    const quoted = await wallet.quoteInvoice(got.invoice, via);
    if (quoted.amount !== Number(amount)) throw new Error("The invoice does not match the amount you chose");
    setInvoice(got); setQuote(quoted);
  }); };
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); getInvoice(); } };
  return (
    <div className="space-y-2" data-testid="lnurl-amount-form">
      <p className={`${dense ? "text-xs" : "text-sm"} m-0`}><b>{info.text}</b>{info.description ? ` · ${info.description}` : ""}</p>
      <p className={muted} data-testid="lnurl-domain">Answered by {info.domain}{info.callbackDomain !== info.domain ? `; the invoice comes from ${info.callbackDomain}` : ""}. {fixed ? `It asks for exactly ${info.minSat.toLocaleString()} sats.` : `It takes ${info.minSat.toLocaleString()} to ${info.maxSat.toLocaleString()} sats.`}</p>
      <label className="flex items-baseline gap-2 bg-black/20 rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
        <input data-testid="lnurl-amount" inputMode="numeric" placeholder="0" aria-label="Amount in sats" autoFocus={!fixed} disabled={fixed}
          className={`min-w-0 flex-1 bg-transparent border-none outline-none ${dense ? "text-lg" : "text-2xl"} font-semibold tabular-nums`}
          value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} onKeyDown={onEnter} />
        <span className="text-xs opacity-70 shrink-0">sats</span>
      </label>
      {info.commentAllowed > 0 && <input data-testid="lnurl-comment" className={field} placeholder={`A comment for ${info.text} (optional)`} maxLength={info.commentAllowed} value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={onEnter} />}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={busy || !Number(amount)} data-testid="lnurl-invoice" onClick={getInvoice}>{busy ? "Asking for the invoice…" : "Get invoice"}</button>
        <button type="button" className={quiet} disabled={busy} onClick={() => { setInfo(null); setAmount(""); setComment(""); }}>Back</button>
      </div>
      {error && <p className={`${dense ? "text-[11px]" : "text-xs"} text-danger-ink m-0`} role="alert" data-testid="lnurl-error">{error}</p>}
    </div>
  );
}

/** The host that will be asked, from what was pasted: an address's domain, or an LNURL's host when it is plain. */
function domainOf(text: string): string {
  const at = text.lastIndexOf("@");
  if (at > 0) return text.slice(at + 1);
  const lnurlp = /^lnurlp:\/\/([^/?#]+)/i.exec(text.trim());
  return lnurlp ? lnurlp[1] : "the LNURL's server";
}
