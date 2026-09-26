import { findMoney } from "./money";
import { plainText } from "./parse";
import { moreMoneyPreview } from "./parse/money-preview";

/**
 * A pasted invoice or token reads as what it is, not as its first characters; formatted text reads without its
 * markers, and a spoiler stays hidden.
 */
export function previewText(text: string): string {
  const money = findMoney(text);
  if (!money) return plainText(text);
  if (money.type === "cashu") return "⚡ Ecash";
  if (money.type === "onchain" || money.type === "bolt12" || money.type === "ark" || money.type === "usdt") return moreMoneyPreview(money);
  if (money.type === "lnurl") return `⚡ ${money.destination.kind === "address" ? "Lightning address" : "LNURL"} · ${money.destination.text}`;
  return money.invoice.amountSat === null ? "⚡ Lightning invoice" : `⚡ Lightning invoice · ${money.invoice.amountSat.toLocaleString()} sats`;
}

/** How long ago, as short as a list's column allows: "now", "5m", "3h", "2d", then the date. */
export function formatListTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
