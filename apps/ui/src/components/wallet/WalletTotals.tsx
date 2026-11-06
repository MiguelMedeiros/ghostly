import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { useOutsideDismiss, useTabTrap } from "../../hooks/useDismiss";
import { useIsMobile } from "../../hooks/useIsMobile";
import { formatAmount, formatTokenAmount } from "../../lib/amount";
import type { WalletNetwork, WalletState } from "../../lib/platform";
import { Row } from "../layout/Section";
import { NetworkTag, satsIn } from "../NetworkTag";
import type { InstanceCard } from "../walletCardData";
import { walletTotals, type BitcoinTotal, type TotalRow, type UsdtTotal } from "../walletTotals";

type Currency = "bitcoin" | "usdt";
const NAME: Record<Currency, string> = { bitcoin: "Bitcoin", usdt: "USDT" };

/** A row's test id: `wallet-total-row-bitcoin-testnet`, as the card's (`wallet-card-bitcoin-testnet`). */
const totalRowTestId = (id: string) => `wallet-total-row-${id.replace(/:/g, "-")}`;

/**
 * One balance per currency over a network's deck, as a wallet shows it: Bitcoin (every Bitcoin card of the tab) and
 * USDT. Pressing one opens where it comes from (`TotalBreakdown`). Only the tab's network is summed; a card whose
 * balance is not known now stays out of the total, and the line under it says how many.
 */
export function WalletTotals({ state, network, cards }: { state: WalletState; network: WalletNetwork; cards: InstanceCard[] }) {
  const { t } = useI18n();
  const totals = walletTotals(state, network, cards);
  const [open, setOpen] = useState<Currency | null>(null);
  const panel = useId();
  if (!totals.bitcoin && !totals.usdt) return null;
  const shown = open && totals[open] ? open : null;
  return <>
    <div role="group" aria-label={t("wallet.total.label")} data-testid="wallet-totals" data-network={network} className="bg-surface rounded-xl divide-y divide-border">
      {totals.bitcoin && <TotalButton currency="bitcoin" amount={sats(totals.bitcoin.total, network, t)} uncounted={totals.bitcoin.uncounted} large expanded={shown === "bitcoin"} controls={panel} onOpen={() => setOpen("bitcoin")} />}
      {totals.usdt && <TotalButton currency="usdt" amount={usdtAmount(totals.usdt.total, totals.usdt, t)} uncounted={totals.usdt.uncounted} expanded={shown === "usdt"} controls={panel} onOpen={() => setOpen("usdt")} />}
    </div>
    {shown && <TotalBreakdown id={panel} currency={shown} total={totals[shown]!} onClose={() => setOpen(null)} />}
  </>;
}

/** An amount, the number isolated (in a right-to-left page a Latin unit glued to it) and its unit beside it. */
type Amount = { number: string; unit: string };
const sats = (n: number, network: WalletNetwork, t: Translate): Amount => ({ number: formatAmount(n, t.language), unit: satsIn(t, network, n) });
const usdtAmount = (n: bigint, total: Pick<UsdtTotal, "decimals" | "test">, t: Translate): Amount => ({ number: formatTokenAmount(n.toString(), total.decimals, t.language), unit: total.test ? "TEST-USDT" : "USDT" });
const amountText = (t: Translate, a: Amount) => t("wallet.cards.amount", { amount: a.number, unit: a.unit });

function AmountText({ amount, className }: { amount: Amount; className: string }) {
  return <span className="text-text-primary"><bdi className={`${className} font-semibold tabular-nums`}>{amount.number}</bdi><span className="text-text-muted text-sm ms-2">{amount.unit}</span></span>;
}

function TotalButton({ currency, amount, uncounted, large, expanded, controls, onOpen }: { currency: Currency; amount: Amount; uncounted: number; large?: boolean; expanded: boolean; controls: string; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" data-testid={`wallet-total-${currency}`} data-uncounted={uncounted} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? controls : undefined} onClick={onOpen}
      className="w-full flex items-center gap-3 px-4 py-3 min-h-12 text-start hover:bg-surface-alt transition-colors cursor-pointer first:rounded-t-xl last:rounded-b-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
      <span className="flex-1 min-w-0">
        <span className="block text-xs text-text-muted">{NAME[currency]}</span>
        <span className="block" data-testid={`wallet-total-${currency}-amount`}><AmountText amount={amount} className={large ? "text-3xl" : "text-xl"} /></span>
        {uncounted > 0 && <span className="block text-xs text-text-muted mt-0.5" data-testid={`wallet-total-${currency}-uncounted`}>{t("wallet.total.uncounted", { count: uncounted })}</span>}
      </span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="shrink-0 text-text-muted rtl:-scale-x-100" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
  );
}

/**
 * Where a total comes from: one row per card of the tab, its amount and an honest note (unconfirmed, ecash held by a
 * mint, the same balance as another card, couldn't read it now), and for Bitcoin what is ready to spend now. A panel
 * from the end edge on a wide screen, a sheet from the bottom on a phone, as a message's details are. Escape, the
 * close button, Back or a tap outside close it, and the focus goes back to the total.
 */
function TotalBreakdown({ id, currency, total, onClose }: { id: string; currency: Currency; total: BitcoinTotal | UsdtTotal; onClose: () => void }) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOutsideDismiss(ref, true, onClose);
  useTabTrap(ref);
  useEffect(() => {
    const at = document.activeElement;
    const opener = at instanceof HTMLElement && at !== document.body && !ref.current?.contains(at) ? at : null;
    ref.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  const bitcoin = currency === "bitcoin" ? total as BitcoinTotal : null, usdt = currency === "usdt" ? total as UsdtTotal : null;
  const amount = bitcoin ? sats(bitcoin.total, bitcoin.network, t) : usdtAmount(usdt!.total, usdt!, t);
  const rows: ReactNode[] = bitcoin
    ? bitcoin.rows.map((row) => <TotalLine key={row.id} row={row} amount={row.amount === undefined ? undefined : sats(row.amount, bitcoin.network, t)} note={note(t, row, bitcoin.network)} />)
    : usdt!.rows.map((row) => <TotalLine key={row.id} row={row} amount={row.amount === undefined ? undefined : usdtAmount(row.amount, usdt!, t)} note={note(t, row, usdt!.network)} />);
  return createPortal(<>
    <div aria-hidden="true" data-testid="wallet-total-backdrop" className="fixed inset-0 z-50 bg-black/30 animate-fade-in" />
    <div ref={ref} id={id} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="wallet-total-breakdown" data-currency={currency} data-network={total.network} data-side={phone ? "bottom" : "end"}
      className={`fixed z-50 flex flex-col bg-surface border-border shadow-2xl outline-none ${phone ? "inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl border-t pb-safe" : "inset-y-0 end-0 w-[min(400px,100vw)] border-s"}`}>
      <div className="relative flex items-start gap-3 px-4 pt-3 pb-2 border-b border-border shrink-0">
        {phone && <div aria-hidden="true" className="absolute top-1.5 inset-x-0 mx-auto h-1 w-9 rounded-full bg-border-bright" />}
        <div className="min-w-0 flex-1 pt-1">
          <h2 id={titleId} className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">{NAME[currency]}<NetworkTag network={total.network} testId="wallet-total-network" /></h2>
          <p className="m-0 mt-0.5 text-xs text-text-muted">{t("wallet.total.title")}</p>
        </div>
        <button type="button" data-testid="wallet-total-close" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
          className="shrink-0 p-1.5 -me-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer max-md:min-h-11 max-md:min-w-11 grid place-items-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-start">
        <div className="rounded-xl border border-border divide-y divide-border">
          <Row testId="wallet-total-sum" label={t("wallet.total.total")} info={t("wallet.total.info")} value={<span data-testid="wallet-total-sum-amount">{amountText(t, amount)}</span>} />
          {bitcoin && <Row testId="wallet-total-ready" label={t("wallet.total.ready")} value={<span data-testid="wallet-total-ready-amount">{amountText(t, sats(bitcoin.ready, bitcoin.network, t))}</span>} />}
        </div>
        <div className="rounded-xl border border-border divide-y divide-border" data-testid="wallet-total-rows">{rows}</div>
      </div>
    </div>
  </>, document.body);
}

/** One card's line: its name, its note, and its amount (a dash when it is not known: never a 0). */
function TotalLine<A>({ row, amount, note }: { row: TotalRow<A>; amount?: Amount; note?: string }) {
  const { t } = useI18n();
  const value = row.state === "counted" || row.state === "shared" ? amount && amountText(t, amount) : row.state === "none" ? undefined : "?";
  return (
    <div data-testid={totalRowTestId(row.id)} data-state={row.state} className={row.state === "counted" ? "" : "text-text-muted"}>
      <Row label={row.name} hint={note} value={value === undefined ? undefined : <span data-testid="wallet-total-line-amount">{value}</span>} />
    </div>
  );
}

/** What a row says under its name, in the app's language. */
function note<A>(t: Translate, row: TotalRow<A>, network: WalletNetwork): string | undefined {
  switch (row.state) {
    case "unknown": return t("wallet.total.unknown");
    case "away": return t("wallet.total.away", { device: row.device || t("wallet.away.otherDevice") });
    case "none": return t("wallet.total.none");
    case "shared": return t("wallet.total.shared", { name: row.sharedWith ?? "" });
    case "counted": {
      const pending = typeof row.pending === "number" ? row.pending : 0;
      switch (row.note) {
        case "unconfirmed": return t("wallet.bitcoin.unconfirmed", { amount: formatAmount(pending, t.language), unit: satsIn(t, network) });
        case "waiting": return t("wallet.total.waiting", { amount: formatAmount(pending, t.language), unit: satsIn(t, network) });
        case "mint": return t("wallet.total.mint");
        case "federation": return t("wallet.total.federation");
        default: return undefined;
      }
    }
  }
}
