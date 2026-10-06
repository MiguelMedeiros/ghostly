import { useEffect, useReducer, useRef, useState } from "react";
import { unseenSatsLabel, useUnseenSats } from "../hooks/useUnseenSats";
import { UnseenSatsDot } from "./UnseenSatsDot";
import { useBackupDue } from "../hooks/useBackupDue";
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
import { useAppsAvailable } from "../lib/apps/flag";
import { AppGlyph } from "./apps/AppIcon";


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

/**
 * Whether a place's name is wider than its place, measured in the page itself: the laid-out text against the
 * button, both in fractions of a pixel, in the font the page really drew. Hidden labels (`visibility: hidden`) keep
 * their layout, so this reads the same while they are hidden. The profile's name (`data-name`) is left out.
 */
function placeNameCut(nav: HTMLElement): boolean {
  const range = document.createRange();
  return [...nav.querySelectorAll<HTMLElement>(".account-label:not([data-name])")].some((label) => {
    const button = label.closest("button");
    if (!button) return false;
    range.selectNodeContents(label);
    // Half a pixel spare: text that only just fits can still end in "…" once the page rounds it.
    return range.getBoundingClientRect().width > button.getBoundingClientRect().width - 0.5;
  });
}

export function AccountBar() {
  const nav = useAppNavigation();
  const location = useLocation();
  const { t } = useI18n();
  const { settings } = useSettings();
  const platform = useServicesPlatform();
  const panelRoot = useRef<HTMLDivElement>(null);
  const wallet = platform?.wallet;
  // The balance is not shown here (the Wallet page and its cards have it). What came in while the wallet was closed
  // is a dot on the icon, filled for real sats, hollow for test sats; how many is in the tooltip and the name.
  const unseen = useUnseenSats();
  // A Mainnet wallet's backup reminder asks: a dot too, and its name says so.
  const backupDue = useBackupDue().length > 0;
  // The Profile place wears the profile's name (renamed or switched, it follows); "Profile" only for a profile with none.
  const profile = useCurrentProfile();
  const profileName = profile.name || t("tabs.profile");
  // Five places in a sidebar that can be 280px wide: when a place's name would be cut, the labels go (the icons,
  // their tooltips and names stay), all at once so the row stays even. The profile's name is the user's own and can
  // be long (32 characters is wider than any place), so it never decides this: it ends in "…", whole in its tooltip.
  const navRef = useRef<HTMLElement>(null);
  const [labelsHidden, setLabelsHidden] = useState(false);
  // Apps (WISP 1200), where it shows, takes Services' place: five places is what the bar holds at its narrowest (each
  // stays a 44px target). Services is still reached from the Profile page and from a chat's Shared services.
  const appsOn = useAppsAvailable();
  const placeNames = [t("tabs.wallets"), t("tabs.identities"), appsOn ? t("apps.title") : t("tabs.services"), t("sidebar.settings")].join("\n");
  const placeCount = 3 + (wallet ? 1 : 0) + (platform || appsOn ? 1 : 0);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const fit = () => setLabelsHidden(placeNameCut(nav));
    // The nav, and each place: a place is narrower when another one appears, though the nav keeps its width.
    const observer = new ResizeObserver(fit);
    observer.observe(nav);
    for (const button of nav.querySelectorAll("button")) observer.observe(button);
    fit();
    let live = true;
    // The labels' font drawn at last (a font that arrives later is wider or narrower than the one measured).
    document.fonts?.ready.then(() => { if (live) fit(); }, () => {});
    return () => { live = false; observer.disconnect(); };
  }, [placeNames, placeCount]);
  const identityAttention = useIdentityAttention();
  const onIdentities = location.pathname === "/identities";
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
    canSwitch && glances.othersFresh ? `, ${t("profileSwitcher.othersNew")}` : canSwitch && glances.othersUnread ? `, ${t("profileSwitcher.othersUnread")}` : ""}`;
  const walletLabel = `${unseenSatsLabel(t("tabs.wallets"), unseen, t)}${backupDue ? `, ${t("wallet.backupReminder.label")}` : ""}`;

  return (
    <div ref={panelRoot} className="account-footer relative border-t border-border bg-sidebar-bg" data-testid="account-bar">
      <nav ref={navRef} aria-label={t("sidebar.account")} className="account-actions" data-compact={labelsHidden || undefined}>
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
            {/* Unread messages left in another profile: a ring on the picture, the switcher says where. Something new
                seen waiting for one (WISP 04 § Checking other profiles): the ring and a dot. */}
            {canSwitch && (glances.othersUnread > 0 || glances.othersFresh > 0) && <span data-testid="account-profile-others" aria-hidden="true" className="profile-others-ring" />}
            {canSwitch && glances.othersFresh > 0 && <span data-testid="account-profile-others-new" aria-hidden="true" className="profile-others-new" />}
          </span>
          <span className="account-label" data-name="">{profileName}</span>
        </button>

        {wallet && (
          <button
            data-testid="wallet-chip"
            onClick={() => (onWallet ? nav.home() : nav.place("/wallet"))}
            aria-label={walletLabel}
            aria-current={onWallet ? "page" : undefined}
            className={`account-action relative ${
              onWallet ? "bg-surface-hover text-accent" : "text-text-secondary hover:text-text-primary"
            }`}
            title={walletLabel}
          >
            <span className="relative shrink-0 flex">
              <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 7H5a2 2 0 0 1 0-4h13v4 M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1 M21 11h-5v6h5"/><path d="M18 14h.01"/>
              </svg>
              <UnseenSatsDot unseen={unseen} backup={backupDue} />
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

        {appsOn && (
          <button
            data-testid="account-apps"
            onClick={() => (location.pathname === "/apps" ? nav.home() : nav.place("/apps"))}
            aria-label={t("apps.title")}
            aria-current={location.pathname === "/apps" ? "page" : undefined}
            className={`account-action ${
              location.pathname === "/apps" ? "bg-surface-hover text-accent" : "text-text-muted hover:text-text-primary hover:bg-surface-alt"
            }`}
            title={t("apps.title")}
          >
            <span className="shrink-0 flex"><AppGlyph size={23} /></span>
            <span className="account-label">{t("apps.title")}</span>
          </button>
        )}

        {platform && !appsOn && (
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
          aria-current={location.pathname === "/settings" || location.pathname.startsWith("/settings/") ? "page" : undefined}
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
