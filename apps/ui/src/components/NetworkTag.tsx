import type { WalletNetwork } from "../lib/platform";
import { useOptionalI18n, type Translate } from "../contexts/I18nContext";

/** What money on a network is called wherever it moves, in English: text first, so a reader who sees no colour still knows. */
export const MONEY_LABEL: Record<WalletNetwork, string> = { testnet: "Test money", mainnet: "Real money" };
/** The words for a network's sats, in English. */
export const satsOf = (network: WalletNetwork) => network === "testnet" ? "test sats" : "sats";
/** `MONEY_LABEL` in the app's language. */
export const moneyLabel = (t: Translate, network: WalletNetwork) => t(network === "testnet" ? "wallet.money.testnet" : "wallet.money.mainnet");
/**
 * `satsOf` in the app's language: for `amount` when given ("1 test sat", Arabic's dual), as a unit beside a field
 * otherwise. Handed to a string as `{{unit}}`, it takes that string's amount by itself (locales/translate.ts).
 */
export const satsIn = (t: Translate, network: WalletNetwork, amount?: number) =>
  t(network === "testnet" ? "wallet.sats.testnet" : "wallet.sats.mainnet", amount === undefined ? undefined : { count: amount });
/** `unit` said for `amount`: a `satsIn` word in its form for that count, any other unit (USDT, ETH) as it is. */
export const unitFor = (t: Translate, unit: string, amount: number) =>
  unit === satsIn(t, "testnet") ? satsIn(t, "testnet", amount) : unit === satsIn(t, "mainnet") ? satsIn(t, "mainnet", amount) : unit;

/**
 * A small tag naming the network's money: "Test money" on Testnet (worth nothing), "Real money" on Mainnet. It sits on
 * every place money moves (a card's back, a review, a request or a payment in the chat, an invoice, a history row),
 * so test coins and real ones are never mistaken. `data-network` carries the network for styles and tests.
 */
export function NetworkTag({ network, testId = "network-tag", className = "" }: { network: WalletNetwork; testId?: string; className?: string }) {
  const i18n = useOptionalI18n();
  return <span className={`network-tag ${className}`.trim()} data-testid={testId} data-network={network}>{i18n ? moneyLabel(i18n.t, network) : MONEY_LABEL[network]}</span>;
}
