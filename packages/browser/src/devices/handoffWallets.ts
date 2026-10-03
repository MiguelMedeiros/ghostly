import { WALLET_TYPES, type NetworkWalletsView, type WalletView } from "../shared/types";

/*
 * Until wallets move (part 8 of WISP 06), a handoff never moves money: a profile that holds any in any wallet, has an
 * operation open, or has a wallet whose holdings cannot be read now, is refused. It fails closed: an amount that is not
 * a number is money, a wallet that is locked, still connecting or in error is not known to be empty, a wallet kind this
 * build does not know is refused, and so is a view read before the wallets were read once.
 */

/** `wallet`: money, or something a wallet waits for. `payment`: a payment not settled. `loading`: not known yet. */
export type WalletHandoffProblem = "wallet" | "payment" | "loading";

/** An amount that may be money: any number above zero, numeric text above zero, or anything that is not a number. */
function money(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return !(value <= 0);
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "string") { const n = Number(value.trim() || "0"); return !(n <= 0); }
  return true;
}

/** Every field of any wallet view that holds an amount, known to this build. */
const AMOUNTS = new Set(["balance", "pending", "spendable", "incoming", "recoverable", "sweeping", "small", "exiting", "onchain", "unconfirmed", "gasBalance"]);

/** A last net: any amount field anywhere in the view (history aside) that may be money. */
function anyAmount(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => anyAmount(item, depth + 1));
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (AMOUNTS.has(key) && money(inner)) return true;
    if (key === "awaiting" && Array.isArray(inner) && inner.length > 0) return true;
    if (key !== "history" && key !== "recent" && anyAmount(inner, depth + 1)) return true;
  }
  return false;
}

/** One network's wallets (or the flat Mainnet fields of the whole view). */
function network(view: Pick<NetworkWalletsView, "mints" | "balance" | "awaiting" | "ark" | "bark" | "fedimint" | "spark" | "usdt" | "lightning" | "lightnings" | "bitcoin">): WalletHandoffProblem | null {
  const { ark, bark, fedimint, spark, usdt, bitcoin } = view;
  const notReady = (wallet: { configured: boolean; locked: boolean; error?: string } | undefined) => !!wallet?.configured && (wallet.locked || !!wallet.error);
  if (notReady(ark) || notReady(bark) || notReady(spark) || notReady(usdt)) return "loading";
  if (fedimint && (fedimint.error || fedimint.federations.some((federation) => federation.status !== "ready"))) return "loading";
  const sources = [...(view.lightnings ?? []), ...(view.lightning ? [view.lightning] : []), ...(bitcoin ? [bitcoin] : [])];
  if (sources.some((source) => source.status === "connecting" || source.status === "error")) return "loading";
  const amounts: unknown[] = [
    view.balance, ...view.mints.map((mint) => mint.balance),
    ark?.incoming, ark?.balance, ark?.recoverable, ark?.sweeping, ark?.small,
    bark?.balance, bark?.pending, bark?.exiting, bark?.onchain,
    fedimint?.balance, ...(fedimint?.federations ?? []).map((federation) => federation.balance),
    spark?.balance, usdt?.balance, usdt?.gasBalance,
    ...sources.map((source) => source.balance), bitcoin?.unconfirmed,
  ];
  if (amounts.some(money)) return "wallet";
  if ((view.awaiting?.length ?? 0) > 0 || view.mints.some((mint) => (mint.awaiting?.length ?? 0) > 0)) return "wallet";
  return null;
}

/**
 * Why this profile's money keeps it from moving now, or null when there is nothing. `read`: the wallets were read at
 * least once since the engine started (a view before that says nothing about them).
 */
export function walletHandoffProblem(view: WalletView, read: boolean): WalletHandoffProblem | null {
  if (!read) return "loading";
  if ((view.wallets ?? []).some((wallet) => !(WALLET_TYPES as readonly string[]).includes(wallet.type))) return "wallet";
  const networks = view.networks ? Object.values(view.networks) : [];
  const found = [network(view), ...networks.map(network)];
  if (found.includes("loading")) return "loading";
  if (found.includes("wallet")) return "wallet";
  const { history: _history, intents, ...rest } = view;
  if (anyAmount(rest)) return "wallet";
  if ((intents ?? []).some((intent) => intent.state === "pending" || intent.state === "submitted" || intent.state === "unknown")) return "payment";
  return null;
}
