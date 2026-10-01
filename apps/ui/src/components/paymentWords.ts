import { decodeBolt11 } from "@ghostly/core";
import { isWorthlessMint } from "@ghostly/browser/shared/mints";
import type { Translate } from "../contexts/I18nContext";
import { formatAmount, formatTokenAmount } from "../lib/amount";
import type { ChatPayment, WalletState } from "../lib/platform";
import { satsIn } from "./NetworkTag";

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

/**
 * Whether a payment or a request moves test money. Test sats are worth nothing, and wherever the payment shows it says
 * so: a contact must not pass them off as money. The payment says its network; one from before networks carries it (a
 * target's chain, a test mint, an invoice's chain). Fedimint: the network of the federation it names, when we joined it.
 */
export function paymentIsTest(payment: ChatPayment, state: WalletState | null | undefined): boolean {
  if (payment.network) return payment.network === "testnet";
  const method = payment.target?.method;
  if (method === "arkade" || method === "bark" || method === "bitcoin" || method === "fedimint" || method === "spark") return payment.target!.network !== "bitcoin";
  const fedimint = payment.federation ?? payment.federations?.[0];
  if (fedimint) {
    const networks = state?.networks;
    const federation = [...(networks?.mainnet.fedimint?.federations ?? []), ...(networks?.testnet.fedimint?.federations ?? []), ...(state?.fedimint?.federations ?? [])].find((f) => f.id === fedimint);
    return !!federation?.network && federation.network !== "bitcoin";
  }
  if (method === "cashu") return payment.target!.network === "cashu-test";
  if (method === "usdt") return payment.target!.network !== "ethereum";
  if (payment.mint) return isWorthlessMint(payment.mint);
  if (payment.mints?.length) return payment.mints.every(isWorthlessMint);
  // A request with only an invoice: its chain says (test mints use lnbc, but they come with their mints).
  return !!payment.invoice && (decodeBolt11(payment.invoice)?.network ?? "bitcoin") !== "bitcoin";
}

/** What a payment's bubble is titled: who sent or asked whom. */
export const paymentTitle = (t: Translate, payment: ChatPayment): string =>
  t(payment.kind === "request" ? (payment.direction === "out" ? "payments.bubble.title.youRequested" : "payments.bubble.title.requests") : payment.direction === "out" ? "payments.bubble.title.youSent" : "payments.bubble.title.sentYou");

/**
 * A payment or a request as one line, the chat list's for a chat whose last message it is: "⚡ You requested 1,234 test
 * sats", in the app's language. The line the engine keeps with the message is English, for the CLI and older apps.
 */
export function paymentLine(t: Translate, payment: ChatPayment, state: WalletState | null | undefined): string {
  const amount = payment.target?.method === "usdt"
    ? `${formatTokenAmount(payment.amount, payment.target.decimals, t.language)} ${payment.target.asset}`
    : t("wallet.cards.amount", { amount: formatAmount(payment.amount, t.language), unit: satsIn(t, paymentIsTest(payment, state) ? "testnet" : "mainnet") });
  return t("chat.preview.payment", { what: paymentTitle(t, payment), amount });
}
