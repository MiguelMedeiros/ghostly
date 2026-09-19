import { findBolt11, type Bolt11Invoice } from "@ghostly/core";

const CASHU_PATTERN = /\b(cashu[AB][A-Za-z0-9_\-=+/]{20,}|creq[AB][A-Za-z0-9_\-=]{10,})/i;

export type MoneyInText =
  | { type: "lightning"; invoice: Bolt11Invoice; rest: string }
  | { type: "cashu"; value: string; rest: string };

/** A Lightning invoice, an ecash token or a Cashu payment request pasted into a message. */
export function findMoney(text: string): MoneyInText | null {
  if (text.length < 40) return null;
  const lightning = findBolt11(text);
  if (lightning) return { type: "lightning", ...lightning };
  const cashu = CASHU_PATTERN.exec(text);
  if (!cashu) return null;
  return { type: "cashu", value: cashu[1], rest: (text.slice(0, cashu.index) + text.slice(cashu.index + cashu[0].length)).trim() };
}
