import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { WalletCards, type WalletRail } from "../components/WalletCards";
import { CashuWallet } from "../components/wallet/CashuWallet";
import { ArkWalletPanel } from "../components/ArkWalletPanel";
import { UsdtWalletPanel } from "../components/UsdtWalletPanel";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Segmented } from "../components/wallet/ui";

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
  const navigate = useNavigate();
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const wallet = platform?.wallet;
  const state = wallet?.getState();
  const [rail, setRail] = useState<WalletRail>(remembered);
  const testnet = state?.mode === "testnet";
  const [switching, setSwitching] = useState(false), [modeError, setModeError] = useState("");
  const select = (next: WalletRail) => { setRail(next); try { sessionStorage.setItem(RAIL_KEY, next); } catch { /* storage unavailable */ } };

  return (
    <div className="flex-1 flex flex-col bg-chat-bg overflow-hidden min-h-0" data-testid="wallet">
      <header className="h-14 header-safe shrink-0 bg-panel-header flex items-center px-4 border-b border-border">
        <button onClick={() => navigate(-1)} className="max-md:hidden p-2 hover:bg-surface-hover rounded-full transition-colors mr-3 cursor-pointer" aria-label="Back">
          <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <h1 className="text-lg font-medium text-text-primary">{t("tabs.wallet")}</h1>
        {wallet && state && (
          <div className="ml-auto" data-testid="wallet-mode">
            <Segmented label="Wallet network" value={testnet ? "testnet" : "mainnet"} disabled={switching}
              options={[{ value: "mainnet", label: "Mainnet" }, { value: "testnet", label: "Testnet" }]}
              onChange={(mode) => { setSwitching(true); setModeError(""); void wallet.setMode(mode).catch((e: unknown) => setModeError(e instanceof Error ? e.message : String(e))).finally(() => setSwitching(false)); }} />
          </div>
        )}
      </header>
      <div className="flex-1 overflow-y-auto p-6 max-md:p-4">
        <div className="max-w-3xl mx-auto space-y-6">
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
        </div>
      </div>
    </div>
  );
}
