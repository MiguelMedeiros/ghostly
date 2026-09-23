import { useState } from "react";
import { WalletCards, type WalletRail } from "../components/WalletCards";
import { CashuWallet } from "../components/wallet/CashuWallet";
import { ArkWalletPanel } from "../components/ArkWalletPanel";
import { UsdtWalletPanel } from "../components/UsdtWalletPanel";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Segmented } from "../components/wallet/ui";
import { Page } from "../components/layout";

const RAIL_KEY = "ghostly-wallet-rail";
const remembered = (): WalletRail => {
  try { const saved = sessionStorage.getItem(RAIL_KEY); if (saved === "cashu" || saved === "lightning" || saved === "arkade" || saved === "usdt") return saved; } catch { /* storage unavailable */ }
  return "cashu";
};

/**
 * The wallet, as a page beside the chat list like Settings: every card at the top, the chosen
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
        <WalletCards state={state} selected={rail} testMints={wallet.testMintUrls} onSelect={select} />
        {(rail === "cashu" || rail === "lightning") && <CashuWallet key={rail} wallet={wallet} state={state} rail={rail} onOpenCashu={() => select("cashu")} />}
        {rail === "arkade" && <ArkWalletPanel wallet={wallet} state={state} />}
        {rail === "usdt" && <UsdtWalletPanel wallet={wallet} state={state} />}
      </>}
    </Page>
  );
}
