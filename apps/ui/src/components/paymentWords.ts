import type { Translate } from "../contexts/I18nContext";

/** A payment's state in the app's language, as a review and a wallet's list of payments say it. */
const STATE_KEY = {
  pending: "payments.review.states.pending",
  submitted: "payments.review.states.submitted",
  settled: "payments.review.states.settled",
  failed: "payments.review.states.failed",
  unknown: "payments.review.states.unknown",
  cancelled: "payments.review.states.cancelled",
  confirmed: "payments.review.states.confirmed",
} as const;

/** The engine's state word (`pending`, `settled`) in words the person reads; a state this app does not know stays as it is. */
export const paymentStateLabel = (t: Translate, state: string): string =>
  state in STATE_KEY ? t(STATE_KEY[state as keyof typeof STATE_KEY]) : state;

/** A Lightning operation's state (an invoice of ours, or a payment through a Lightning card) in the app's language. */
const LIGHTNING_KEY = {
  open: "wallet.lightning.opState.open",
  paid: "wallet.lightning.opState.paid",
  expired: "wallet.lightning.opState.expired",
  sending: "wallet.lightning.opState.sending",
  pending: "wallet.lightning.opState.pending",
  failed: "wallet.lightning.opState.failed",
  unknown: "wallet.lightning.opState.unknown",
} as const;

export const lightningStateLabel = (t: Translate, state: string): string =>
  state in LIGHTNING_KEY ? t(LIGHTNING_KEY[state as keyof typeof LIGHTNING_KEY]) : state;

/**
 * A test chain's own name, where the network tag ("Test money") does not say which chain it is. None for Bitcoin,
 * Ethereum and the test mints: the tag says all there is. Names of chains are not translated.
 */
const CHAIN_NAME: Partial<Record<string, string>> = { signet: "Signet", testnet: "Testnet", mutinynet: "Mutinynet", regtest: "Regtest", sepolia: "Sepolia", "evm-local": "Local EVM" };

/** How a payment's way of paying reads next to its amount: "Cashu", "Ark · Regtest", "Bitcoin on-chain · Signet", "USDT · Sepolia". */
export function railLine(t: Translate, method: string, network: string): string {
  const rail = RAIL_NAME[method] ?? (method === "bitcoin" ? t("payments.bubble.bitcoinOnchain") : method);
  const chain = CHAIN_NAME[network];
  return chain ? `${rail} · ${chain}` : rail;
}
const RAIL_NAME: Partial<Record<string, string>> = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", fedimint: "Fedimint", usdt: "USDT" };
