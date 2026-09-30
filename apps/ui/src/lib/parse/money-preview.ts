import type { WalletNetwork } from "@ghostly/core";
import type { MoreMoney } from "./money-more";
import { englishT, type Translate } from "../../locales/translate";

/** "Test money" or "Real money": said in words wherever a network is shown, never by colour alone. */
export const moneyKind = (network: WalletNetwork, t: Translate = englishT) => (network === "mainnet" ? t("chat.preview.realMoney") : t("chat.preview.testMoney"));

const sats = (amount: number | undefined, network: WalletNetwork, t: Translate) => amount === undefined ? []
  : [network === "mainnet" ? t("chat.preview.sats", { amount: amount.toLocaleString() }) : t("chat.preview.testSats", { amount: amount.toLocaleString() })];

/** The chat list's line for a pasted address or offer: what it is and whether it is real money. */
export function moreMoneyPreview(money: MoreMoney, t: Translate = englishT): string {
  const line = (what: string, network: WalletNetwork | undefined, amount?: number) =>
    [what, ...(network ? [moneyKind(network, t), ...sats(amount, network, t)] : [])].join(" · ");
  switch (money.type) {
    case "onchain": return line(t("chat.preview.bitcoinAddress"), money.request.network, money.request.amountSat);
    case "bolt12": return line(t("chat.preview.lightningOffer"), money.offer.network, money.offer.amountSat);
    case "ark": return line(t("chat.preview.arkAddress"), money.request.network, money.request.amountSat);
    case "usdt": return line(t("chat.preview.usdtAddress"), money.request.network);
  }
}
