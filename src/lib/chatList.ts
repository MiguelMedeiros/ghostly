import { findMoney } from "./money";
import { plainText } from "./parse";
import { moreMoneyPreview } from "./parse/money-preview";
import { englishT, type Translate } from "../locales/translate";

/** Previews already worked out, by language and message text: the list draws each row again on every change anywhere. */
const CACHES = new WeakMap<Translate, Map<string, string>>();
const PREVIEWS_KEPT = 256;

/**
 * A pasted invoice or token reads as what it is, not as its first characters; formatted text reads without its
 * markers, and a spoiler stays hidden. Worked out once per text.
 */
export function previewText(text: string, t: Translate = englishT): string {
  let previews = CACHES.get(t);
  if (!previews) CACHES.set(t, previews = new Map());
  const known = previews.get(text);
  if (known !== undefined) return known;
  const preview = readPreview(text, t);
  if (previews.size >= PREVIEWS_KEPT) previews.delete(previews.keys().next().value!);
  previews.set(text, preview);
  return preview;
}

function readPreview(text: string, t: Translate): string {
  const money = findMoney(text);
  if (!money) return plainText(text);
  if (money.type === "cashu") return t("chat.preview.ecash");
  if (money.type === "onchain" || money.type === "bolt12" || money.type === "ark" || money.type === "usdt") return moreMoneyPreview(money, t);
  if (money.type === "lnurl") return `⚡ ${money.destination.kind === "address" ? t("chat.preview.lightningAddress") : "LNURL"} · ${money.destination.text}`;
  return money.invoice.amountSat === null ? t("chat.preview.invoice") : t("chat.preview.invoiceSats", { amount: money.invoice.amountSat.toLocaleString() });
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
