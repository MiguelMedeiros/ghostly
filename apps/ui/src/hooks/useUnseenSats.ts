import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useServicesPlatform } from "./useServicesPlatform";
import type { Translate } from "../contexts/I18nContext";
import { formatAmount } from "../lib/amount";

/**
 * What arrived while the wallet was closed, real and test sats apart, until the Wallets page opens. The account bar
 * and the phone's tab bar both mark it on the wallet icon. It is kept here, not in either bar: the phone's tab bar is
 * gone inside a chat, where sats arrive, and it counts what came in meanwhile when it is back. A profile switch
 * restarts the app, so this is the current profile's.
 */
type Unseen = { real: number; test: number };
let unseen: Unseen = { real: 0, test: 0 };
let last: Unseen | null = null;
const listeners = new Set<() => void>();
const set = (next: Unseen) => { unseen = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** For tests: nothing seen yet, nothing unseen. */
export function resetUnseenSats() { unseen = { real: 0, test: 0 }; last = null; }

export function useUnseenSats(): Unseen {
  const platform = useServicesPlatform();
  const onWallet = useLocation().pathname === "/wallet";
  const wallet = platform?.wallet;
  const walletState = wallet?.getState();
  // Each network's Cashu wallet says its own (an older engine, only the flat one: its test mints' sats are test sats).
  const realBalance = walletState?.networks ? walletState.networks.mainnet.balance : (walletState?.balance ?? 0) - (walletState?.mints.filter((m) => wallet?.testMintUrls.includes(m.url)).reduce((sum, m) => sum + m.balance, 0) ?? 0);
  const testBalance = walletState?.networks ? walletState.networks.testnet.balance : (walletState?.balance ?? 0) - realBalance;

  useEffect(() => {
    const before = last ?? { real: realBalance, test: testBalance };
    const real = Math.max(0, realBalance - before.real), test = Math.max(0, testBalance - before.test);
    if ((real || test) && !onWallet) set({ real: unseen.real + real, test: unseen.test + test });
    last = { real: realBalance, test: testBalance };
  }, [realBalance, testBalance, onWallet]);

  useEffect(() => {
    if (onWallet && (unseen.real || unseen.test)) set({ real: 0, test: 0 });
  }, [onWallet]);

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
