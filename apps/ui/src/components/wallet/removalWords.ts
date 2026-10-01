import type { RemovalWords } from "@ghostly/browser/shared/walletRemoval";
import type { Translate } from "../../contexts/I18nContext";
import { formatAmount, formatTokenAmount } from "../../lib/amount";
import { satsIn } from "../NetworkTag";

/** What a removal holds and waits for, in the app's language: the amounts and the sentences around them. */
export const removalWords = (t: Translate): RemovalWords => ({
  sats: (amount, network) => t("wallet.cards.amount", { amount: formatAmount(amount, t.language), unit: satsIn(t, network) }),
  token: (units, decimals, network) => t("wallet.cards.amount", { amount: formatTokenAmount(units, decimals, t.language), unit: network === "testnet" ? "TEST-USDT" : "USDT" }),
  gas: (wei, network) => t(network === "testnet" ? "wallet.remove.gas.testnet" : "wallet.remove.gas.mainnet", { amount: formatTokenAmount(wei, 18, t.language) }),
  item: (kind, amount) => t(`wallet.remove.item.${kind}`, { amount }),
  and: (first, second) => t("wallet.remove.and", { first, second }),
});
