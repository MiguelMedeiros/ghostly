import { WALLET_NETWORKS, type WalletNetwork } from "@ghostly/core";

/** One of something for each network: the engine's wallets, both open at once. */
export type PerNetwork<T> = Record<WalletNetwork, T>;

export const perNetwork = <T>(make: (network: WalletNetwork) => T): PerNetwork<T> =>
  Object.fromEntries(WALLET_NETWORKS.map((network) => [network, make(network)])) as PerNetwork<T>;

/** A single one for both networks (a test, a caller that predates networks), or one per network already. */
export const eachNetwork = <T extends object>(value: T | PerNetwork<T>): PerNetwork<T> =>
  "mainnet" in value && "testnet" in value ? value as PerNetwork<T> : { mainnet: value as T, testnet: value as T };
