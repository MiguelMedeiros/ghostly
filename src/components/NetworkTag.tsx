import type { WalletNetwork } from "../lib/platform";

/** What money on a network is called wherever it moves: text first, so a reader who sees no colour still knows. */
export const MONEY_LABEL: Record<WalletNetwork, string> = { testnet: "Test money", mainnet: "Real money" };
/** The words for a network's sats. */
export const satsOf = (network: WalletNetwork) => network === "testnet" ? "test sats" : "sats";

/**
 * A small tag naming the network's money: "Test money" on Testnet (worth nothing), "Real money" on Mainnet. It sits on
 * every place money moves (a card's back, a review, a request or a payment in the chat, an invoice, a history row),
 * so test coins and real ones are never mistaken. `data-network` carries the network for styles and tests.
 */
export function NetworkTag({ network, testId = "network-tag", className = "" }: { network: WalletNetwork; testId?: string; className?: string }) {
  return <span className={`network-tag ${className}`.trim()} data-testid={testId} data-network={network}>{MONEY_LABEL[network]}</span>;
}
