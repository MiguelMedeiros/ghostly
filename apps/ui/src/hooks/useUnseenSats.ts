import { useEffect, useSyncExternalStore } from "react";
import { useWalletPlatform } from "./useServicesPlatform";
import type { Translate } from "../contexts/I18nContext";
import { formatAmount } from "../lib/amount";
import type { WalletNetwork } from "../lib/platform";

/**
 * What arrived while its network was not in view, real and test sats apart: the account bar and the phone's tab bar
 * mark it on the wallet icon, the Wallets page on its network's tab and Cashu card (lib/needsYou, "seen"). It goes
 * once the Wallets page showed its network and moved off it (the other tab, another page): the dot stays while the
 * person is there to find it. Sats arriving on the network in view are seen as they come. It is kept here, not in
 * either bar: the phone's tab bar is gone inside a chat, where sats arrive, and it counts what came in meanwhile when
 * it is back. A profile switch restarts the app, so this is the current profile's.
 */
type Unseen = { real: number; test: number };
let unseen: Unseen = { real: 0, test: 0 };
let last: Unseen | null = null;
/** The network the Wallets page shows now. */
let shown: WalletNetwork | null = null;
const listeners = new Set<() => void>();
const set = (next: Unseen) => { unseen = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const KEY = { mainnet: "real", testnet: "test" } as const;

/** For tests: nothing seen yet, nothing unseen. */
export function resetUnseenSats() { unseen = { real: 0, test: 0 }; last = null; shown = null; }

/**
 * The Wallets page shows `network`'s tab: what came in there is seen once it moves off it. For an effect: its cleanup
 * decides after the commit, so a remount (React's strict mode) or the same tab drawn again is not "moved off".
 */
export function showingNetwork(network: WalletNetwork): () => void {
  shown = network;
  return () => {
    if (shown === network) shown = null;
    queueMicrotask(() => {
      if (shown === network || !unseen[KEY[network]]) return;
      set({ ...unseen, [KEY[network]]: 0 });
    });
  };
}

export function useUnseenSats(): Unseen {
  // Drawn again when the wallets change only: the Wallets page asks too, and must not redraw on every engine state.
  const wallet = useWalletPlatform();
  const walletState = wallet?.getState();
  // Each network's Cashu wallet says its own (an older engine, only the flat one: its test mints' sats are test sats).
  const realBalance = walletState?.networks ? walletState.networks.mainnet.balance : (walletState?.balance ?? 0) - (walletState?.mints.filter((m) => wallet?.testMintUrls.includes(m.url)).reduce((sum, m) => sum + m.balance, 0) ?? 0);
  const testBalance = walletState?.networks ? walletState.networks.testnet.balance : (walletState?.balance ?? 0) - realBalance;
  // The engine's view is empty (0 sats, no networks) until it has read the wallets as it starts: what they hold then
  // is not new. The first view read is where counting starts.
  const loaded = !!walletState && (!!walletState.networks || walletState.mints.length > 0);

  useEffect(() => {
    if (!loaded) return;
    const before = last ?? { real: realBalance, test: testBalance };
    const real = shown === "mainnet" ? 0 : Math.max(0, realBalance - before.real), test = shown === "testnet" ? 0 : Math.max(0, testBalance - before.test);
    if (real || test) set({ real: unseen.real + real, test: unseen.test + test });
    last = { real: realBalance, test: testBalance };
  }, [loaded, realBalance, testBalance]);

  return useSyncExternalStore(subscribe, () => unseen);
}

/**
 * The wallet place's name and tooltip in the app's language: "Wallets, 109,100 new sats", "Wallets, 21 new test sats",
 * or just "Wallets". The amount is written the app's way, not the device's.
 */
export function unseenSatsLabel(place: string, { real, test }: Unseen, t: Translate): string {
  if (real) return t("wallet.unseen.real", { place, amount: formatAmount(real, t.language) });
  if (test) return t("wallet.unseen.test", { place, amount: formatAmount(test, t.language) });
  return place;
}
