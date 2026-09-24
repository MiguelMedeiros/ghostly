import { findBolt11, findLightningDestination, parseLightningDestination, type Bolt11Invoice, type LightningDestination } from "@ghostly/core";

const CASHU_PATTERN = /\b(cashu[AB][A-Za-z0-9_\-=+/]{20,}|creq[AB][A-Za-z0-9_\-=]{10,})/i;

export type MoneyInText =
  | { type: "lightning"; invoice: Bolt11Invoice; rest: string }
  | { type: "cashu"; value: string; rest: string }
  | { type: "lnurl"; destination: LightningDestination; rest: string };

/**
 * A Lightning invoice, an ecash token, a Cashu payment request, an LNURL or a Lightning address pasted
 * into a message. A Lightning address looks like an email address, so it only counts when it is the whole
 * message (or prefixed `lightning:` / ⚡); an `lnurl…` is money wherever it is.
 */
export function findMoney(text: string): MoneyInText | null {
  const trimmed = text.trim();
  if (trimmed.length < 40) {
    try {
      const destination = parseLightningDestination(trimmed);
      return destination ? { type: "lnurl", destination, rest: "" } : null;
    } catch { return null; }
  }
  const lightning = findBolt11(text);
  if (lightning) return { type: "lightning", ...lightning };
  const cashu = CASHU_PATTERN.exec(text);
  if (cashu) return { type: "cashu", value: cashu[1], rest: (text.slice(0, cashu.index) + text.slice(cashu.index + cashu[0].length)).trim() };
  try {
    const whole = parseLightningDestination(trimmed);
    if (whole) return { type: "lnurl", destination: whole, rest: "" };
  } catch { return null; }
  const lnurl = findLightningDestination(text);
  return lnurl && lnurl.destination.kind === "lnurl" ? { type: "lnurl", ...lnurl } : null;
}
