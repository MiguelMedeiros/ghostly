import { useEffect, useRef, useState } from "react";
import { useMyAvatar } from "../hooks/useAvatars";
import { useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { THEME_COLOR, currentProfile, themeOf } from "../lib/profiles";


/**
 * The one fixed row at the foot of the sidebar: who you are, what you hold, and
 * the way into everything else. Profile, wallet, services and Settings are all
 * pages beside the list.
 */
/** 21 → "21", 1500 → "1.5k", 2_000_000 → "2M": short enough for a badge on an icon. */
const compact = (sats: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(sats);

export function AccountBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const { settings } = useSettings();
  const platform = useServicesPlatform();
  const panelRoot = useRef<HTMLDivElement>(null);
  /** What arrived while the wallet was closed, real and test sats apart: it has to be noticed. */
  const [unseen, setUnseen] = useState({ real: 0, test: 0 });

  const wallet = platform?.wallet;
  const walletState = wallet?.getState();
  const balance = walletState?.balance ?? 0;
  // Test sats are worthless: the bar shows what the money actually is, and the
  // panel is where the test balance is spelled out.
  // In Testnet the wallet shows only test mints: the whole balance is test sats, and the bar says so.
  const testnet = walletState?.mode === "testnet";
  const testBalance = testnet ? balance : walletState?.mints.filter((m) => wallet?.testMintUrls.includes(m.url)).reduce((sum, m) => sum + m.balance, 0) ?? 0;
  const realBalance = balance - testBalance;
  const balanceLabel = !walletState ? "— sats" : testnet ? `${testBalance.toLocaleString()} test sats` : `${realBalance.toLocaleString()} sats`;
  const walletLabelRef = useRef<HTMLSpanElement>(null);
  const [walletLabelLayout, setWalletLabelLayout] = useState({ fontSize: 10 });
  useEffect(() => {
    const label = walletLabelRef.current, button = label?.parentElement;
    if (!label || !button) return;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const fit = () => {
      context.font = `10px ${getComputedStyle(label).fontFamily}`;
      const available = Math.max(1, button.clientWidth - 8);
      const balanceWidth = context.measureText(balanceLabel).width;
      setWalletLabelLayout({ fontSize: Math.min(10, 10 * available / Math.max(1, balanceWidth)) });
    };
    const observer = new ResizeObserver(fit); observer.observe(button); fit();
    return () => observer.disconnect();
  }, [balanceLabel, wallet]);
  const lastBalanceRef = useRef({ real: realBalance, test: testBalance, testnet });
  const online = platform?.isOnline() ?? false;
  const name = settings.defaultNickname;

  const onWallet = location.pathname === "/wallet";
  const onProfile = location.pathname === "/profile";
  const profile = currentProfile();
  const myAvatar = useMyAvatar();
  useEffect(() => {
    const last = lastBalanceRef.current;
    // Switching between Mainnet and Testnet changes what is shown, not what came in.
    const real = last.testnet === testnet ? Math.max(0, realBalance - last.real) : 0, test = last.testnet === testnet ? Math.max(0, testBalance - last.test) : 0;
    if ((real || test) && !onWallet) setUnseen((u) => ({ real: u.real + real, test: u.test + test }));
    lastBalanceRef.current = { real: realBalance, test: testBalance, testnet };
  }, [realBalance, testBalance, testnet, onWallet]);

  useEffect(() => {
    if (onWallet) setUnseen({ real: 0, test: 0 });
  }, [onWallet]);
  // Real sats say how many; test sats only that some came (they are worth nothing).
  const unseenLabel = unseen.real ? `+${compact(unseen.real)}` : unseen.test ? `+${compact(unseen.test)}` : "";


  return (
    <div ref={panelRoot} className="account-footer relative border-t border-border bg-sidebar-bg" data-testid="account-bar">
      <nav aria-label="Account" className="account-actions">
        <button
          data-testid="account-profile"
          onClick={() => navigate(onProfile ? "/" : "/profile")}
          aria-label={`${t("settings.profile")}: ${profile.name}${name ? `, ${name}` : `, ${t("common.anonymous")}`}, ${online ? "Online" : "Offline"}`}
          aria-current={onProfile ? "page" : undefined}
          className={`account-action ${onProfile ? "bg-surface-hover" : "hover:bg-surface-alt"}`}
          title={`${t("settings.profile")}: ${profile.name}`}
        >
          <span className="relative w-[23px] h-[23px] shrink-0 flex items-center justify-center">
            {/* The active profile's initial in its own color: which profile this is, at a glance. */}
            {myAvatar
              ? <img src={myAvatar} alt="" aria-hidden="true" draggable={false} className="w-[23px] h-[23px] rounded-full object-cover" />
              : <span aria-hidden="true" className="grid place-items-center w-[23px] h-[23px] rounded-full text-[12px] font-bold text-[#111b21]" style={{ background: THEME_COLOR[themeOf(profile.id)] }}>{profile.name.charAt(0).toUpperCase()}</span>}
            {platform && (
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-sidebar-bg ${
                  online ? "bg-accent" : "bg-gray-500"
                }`}
              />
            )}
          </span>
          <span className="account-label">{t("tabs.profile")}</span>
        </button>

        {wallet && (
          <button
            data-testid="wallet-chip"
            onClick={() => navigate(onWallet ? "/" : "/wallet")}
            aria-label={`Wallet: ${walletState ? balanceLabel : "balance unavailable"}${testBalance ? `, ${testBalance.toLocaleString()} test sats` : ""}${unseen.real ? `, ${unseen.real.toLocaleString()} new sats` : unseen.test ? `, ${unseen.test.toLocaleString()} new test sats` : ""}`}
            aria-current={onWallet ? "page" : undefined}
            className={`account-action relative ${
              onWallet ? "bg-surface-hover text-accent" : "text-text-secondary hover:text-text-primary"
            }`}
            title={`Wallet: ${walletState ? balanceLabel : "balance unavailable"}`}
          >
            <span className="relative shrink-0 flex">
              <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 7H5a2 2 0 0 1 0-4h13v4 M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1 M21 11h-5v6h5"/><path d="M18 14h.01"/>
              </svg>
              {/* On the icon itself, saying how much came in: it belongs to the wallet, not to the space beside it. */}
              {unseenLabel && (
                <span data-testid="wallet-new" aria-hidden="true" title={unseen.real ? `${unseen.real.toLocaleString()} new sats` : `${unseen.test.toLocaleString()} new test sats`}
                  className={`wallet-new ${unseen.real ? "" : "wallet-new-test"}`} key={unseenLabel}>{unseenLabel}</span>
              )}
            </span>
            {testBalance > 0 && (
              <span className="sr-only" title="Test sats, worth nothing">
                +{testBalance.toLocaleString()}
              </span>
            )}
            <span ref={walletLabelRef} className="account-wallet-label" style={{fontSize: walletLabelLayout.fontSize}}><span className="account-balance" data-testid="wallet-chip-balance">{balanceLabel}</span></span>
          </button>
        )}

        {platform && (
          <button
            data-testid="account-services"
            onClick={() => navigate(location.pathname === "/services" ? "/" : "/services")}
            aria-label={t("tabs.services")}
            aria-current={location.pathname === "/services" ? "page" : undefined}
            className={`account-action ${
              location.pathname === "/services" ? "bg-surface-hover text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-alt"
            }`}
            title={t("tabs.services")}
          >
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
            </svg>
            <span className="account-label">{t("tabs.services")}</span>
          </button>
        )}

        <button
          data-testid="account-settings"
          aria-label={t("sidebar.settings")}
          aria-current={location.pathname === "/settings" ? "page" : undefined}
          onClick={() => navigate("/settings")}
          className="account-action text-text-muted hover:text-text-primary hover:bg-surface-alt"
          title={t("sidebar.settings")}
        >
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="account-label">Settings</span>
        </button>
      </nav>
    </div>
  );
}
