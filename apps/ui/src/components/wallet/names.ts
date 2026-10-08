import type { WalletNetwork, WalletType } from "../../lib/platform";
import type { Translate } from "../../contexts/I18nContext";
import { english } from "../../lib/english";
import { problemText } from "../../lib/problemText";

/** Each kind of wallet's name, as its card says it. */
export const WALLET_NAME: Record<WalletType, string> = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin", fedimint: "Fedimint", usdt: "USDT" };
/** A network's name, the way a heading or a sentence says it. */
export const NETWORK_NAME: Record<WalletNetwork, string> = { mainnet: "Mainnet", testnet: "Testnet" };
/** One wallet, named with its network ("Testnet Ark"). */
export const walletLabel = (type: WalletType, network: WalletNetwork) => `${NETWORK_NAME[network]} ${WALLET_NAME[type]}`;
/** Why a kind is not there yet, in one line: the reason's first sentence. */
export const shortReason = (reason: string) => reason.split(/(?<=\.)\s/)[0];
/**
 * Why making a kind failed, in a line for its card, in `t`'s language: the engine's reason without "Could not create the
 * … wallet:" around it, in a few words ("Can't reach testnut.cashu.space"). `text` is the engine's English.
 */
export const failedBecause = (text: string, t: Translate = english) => {
  const made = /^Could not create the .+? wallet: ([\s\S]+?)\. Nothing was saved; try again\.$/.exec(text);
  // A few words (lib/problemText.ts): the reason's title, never the engine's English in the line.
  return problemText(made ? made[1] : text, t).title;
};
