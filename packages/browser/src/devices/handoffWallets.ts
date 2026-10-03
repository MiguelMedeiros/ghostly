import type { WalletView } from "../shared/types";

/*
 * Until wallets move (part 8 of WISP 06), a handoff never moves money: a profile that holds any in any wallet, or has
 * an operation open, is refused. The check reads the wallet view the pages get, on every network and every wallet type,
 * so a wallet type added later is covered as long as its view says what it holds the way the others do.
 */

/** Fields of a wallet view that say it holds money (a positive amount). */
const AMOUNTS = new Set(["balance", "pending", "spendable"]);

/** Whether some part of a wallet view holds money or waits for something. History is past, and skipped. */
function holds(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 6) return false;
  if (Array.isArray(value)) return value.some((item) => holds(item, depth + 1));
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (AMOUNTS.has(key) && typeof inner === "number" && inner > 0) return true;
    if (key === "awaiting" && Array.isArray(inner) && inner.length > 0) return true;
    if (key !== "history" && holds(inner, depth + 1)) return true;
  }
  return false;
}

/**
 * Why this profile's money keeps it from moving now: `wallet` while any wallet holds money or waits for something
 * (an invoice, ecash not taken), `payment` while a payment is not settled; null when there is nothing.
 */
export function walletHandoffProblem(view: WalletView): "wallet" | "payment" | null {
  const { history: _history, intents, ...rest } = view;
  if (holds(rest)) return "wallet";
  if ((intents ?? []).some((intent) => ["pending", "submitted", "unknown"].includes(intent.state))) return "payment";
  return null;
}
