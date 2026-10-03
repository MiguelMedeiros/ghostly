import { WALLET_NETWORKS, type WalletNetwork } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../shared/idb";
import { walletKey } from "../engine/paymentAdapters/walletNetworks";
import { sourceKey } from "../engine/paymentAdapters/providers/sources";
import { cardsKey } from "../engine/paymentAdapters/providers/lightningCards";
import type { PlannedWallet, WalletHome } from "./handoffWallets";

/*
 * The home mark of a wallet that stays home (WISP 06 § Wallets that stay home): on the wallet's own record in the
 * profile's settings, so it moves with the profile like any setting, and a restore sees it on the same row that names
 * the wallet's database (a wallet at home keeps its database's name, which a restore would otherwise make new).
 *
 * Where each wallet's record is: Ark, Bark, Spark and USDT under `<rail>-mode-<network>`; Fedimint under
 * `fedimintWallet-<network>`; the on-chain source under `onchainSource-<network>`; a Lightning card in the network's
 * list of cards (`lightningCards-<network>`), on its entry. Cashu has no record of its own: its ecash always moves.
 */

/** The settings key of a wallet's record, and the card on it for a Lightning card; null for a wallet with none. */
export function homeRow(id: string): { key: string; card?: string } | null {
  const [type, network, card] = id.split(":") as [string, WalletNetwork, string | undefined];
  if (!(WALLET_NETWORKS as readonly string[]).includes(network)) return null;
  switch (type) {
    case "arkade": return { key: walletKey("arkWallet", network) };
    case "bark": return { key: walletKey("barkWallet", network) };
    case "spark": return { key: walletKey("sparkWallet", network) };
    case "usdt": return { key: walletKey("usdtWallet", network) };
    case "fedimint": return { key: `fedimintWallet-${network}` };
    case "bitcoin": return { key: sourceKey("onchain", network) };
    case "lightning": return card ? { key: cardsKey(network), card } : null;
    default: return null;
  }
}

export function isWalletHome(value: unknown): value is WalletHome {
  const home = value as Partial<WalletHome> | null;
  return !!home && typeof home === "object" && typeof home.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(home.key)
    && (home.expiresAt === undefined || (Number.isSafeInteger(home.expiresAt) && home.expiresAt > 0));
}

/** The home a record (or a card entry) carries, or undefined. */
export function homeOf(value: unknown): WalletHome | undefined {
  const home = (value as { home?: unknown } | null)?.home;
  return isWalletHome(home) ? home : undefined;
}

interface StoredCards { cards?: { id?: unknown; home?: unknown }[] }

/** Every home mark of the profile, by wallet id. */
export async function readWalletHomes(): Promise<Record<string, WalletHome>> {
  const settings = await store(STORES.settings, "readonly");
  const homes: Record<string, WalletHome> = {};
  for (const network of WALLET_NETWORKS) {
    for (const type of ["arkade", "bark", "spark", "usdt", "fedimint", "bitcoin"]) {
      const id = `${type}:${network}`;
      const home = homeOf(await wrap<unknown>(settings.get(homeRow(id)!.key)));
      if (home) homes[id] = home;
    }
    const cards = await wrap<StoredCards | undefined>(settings.get(cardsKey(network)));
    for (const card of cards?.cards ?? []) {
      const home = homeOf(card);
      if (home && typeof card.id === "string") homes[`lightning:${network}:${card.id}`] = home;
    }
  }
  return homes;
}

/**
 * Writes the plan's marks in one transaction: a wallet that stays home gets its home (and its coins' expiry), a wallet
 * that moves or has nothing to move loses any mark it had. A record that is not there is not made.
 */
export async function writeWalletHomes(wallets: readonly PlannedWallet[]): Promise<void> {
  await transact([STORES.settings], (stores) => {
    const settings = stores[STORES.settings];
    const byKey = new Map<string, { wallet: PlannedWallet; card?: string }[]>();
    for (const wallet of wallets) {
      const row = homeRow(wallet.id);
      if (!row) continue;
      byKey.set(row.key, [...(byKey.get(row.key) ?? []), { wallet, ...(row.card !== undefined ? { card: row.card } : {}) }]);
    }
    const marked = <T extends object>(value: T, wallet: PlannedWallet): T => {
      const { home: _old, ...rest } = value as T & { home?: unknown };
      return (wallet.route === "home" && wallet.home ? { ...rest, home: wallet.home } : rest) as T;
    };
    for (const [key, entries] of byKey) {
      const read = settings.get(key);
      read.onsuccess = () => {
        const value = read.result as Record<string, unknown> | undefined;
        if (!value || typeof value !== "object") return;
        if (entries[0].card === undefined) { settings.put(marked(value, entries[0].wallet), key); return; }
        const cards = (value as StoredCards).cards;
        if (!Array.isArray(cards)) return;
        const next = cards.map((card) => { const entry = entries.find((e) => e.card === card?.id); return entry && card && typeof card === "object" ? marked(card, entry.wallet) : card; });
        settings.put({ ...value, cards: next }, key);
      };
    }
  });
}
