import { useEffect, useReducer, useRef, useState } from "react";
import { useMyAvatar } from "../hooks/useAvatars";
import { useLocation } from "react-router-dom";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { THEME_COLOR, currentProfile, themeOf } from "../lib/profiles";
import { useIdentityAttention } from "../lib/identities";
import { IdentitiesIcon } from "./identities/IdentitiesIcon";
import { ProfileSwitcherMenu } from "./ProfileSwitcher";
import { SWITCHER_SHORTCUT, useProfileGlances, useProfileSwitcher } from "../hooks/useProfileSwitcher";
import { useAppNavigation } from "../hooks/useAppNavigation";


/**
 * The one fixed row at the foot of the sidebar: who you are, what you hold, and
 * the way into everything else. Profile, wallet, identities, services and Settings
 * are all pages beside the list. The Profile place is named after the profile it
 * stands for; the Wallets place says only that: the balance is on the page and its cards.
 */
/** The active profile, following a rename or a switch (lib/profiles announces both as "profiles-updated"). */
function useCurrentProfile() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { window.addEventListener("profiles-updated", bump); return () => window.removeEventListener("profiles-updated", bump); }, []);
  return currentProfile();
}
/** 21 → "21", 1500 → "1.5k", 2_000_000 → "2M": short enough for a badge on an icon. */
const compact = (sats: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(sats);

export function AccountBar() {
  const nav = useAppNavigation();
  const location = useLocation();
  const { t } = useI18n();
  const { settings } = useSettings();
  const platform = useServicesPlatform();
  const panelRoot = useRef<HTMLDivElement>(null);
  /** What arrived while the wallet was closed, real and test sats apart: it has to be noticed. */
  const [unseen, setUnseen] = useState({ real: 0, test: 0 });

  const wallet = platform?.wallet;
  const walletState = wallet?.getState();
  // The balance is not shown here (the Wallet page and its cards have it), but what came in while the wallet was
  // closed is counted on the icon, real and test sats apart: test sats are worthless. Each network's Cashu wallet
  // says its own (an older engine, only the flat one: its test mints' sats are test sats).
  const realBalance = walletState?.networks ? walletState.networks.mainnet.balance : (walletState?.balance ?? 0) - (walletState?.mints.filter((m) => wallet?.testMintUrls.includes(m.url)).reduce((sum, m) => sum + m.balance, 0) ?? 0);
  const testBalance = walletState?.networks ? walletState.networks.testnet.balance : (walletState?.balance ?? 0) - realBalance;
  // The Profile place wears the profile's name (renamed or switched, it follows); "Profile" only for a profile with none.
  const profile = useCurrentProfile();
  const profileName = profile.name || t("tabs.profile");
  // Five places in a sidebar that can be 280px wide: when any label would be cut, the labels go (the icons,
  // their tooltips and names stay), all at once so the row stays even.
  const navRef = useRef<HTMLElement>(null);
  const [labelsHidden, setLabelsHidden] = useState(false);
  useEffect(() => {
    const nav = navRef.current;
    const context = nav && document.createElement("canvas").getContext("2d");
    if (!nav || !context) return;
    const fit = () => {
      const labels = [...nav.querySelectorAll<HTMLElement>(".account-label")];
      const button = labels[0]?.closest("button");
      if (!button) return;
      context.font = `10px ${getComputedStyle(button).fontFamily}`;
      const available = button.clientWidth - 2;
      setLabelsHidden(labels.some((label) => context.measureText(label.textContent ?? "").width > available));
    };
    const observer = new ResizeObserver(fit); observer.observe(nav); fit();
    return () => observer.disconnect();
  }, [t, profileName]);
  const identityAttention = useIdentityAttention();
  const onIdentities = location.pathname === "/identities";
  const lastBalanceRef = useRef({ real: realBalance, test: testBalance });
  const online = platform?.isOnline() ?? false;
  const name = settings.defaultNickname;

  const onWallet = location.pathname === "/wallet";
  const onProfile = location.pathname === "/profile";
  const myAvatar = useMyAvatar();
  // The account switcher: a click on the Profile place (the menu leads to the Profile page too), or Alt+Shift+P.
  // Where there is one profile only, the place is the way to the Profile page.
  const canSwitch = !!platform?.features.profiles;
  const switcher = useProfileSwitcher(canSwitch);
  const glances = useProfileGlances();
  const profileLabel = `${t("settings.profile")}: ${profile.name}${name ? `, ${name}` : `, ${t("common.anonymous")}`}, ${online ? "Online" : "Offline"}${
    canSwitch && glances.othersUnread ? `, ${t("profileSwitcher.othersUnread")}` : ""}`;
  useEffect(() => {
    const last = lastBalanceRef.current;
    const real = Math.max(0, realBalance - last.real), test = Math.max(0, testBalance - last.test);
    if ((real || test) && !onWallet) setUnseen((u) => ({ real: u.real + real, test: u.test + test }));
    lastBalanceRef.current = { real: realBalance, test: testBalance };
  }, [realBalance, testBalance, onWallet]);

  useEffect(() => {
    if (onWallet) setUnseen({ real: 0, test: 0 });
  }, [onWallet]);
  // Real sats say how many; test sats only that some came (they are worth nothing).
  const unseenLabel = unseen.real ? `+${compact(unseen.real)}` : unseen.test ? `+${compact(unseen.test)}` : "";
  const unseenTitle = unseen.real ? `${unseen.real.toLocaleString()} new sats` : `${unseen.test.toLocaleString()} new test sats`;


  return (
    <div ref={panelRoot} className="account-footer relative border-t border-border bg-sidebar-bg" data-testid="account-bar">
      <nav ref={navRef} aria-label="Account" className="account-actions" data-compact={labelsHidden || undefined}>
        <button
          data-testid="account-profile"
          onClick={canSwitch ? switcher.toggle : () => (onProfile ? nav.home() : nav.place("/profile"))}
          {...(canSwitch ? { "data-switcher-opener": "", "aria-haspopup": "menu" as const, "aria-expanded": switcher.open, "aria-keyshortcuts": SWITCHER_SHORTCUT } : {})}
          aria-label={profileLabel}
          aria-current={onProfile ? "page" : undefined}
          className={`account-action select-none ${onProfile ? "bg-surface-hover" : "hover:bg-surface-alt"}`}
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
            {/* Unread messages left in another profile: a ring on the picture, the switcher says where. */}
            {canSwitch && glances.othersUnread > 0 && <span data-testid="account-profile-others" aria-hidden="true" className="profile-others-ring" />}
          </span>
          <span className="account-label">{profileName}</span>
        </button>

        {wallet && (
          <button
            data-testid="wallet-chip"
            onClick={() => (onWallet ? nav.home() : nav.place("/wallet"))}
            aria-label={`${t("tabs.wallets")}${unseenLabel ? `, ${unseenTitle}` : ""}`}
            aria-current={onWallet ? "page" : undefined}
            className={`account-action relative ${
              onWallet ? "bg-surface-hover text-accent" : "text-text-secondary hover:text-text-primary"
            }`}
            title={unseenLabel ? `${t("tabs.wallets")}: ${unseenTitle}` : t("tabs.wallets")}
          >
            <span className="relative shrink-0 flex">
              <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 7H5a2 2 0 0 1 0-4h13v4 M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1 M21 11h-5v6h5"/><path d="M18 14h.01"/>
              </svg>
              {/* On the icon itself, saying how much came in: it belongs to the wallet, not to the space beside it. */}
              {unseenLabel && (
                <span data-testid="wallet-new" aria-hidden="true" title={unseenTitle}
                  className={`wallet-new ${unseen.real ? "" : "wallet-new-test"}`} key={unseenLabel}>{unseenLabel}</span>
              )}
            </span>
            <span className="account-label">{t("tabs.wallets")}</span>
          </button>
        )}

        <button
          data-testid="account-identities"
          onClick={() => (onIdentities ? nav.home() : nav.place("/identities"))}
          aria-label={`${t("tabs.identities")}${identityAttention ? `, ${t("identities.attention")}` : ""}`}
          aria-current={onIdentities ? "page" : undefined}
          className="account-action text-text-muted hover:text-text-primary hover:bg-surface-alt"
          title={t("tabs.identities")}
        >
          <span className="relative shrink-0 flex">
            <IdentitiesIcon />
            {/* A proof expiring or expired, a contact's revoked or no longer confirmed, one of yours refused. */}
            {identityAttention && <span data-testid="identities-attention" aria-hidden="true" className="nav-dot" />}
          </span>
          <span className="account-label">{t("tabs.identities")}</span>
        </button>

        {platform && (
          <button
            data-testid="account-services"
            onClick={() => (location.pathname === "/services" ? nav.home() : nav.place("/services"))}
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
          onClick={() => nav.place("/settings")}
          className="account-action text-text-muted hover:text-text-primary hover:bg-surface-alt"
          title={t("sidebar.settings")}
        >
          <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="account-label">{t("sidebar.settings")}</span>
        </button>
      </nav>
      {switcher.open && <ProfileSwitcherMenu variant="popover" glances={glances} onClose={switcher.close} />}
    </div>
  );
}
