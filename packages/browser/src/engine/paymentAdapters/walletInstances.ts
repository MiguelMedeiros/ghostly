import { WALLET_NETWORKS, decodeBolt11, walletNetworkOf, type PaymentMethodName, type PaymentNetworks, type WalletNetwork } from "@ghostly/core";
import { mintNetwork } from "../../shared/mints";
import { WALLET_TYPES, type NetworkWalletsView, type StoredPayment, type WalletInstanceView, type WalletType } from "../../shared/types";
import { CASHU_MINT_SOURCE } from "./providers/cashuMint";
import { networkLabel } from "./modeGate";

export const WALLET_NAMES: Record<WalletType, string> = {
  cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin", fedimint: "Fedimint", usdt: "USDT",
};

/** How long a one-click creation waits on its server before it gives up, saving nothing (tests shorten it). */
export const createTiming = { timeoutMs: 60_000 };

export const SPARK_MAINNET_NOT_YET = "Spark on Mainnet has not been tried with real funds yet. Create a Testnet Spark wallet (regtest) instead.";

/**
 * The wallets a profile has, read from both networks' views: one per type and network, in the deck's order. A
 * wallet exists once it holds something to open (a seed, a source, a mint); Lightning through the Cashu mints
 * comes with that network's Cashu wallet.
 */
export function walletInstances(networks: Record<WalletNetwork, NetworkWalletsView>): WalletInstanceView[] {
  const list: WalletInstanceView[] = [];
  for (const type of WALLET_TYPES) for (const network of WALLET_NETWORKS) {
    const config = instanceConfig(type, networks[network]);
    if (config) list.push({ id: `${type}:${network}`, type, network, config });
  }
  return list;
}

function instanceConfig(type: WalletType, view: NetworkWalletsView): Record<string, string> | undefined {
  const text = (value: unknown) => typeof value === "string" ? value : "";
  switch (type) {
    case "cashu": return view.mints.length ? { mint: view.mints[0].url, mints: String(view.mints.length) } : undefined;
    case "lightning": {
      const ln = view.lightning;
      if (!ln?.providerId || (ln.providerId === CASHU_MINT_SOURCE && !view.mints.length)) return undefined;
      return { providerId: ln.providerId, label: text(ln.label) };
    }
    case "arkade": return view.ark?.configured ? { chain: text(view.ark.network), provider: text(view.ark.provider) } : undefined;
    case "bark": return view.bark?.configured ? { chain: text(view.bark.network), provider: text(view.bark.provider) } : undefined;
    case "spark": return view.spark?.configured ? { chain: text(view.spark.network) } : undefined;
    case "bitcoin": return view.bitcoin?.providerId ? { providerId: view.bitcoin.providerId, label: text(view.bitcoin.label) } : undefined;
    case "fedimint": return view.fedimint?.federations.length ? { federations: String(view.fedimint.federations.length) } : undefined;
    case "usdt": return view.usdt?.configured ? { chain: text(view.usdt.network), provider: text(view.usdt.provider) } : undefined;
  }
}

/** For each way of paying, the networks this profile has a wallet on: what every chat tells its contact. */
export function paymentNetworksOf(wallets: readonly WalletInstanceView[]): PaymentNetworks {
  const networks: PaymentNetworks = {};
  for (const wallet of wallets) {
    const method = wallet.type as PaymentMethodName;
    networks[method] = [...new Set([...(networks[method] ?? []), wallet.network])];
  }
  return networks;
}

/**
 * The network of a payment or a request: written on it since wallets have their own, else read from what it
 * carries (a target's chain, a mint, an invoice's chain). A test mint's invoice looks like a Bitcoin one; its
 * mints say Testnet.
 */
export function paymentNetwork(payment: Pick<StoredPayment, "network" | "target" | "mints" | "mint" | "invoice">): WalletNetwork {
  if (payment.network) return payment.network;
  if (payment.target) return payment.target.method === "cashu" ? mintNetwork(payment.target.provider) : walletNetworkOf(payment.target.network);
  const mint = payment.mints?.[0] ?? payment.mint;
  if (mint) return mintNetwork(mint);
  const decoded = payment.invoice ? decodeBolt11(payment.invoice) : null;
  return decoded && decoded.network !== "bitcoin" ? "testnet" : "mainnet";
}

/** The refusal when a card of one network would pay for the other: test coins and real money never meet. */
export const crossNetwork = (card: WalletNetwork, asked: WalletNetwork) =>
  `This is a ${networkLabel(asked)} payment (${asked === "mainnet" ? "real money" : "test coins"}): a ${networkLabel(card)} wallet never pays it. Use a ${networkLabel(asked)} wallet.`;

/**
 * Real money goes out only once the person confirmed it as real money ("Send real money"), whatever screen asked:
 * a spend RPC on Mainnet without `confirmedReal` is refused before anything is spent. Test coins need no second step.
 */
export function assertConfirmedReal(network: WalletNetwork, confirmedReal: unknown): void {
  if (network === "mainnet" && confirmedReal !== true) throw new Error(REAL_MONEY_UNCONFIRMED);
}
export const REAL_MONEY_UNCONFIRMED = "This pays with real money: confirm it with Send real money first. Nothing was sent.";

/** One clear message for a creation that failed: nothing was saved, and trying again is safe. */
export function createFailure(label: string, error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
  return `Could not create the ${label} wallet: ${reason}. Nothing was saved; try again.`;
}
