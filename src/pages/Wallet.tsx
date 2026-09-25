import { useDeferredValue, useState } from "react";
import { WalletDeck } from "../components/WalletDeck";
import type { WalletRail } from "../components/walletCardData";
import { CashuWallet } from "../components/wallet/CashuWallet";
import { ArkWalletPanel } from "../components/ArkWalletPanel";
import { BarkWalletPanel } from "../components/BarkWalletPanel";
import { FedimintWalletPanel } from "../components/FedimintWalletPanel";
import { SparkWalletPanel } from "../components/SparkWalletPanel";
import { UsdtWalletPanel } from "../components/UsdtWalletPanel";
import { BitcoinWalletPanel } from "../components/BitcoinWalletPanel";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Segmented } from "../components/wallet/ui";
import { Page } from "../components/layout";

const RAIL_KEY = "ghostly-wallet-rail";
const remembered = (): WalletRail => {
  try { const saved = sessionStorage.getItem(RAIL_KEY); if (saved === "cashu" || saved === "lightning" || saved === "arkade" || saved === "bark" || saved === "spark" || saved === "usdt" || saved === "bitcoin" || saved === "fedimint") return saved; } catch { /* storage unavailable */ }
  return "cashu";
};

/**
 * The wallet, as a page beside the chat list like Settings: every card at the top, as a deck, the chosen
 * one below with what it is for (receive, send) and its few options.
 */
export function Wallet() {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const wallet = platform?.wallet;
  const state = wallet?.getState();
  const [rail, setRail] = useState<WalletRail>(remembered);
  const testnet = state?.mode === "testnet";
  const [switching, setSwitching] = useState(false), [modeError, setModeError] = useState("");
  // The deck paints first and the chosen card's panel follows, in a render React can interrupt for frames: the two
  // together overrun a frame, and opening the wallet (or bringing up another card) would stutter.
  const panel = useDeferredValue<WalletRail | null>(rail, null);
  const select = (next: WalletRail) => { setRail(next); try { sessionStorage.setItem(RAIL_KEY, next); } catch { /* storage unavailable */ } };

  return (
    <Page title={t("tabs.wallet")} testId="wallet" trailing={wallet && state && (
      <div data-testid="wallet-mode">
        <Segmented label="Wallet network" compact value={testnet ? "testnet" : "mainnet"} disabled={switching}
          options={[{ value: "mainnet", label: "Mainnet" }, { value: "testnet", label: "Testnet" }]}
          onChange={(mode) => { setSwitching(true); setModeError(""); void wallet.setMode(mode).catch((e: unknown) => setModeError(e instanceof Error ? e.message : String(e))).finally(() => setSwitching(false)); }} />
      </div>
    )}>
      {testnet && (
        <p className="px-3 py-2 rounded-lg bg-amber-500/15 text-amber-500 text-xs font-medium" data-testid="testnet-notice">
          Testnet: test networks and test coins, worth nothing. Your Mainnet wallets are kept, and come back when you switch.
        </p>
      )}
      {modeError && <p role="alert" className="text-xs text-danger">{modeError}</p>}
      {platform?.notice && <p className="px-3 py-2 rounded-lg bg-yellow-500/10 text-yellow-500 text-xs" data-testid="platform-notice">{platform.notice}</p>}
      {!wallet || !state ? <p className="text-text-muted text-sm">The wallet is not available here.</p> : <>
        <WalletDeck state={state} selected={rail} testMints={wallet.testMintUrls} onSelect={select} />
        <div role="tabpanel" id="wallet-panel" aria-labelledby={`wallet-tab-${rail}`}>
          {(panel === "cashu" || panel === "lightning") && <CashuWallet key={panel} wallet={wallet} state={state} rail={panel} onOpenCashu={() => select("cashu")} />}
          {panel === "arkade" && <ArkWalletPanel wallet={wallet} state={state} />}
          {panel === "bark" && <BarkWalletPanel wallet={wallet} state={state} />}
          {panel === "spark" && <SparkWalletPanel wallet={wallet} state={state} />}
          {panel === "usdt" && <UsdtWalletPanel wallet={wallet} state={state} />}
          {panel === "bitcoin" && <BitcoinWalletPanel wallet={wallet} state={state} />}
          {panel === "fedimint" && <FedimintWalletPanel wallet={wallet} state={state} />}
        </div>
      </>}
    </Page>
  );
}
