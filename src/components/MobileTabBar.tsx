import { useLocation } from "react-router-dom";
import { useI18n } from "../contexts/I18nContext";
import { useIdentityAttention } from "../lib/identities";
import { IdentitiesIcon } from "./identities/IdentitiesIcon";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useMyAvatar } from "../hooks/useAvatars";
import { ProfileBadge } from "./ProfileBadge";
import { ProfileSwitcherMenu } from "./ProfileSwitcher";
import { SWITCHER_SHORTCUT, useLongPress, useProfileGlances, useProfileSwitcher } from "../hooks/useProfileSwitcher";
import { useAppNavigation } from "../hooks/useAppNavigation";

const icon = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const TABS = [
  {
    path: "/",
    label: "tabs.chats",
    icon: (
      <svg {...icon}>
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
  },
  {
    path: "/wallet",
    label: "tabs.wallets",
    icon: (
      <svg {...icon}>
        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
      </svg>
    ),
  },
  {
    path: "/identities",
    label: "tabs.identities",
    icon: <IdentitiesIcon size={24} />,
  },
  {
    path: "/services",
    label: "tabs.services",
    icon: (
      <svg {...icon}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    path: "/settings",
    label: "sidebar.settings",
    icon: (
      <svg {...icon}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
] as const;

/**
 * Phone navigation: the places the sidebar's account bar holds on a wide screen, five at most (a 320px phone
 * gives each 64px). Identities is one: it is where a proof about to expire is noticed, and its dot must be
 * seen. Profile is left out, set up once and rarely visited; it is reached from Settings, which carries the
 * active profile's picture on its icon, and holding Settings opens the account switcher.
 */
export function MobileTabBar() {
  const nav = useAppNavigation();
  const { pathname } = useLocation();
  const { t } = useI18n();
  const identityAttention = useIdentityAttention();
  const canSwitch = !!useServicesPlatform()?.features.profiles;
  const switcher = useProfileSwitcher(canSwitch);
  const glances = useProfileGlances();
  const longPress = useLongPress(switcher.show);
  const myAvatar = useMyAvatar();

  return (
    <>
      <nav className="shrink-0 flex bg-panel-header border-t border-border pb-safe" data-testid="mobile-tabs">
        {TABS.map((tab) => {
          const active = pathname === tab.path;
          const dot = tab.path === "/identities" && identityAttention;
          const account = tab.path === "/settings" && canSwitch;
          const others = account && glances.othersUnread > 0;
          const label = dot ? `${t(tab.label)}, ${t("identities.attention")}` : account ? `${t(tab.label)}, ${glances.current.name}${others ? `, ${t("profileSwitcher.othersUnread")}` : ""}` : undefined;
          return (
            <button
              key={tab.path}
              onClick={() => nav.place(tab.path)}
              {...(account ? { ...longPress, "data-switcher-opener": "", "aria-haspopup": "menu" as const, "aria-expanded": switcher.open, "aria-keyshortcuts": SWITCHER_SHORTCUT } : {})}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              data-testid={`mobile-tab-${tab.path.slice(1) || "chats"}`}
              className={`flex-1 min-w-0 min-h-14 px-0.5 flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors select-none [-webkit-touch-callout:none] ${
                active ? "text-accent" : "text-text-muted"
              }`}
            >
              <span className="relative flex">
                {tab.icon}
                {dot && <span data-testid="identities-attention" aria-hidden="true" className="nav-dot nav-dot-tab" />}
                {/* Whose Settings these are: the active profile's picture, ringed when another one left something unread. */}
                {account && (
                  <span data-testid="mobile-tab-profile" aria-hidden="true" className="absolute bottom-0 -right-2.5 rounded-full" style={{ boxShadow: `0 0 0 2px var(--theme-panel-header)${others ? ", 0 0 0 3.5px var(--theme-accent)" : ""}` }}>
                    <ProfileBadge entry={glances.current} size={14} avatar={myAvatar} />
                  </span>
                )}
              </span>
              <span className="max-w-full truncate text-[11px] font-medium leading-none">{t(tab.label)}</span>
            </button>
          );
        })}
      </nav>
      {switcher.open && <ProfileSwitcherMenu variant="sheet" glances={glances} onClose={switcher.close} />}
    </>
  );
}
