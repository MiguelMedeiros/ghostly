import type { SparkNetwork, WalletNetwork } from "@ghostly/core";
import type { WalletMode } from "../../shared/mints";
import type { ArkConfig } from "./arkade";
import type { BarkNetwork } from "./barkSdk";
import type { UsdtConfig } from "./usdt";

/**
 * The network each wallet's chain belongs to, and what the engine needs of the wallets before any of them loads:
 * their classes come with their first saved wallet (lazyWallet.ts), these with the app.
 */
/** Bitcoin is real money; every other Ark network is for testing. */
export const arkMode=(network:ArkConfig["network"]):WalletMode=>network==="bitcoin"?"mainnet":"testnet";
export const barkMode = (network: BarkNetwork): WalletMode => network === "bitcoin" ? "mainnet" : "testnet";
/** Ethereum carries real USDT; Sepolia and a local chain carry worthless test tokens. */
export const usdtMode=(network:UsdtConfig['network']):WalletMode=>network==='ethereum'?'mainnet':'testnet';
export const sparkMode = (network: SparkNetwork): WalletMode => network === "bitcoin" ? "mainnet" : "testnet";
export const sparkNetworkFor = (network: WalletNetwork): SparkNetwork => network === "mainnet" ? "bitcoin" : "regtest";
export const SPARK_MAINNET_NEEDS_KEY = "Spark on Mainnet needs a Breez API key (free, from Breez). Mainnet moves real bitcoin.";
/** How long a Testnet wallet about to make way for another waits for its server to say what it holds. */
export const RETIRE_READ_MS=10_000;
