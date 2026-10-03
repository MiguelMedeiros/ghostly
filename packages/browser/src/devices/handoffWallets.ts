import { WALLET_TYPES, type NetworkWalletsView, type WalletView } from "../shared/types";
import { CASHU_MINT_SOURCE } from "../engine/paymentAdapters/providers/cashuMint";

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

/**
 * A last net: any amount field anywhere in the view (history aside) that may be money, as the path to it. An amount
 * field that holds a list or a record is looked into, not taken for an amount.
 */
function anyAmount(value: unknown, path: string, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) { const found = anyAmount(item, `${path}[${i}]`, depth + 1); if (found) return found; }
    return null;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // A flag under one of those names (a capability: `balance: true`) is no amount.
    if (AMOUNTS.has(key) && (typeof inner === "number" || typeof inner === "string" || typeof inner === "bigint") && money(inner)) return `${path}.${key}`;
    if (key === "awaiting" && Array.isArray(inner) && inner.length > 0) return `${path}.${key}`;
    if (key === "history" || key === "recent") continue;
    const found = anyAmount(inner, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

type Found = { problem: WalletHandoffProblem; at: string };

/**
 * Every field of a network's wallets, and whether this check reads it. A wallet kind added to `NetworkWalletsView`
 * later fails the typecheck here until it is handled; a view that carries a field this build does not name is refused.
 */
export const NETWORK_FIELDS: Readonly<Record<keyof NetworkWalletsView, "checked" | "past">> = {
  mints: "checked", balance: "checked", awaiting: "checked", ark: "checked", bark: "checked", fedimint: "checked", spark: "checked", usdt: "checked",
  lightning: "checked", lightnings: "checked", bitcoin: "checked", history: "past", feesPaid: "past",
};

/** One network's wallets (or the flat Mainnet fields of the whole view), and what in it keeps the profile here. */
function network(view: Pick<NetworkWalletsView, "mints" | "balance" | "awaiting" | "ark" | "bark" | "fedimint" | "spark" | "usdt" | "lightning" | "lightnings" | "bitcoin">, at: string): Found | null {
  const { ark, bark, fedimint, spark, usdt, bitcoin } = view;
  // A wallet set up and not read since it opened says 0 for a balance it never read.
  const notReady = (wallet: { configured: boolean; locked: boolean; read?: true; error?: string } | undefined) => !!wallet?.configured && (wallet.locked || !!wallet.error || !wallet.read);
  for (const [name, wallet] of [["ark", ark], ["bark", bark], ["spark", spark], ["usdt", usdt]] as const) if (notReady(wallet)) return { problem: "loading", at: `${at}.${name}` };
  if (fedimint && (fedimint.error || fedimint.federations.some((federation) => federation.status !== "ready" || !federation.read))) return { problem: "loading", at: `${at}.fedimint` };
  const sources = [...(view.lightnings ?? []).map((source, i) => [`lightnings[${i}]`, source] as const), ...(view.lightning ? [["lightning", view.lightning] as const] : []), ...(bitcoin ? [["bitcoin", bitcoin] as const] : [])];
  // The Cashu mints as a Lightning source hold nothing of their own: their money is the mints' ecash, counted here
  // whether a mint answers or not. Any other source is not known to be empty while it connects or fails.
  for (const [name, source] of sources) if (source.providerId !== CASHU_MINT_SOURCE && (source.status === "connecting" || source.status === "error" || (source.status === "ready" && !source.read))) return { problem: "loading", at: `${at}.${name}` };
  const amounts: [string, unknown][] = [
    ["balance", view.balance], ...view.mints.map((mint, i) => [`mints[${i}].balance`, mint.balance] as [string, unknown]),
    ["ark.incoming", ark?.incoming], ["ark.balance", ark?.balance], ["ark.recoverable", ark?.recoverable], ["ark.sweeping", ark?.sweeping], ["ark.small", ark?.small],
    ["bark.balance", bark?.balance], ["bark.pending", bark?.pending], ["bark.exiting", bark?.exiting], ["bark.onchain", bark?.onchain],
    ["fedimint.balance", fedimint?.balance], ...(fedimint?.federations ?? []).map((federation, i) => [`fedimint.federations[${i}].balance`, federation.balance] as [string, unknown]),
    ["spark.balance", spark?.balance], ["usdt.balance", usdt?.balance], ["usdt.gasBalance", usdt?.gasBalance],
    ...sources.map(([name, source]) => [`${name}.balance`, source.balance] as [string, unknown]), ["bitcoin.unconfirmed", bitcoin?.unconfirmed],
  ];
  const held = amounts.find(([, amount]) => money(amount));
  if (held) return { problem: "wallet", at: `${at}.${held[0]}` };
  if ((view.awaiting?.length ?? 0) > 0) return { problem: "wallet", at: `${at}.awaiting` };
  const waiting = view.mints.findIndex((mint) => (mint.awaiting?.length ?? 0) > 0);
  if (waiting >= 0) return { problem: "wallet", at: `${at}.mints[${waiting}].awaiting` };
  return null;
}

/**
 * Why this profile's money keeps it from moving now, or null when there is nothing. `read`: the wallets were read at
 * least once since the engine started (a view before that says nothing about them). `explain` is told where in the
 * view the reason is (a path, never an amount), for a log line.
 */
export function walletHandoffProblem(view: WalletView, read: boolean, explain?: (at: string) => void): WalletHandoffProblem | null {
  const said = (problem: WalletHandoffProblem, at: string) => { explain?.(at); return problem; };
  if (!read) return said("loading", "not read yet");
  const unknown = (view.wallets ?? []).find((wallet) => !(WALLET_TYPES as readonly string[]).includes(wallet.type));
  if (unknown) return said("wallet", "wallets: a kind this build does not know");
  for (const [name, inner] of Object.entries(view.networks ?? {})) {
    const unnamed = Object.keys(inner).find((key) => !(key in NETWORK_FIELDS));
    if (unnamed) return said("wallet", `networks.${name}.${unnamed}: a field this build does not know`);
  }
  const found = [network(view, "view"), ...Object.entries(view.networks ?? {}).map(([name, inner]) => network(inner, `networks.${name}`))].filter((f): f is Found => !!f);
  const first = found.find((f) => f.problem === "loading") ?? found[0];
  if (first) return said(first.problem, first.at);
  const { history: _history, intents, ...rest } = view;
  const anywhere = anyAmount(rest, "view");
  if (anywhere) return said("wallet", anywhere);
  if ((intents ?? []).some((intent) => intent.state === "pending" || intent.state === "submitted" || intent.state === "unknown")) return said("payment", "intents");
  return null;
}
