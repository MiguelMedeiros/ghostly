import { walletNetworkOf, type WalletNetwork } from "@ghostly/core";
import { STORES, transact } from "../../shared/idb";

/**
 * The wallets whose seed is stored under one settings key per network. Until wallets had their own network, the
 * wallet of the mode in use lived under the bare key (`arkWallet`) and the other mode's was parked under
 * `arkWallet-mode-<mode>`. Now each network's wallet always lives under `<key>-mode-<network>`, and both are
 * open at once.
 */
export type NetworkRail = "arkWallet" | "usdtWallet" | "barkWallet" | "sparkWallet";

/** Where the wallet of one network is stored. The same key an older app parks it under, so it finds it too. */
export const walletKey = (rail: NetworkRail, network: WalletNetwork) => `${rail}-mode-${network}`;

/** The chain a stored wallet runs on, read the way each wallet stores it. Undefined: a record this cannot read. */
const chainOf: Record<NetworkRail, (saved: unknown) => string | undefined> = {
  arkWallet: (saved) => (saved as { config?: { network?: unknown } })?.config?.network as string | undefined,
  usdtWallet: (saved) => (saved as { config?: { network?: unknown } })?.config?.network as string | undefined,
  barkWallet: (saved) => (saved as { config?: { network?: unknown } })?.config?.network as string | undefined,
  sparkWallet: (saved) => (saved as { network?: unknown })?.network as string | undefined,
};

export interface MovedWallet { rail: NetworkRail; network: WalletNetwork; key: string; retired?: string }
export interface WalletNetworksMigration {
  /** Wallets moved from the bare key to their network's key. */
  moved: MovedWallet[];
  /** Bare keys left where they were: their record does not say its chain. */
  unreadable: NetworkRail[];
}

/**
 * Moves each wallet stored under a bare key to its network's key, in one transaction: either every move happens
 * or none does, so an interrupted start leaves the profile as it was. Nothing is ever deleted: in the one case
 * where both keys hold a wallet (never written by any version, but not impossible), the one under the network's
 * key is kept as a retired wallet, the way a replaced wallet is, so its seed survives. Idempotent: a second run
 * finds no bare key and does nothing.
 *
 * Never logs or returns a seed: the report names keys only.
 */
export async function migrateWalletNetworks(now = Date.now()): Promise<WalletNetworksMigration> {
  const report: WalletNetworksMigration = { moved: [], unreadable: [] };
  const rails = Object.keys(chainOf) as NetworkRail[];
  await transact([STORES.settings], (stores) => {
    const settings = stores[STORES.settings];
    for (const rail of rails) {
      const bare = settings.get(rail);
      bare.onsuccess = () => {
        const saved: unknown = bare.result;
        if (saved === undefined) return;
        const chain = chainOf[rail](saved);
        if (typeof chain !== "string" || !chain) { report.unreadable.push(rail); return; }
        const network = walletNetworkOf(chain), key = walletKey(rail, network);
        const parked = settings.get(key);
        parked.onsuccess = () => {
          const moved: MovedWallet = { rail, network, key };
          if (parked.result !== undefined) { moved.retired = `${rail}-retired-${now}-${network}`; settings.put(parked.result, moved.retired); }
          settings.put(saved, key);
          settings.delete(rail);
          report.moved.push(moved);
        };
      };
    }
  });
  return report;
}
