import type { WalletNetwork, WalletType } from "../../lib/platform";

/** Each kind of wallet's name, as its card says it. */
export const WALLET_NAME: Record<WalletType, string> = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin", fedimint: "Fedimint", usdt: "USDT" };
/** A network's name, the way a heading or a sentence says it. */
export const NETWORK_NAME: Record<WalletNetwork, string> = { mainnet: "Mainnet", testnet: "Testnet" };
/** One wallet, named with its network ("Testnet Ark"). */
export const walletLabel = (type: WalletType, network: WalletNetwork) => `${NETWORK_NAME[network]} ${WALLET_NAME[type]}`;
