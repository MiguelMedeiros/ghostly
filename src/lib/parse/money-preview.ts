import type { WalletNetwork } from "@ghostly/core";
import type { MoreMoney } from "./money-more";

/** "Test money" or "Real money": said in words wherever a network is shown, never by colour alone. */
export const moneyKind = (network: WalletNetwork) => (network === "mainnet" ? "Real money" : "Test money");

const sats = (amount: number | undefined, network: WalletNetwork) =>
  amount === undefined ? "" : ` · ${amount.toLocaleString()} ${network === "mainnet" ? "sats" : "test sats"}`;

/** The chat list's line for a pasted address or offer: what it is and whether it is real money. */
export function moreMoneyPreview(money: MoreMoney): string {
  switch (money.type) {
    case "onchain": return `₿ Bitcoin address · ${moneyKind(money.request.network)}${sats(money.request.amountSat, money.request.network)}`;
    case "bolt12": return `⚡ Lightning offer · ${moneyKind(money.offer.network)}${sats(money.offer.amountSat, money.offer.network)}`;
    case "ark": return `Ark address · ${moneyKind(money.request.network)}${sats(money.request.amountSat, money.request.network)}`;
    case "usdt": return `USDT address${money.request.network ? ` · ${moneyKind(money.request.network)}` : ""}`;
  }
}
