import { useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../contexts/I18nContext";

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
    label: "tabs.wallet",
    icon: (
      <svg {...icon}>
        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
      </svg>
    ),
  },
  {
    path: "/share",
    label: "tabs.share",
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

/** Phone navigation: the four places the sidebar stacks on a wide screen. */
export function MobileTabBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useI18n();

  return (
    <nav className="shrink-0 flex bg-panel-header border-t border-border pb-safe" data-testid="mobile-tabs">
      {TABS.map((tab) => {
        const active = pathname === tab.path;
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path, { replace: true })}
            aria-current={active ? "page" : undefined}
            className={`flex-1 min-h-14 flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
              active ? "text-accent" : "text-text-muted"
            }`}
          >
            {tab.icon}
            <span className="text-[11px] font-medium leading-none">{t(tab.label)}</span>
          </button>
        );
      })}
    </nav>
  );
}
