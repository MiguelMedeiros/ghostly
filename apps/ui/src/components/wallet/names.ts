import type { WalletNetwork, WalletType } from "../../lib/platform";

/** Each kind of wallet's name, as its card says it. */
export const WALLET_NAME: Record<WalletType, string> = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin", fedimint: "Fedimint", usdt: "USDT" };
/** A network's name, the way a heading or a sentence says it. */
export const NETWORK_NAME: Record<WalletNetwork, string> = { mainnet: "Mainnet", testnet: "Testnet" };
/** One wallet, named with its network ("Testnet Ark"). */
export const walletLabel = (type: WalletType, network: WalletNetwork) => `${NETWORK_NAME[network]} ${WALLET_NAME[type]}`;
/** Why a kind is not there yet, in one line: the reason's first sentence. */
export const shortReason = (reason: string) => reason.split(/(?<=\.)\s/)[0];
/**
 * Why making a kind failed, in a line for its card: the engine's reason without "Could not create the … wallet:" in
 * front, its first sentence ("Could not reach testnut.cashu.space."). The whole message stays where there is room.
 */
export const failedBecause = (text: string) => shortReason(text.replace(/^Could not create the .+? wallet: /, ""));
