import { useEffect, useRef, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { useMyAvatar } from "../hooks/useAvatars";
import { shortcutLabel, type OtherProfile, type useProfileGlances } from "../hooks/useProfileSwitcher";
import { THEME_COLOR, switchProfile, themeOf } from "../lib/profiles";
import { ProfileBadge } from "./ProfileBadge";

const LockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);

/**
 * The switcher itself: the active profile on top in its colors, the others below with their picture and
 * what they left unread, one tap each; then Add a profile and Manage profiles. A popover over the account
 * bar on a wide screen, a sheet from the bottom on a phone. Arrow keys, Home/End, Enter; Escape closes.
 */
export function ProfileSwitcherMenu({ variant, glances, onClose }: {
  variant: "popover" | "sheet";
  glances: ReturnType<typeof useProfileGlances>;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const myAvatar = useMyAvatar();
  const menuRef = useRef<HTMLDivElement>(null);
  const { current, others } = glances;
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];

  // The most likely next step has focus: the first other profile, or adding one.
  useEffect(() => { items()[1]?.focus(); }, []);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (menuRef.current?.contains(target) || target?.closest?.("[data-switcher-opener]")) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items(), at = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => { e.preventDefault(); list[(to + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "Tab") onClose(false);
  };
  const go = (path: string, state?: unknown) => { onClose(false); navigate(path, { state }); };
  const switchTo = (other: OtherProfile) => switchProfile(other.entry.id, { avatar: other.glance?.avatar });

  const itemClass = "w-full flex items-center gap-3 px-3 text-left rounded-lg cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";
  const color = THEME_COLOR[themeOf(current.id)];
  const nickname = settings.defaultNickname || t("common.anonymous");

  const menu = (
    <div ref={menuRef} role="menu" aria-label={t("profileSwitcher.title")} data-testid="profile-switcher" onKeyDown={onKeyDown}
      className={variant === "sheet"
        ? "profile-switcher-sheet fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-border bg-panel-header p-2 pb-safe shadow-2xl"
        : "profile-switcher-popover absolute left-2 right-2 bottom-full mb-1 z-50 max-w-80 rounded-xl border border-border bg-panel-header p-1.5 shadow-2xl"}>
      {variant === "sheet" && <div aria-hidden="true" className="mx-auto mb-2 mt-0.5 h-1 w-9 rounded-full bg-border-bright" />}
      <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("profileSwitcher.title")}</span>
        {variant === "popover" && <kbd className="text-[10px] text-text-muted font-sans" aria-hidden="true">{shortcutLabel()}</kbd>}
      </div>

      <button type="button" role="menuitemradio" aria-checked="true" data-testid="profile-switcher-current"
        aria-label={`${current.name}, ${nickname}, ${t("profileSwitcher.current")}`}
        onClick={() => onClose()} className={`${itemClass} min-h-14 py-2`}>
        <span className="shrink-0 rounded-full" style={{ boxShadow: `0 0 0 2px var(--theme-panel-header), 0 0 0 4px ${color}` }}>
          <ProfileBadge entry={current} size={38} avatar={myAvatar} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-sm font-semibold text-text-primary">{current.name}</span>
          <span className="block truncate text-xs text-text-muted">{nickname}</span>
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
      </button>

      {others.length > 0 && <div role="none" className="my-1 border-t border-border" />}
      {others.map((other) => {
        const { entry, glance } = other;
        const unread = glance?.unread ?? 0;
        const status = glance?.locked ? t("profileSwitcher.locked") : unread ? t("profileSwitcher.unread", { count: unread }) : "";
        return (
          <button key={entry.id || "default"} type="button" role="menuitemradio" aria-checked="false" data-testid="profile-switcher-item"
            aria-label={`${t("profileSwitcher.switchTo", { name: entry.name })}${status ? `, ${status}` : ""}`}
            onClick={() => switchTo(other)} className={`${itemClass} min-h-12 py-1.5`}>
            <span className="shrink-0 rounded-full" style={{ boxShadow: `0 0 0 2px ${THEME_COLOR[themeOf(entry.id)]}66` }}>
              <ProfileBadge entry={entry} size={32} avatar={glance?.avatar} />
            </span>
            <span className="flex-1 min-w-0 truncate text-sm text-text-primary">{entry.name}</span>
            {glance?.locked
              ? <span className="shrink-0 text-text-muted" title={t("profileSwitcher.locked")} data-testid="profile-switcher-locked"><LockIcon /></span>
              : unread > 0 && <span data-testid="profile-switcher-unread" aria-hidden="true" className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-accent text-[11px] font-bold leading-5 text-center text-[#111b21] tabular-nums">{unread > 99 ? "99+" : unread}</span>}
          </button>
        );
      })}

      <div role="none" className="my-1 border-t border-border" />
      <button type="button" role="menuitem" data-testid="profile-switcher-add" onClick={() => go("/profile", { newProfile: true })} className={`${itemClass} min-h-11 py-1.5 text-sm text-text-secondary`}>
        <span aria-hidden="true" className="grid place-items-center w-8 h-8 shrink-0 rounded-full border border-dashed border-border-bright text-lg leading-none">+</span>
        {t("profileSwitcher.add")}
      </button>
      <button type="button" role="menuitem" data-testid="profile-switcher-manage" onClick={() => go("/profile")} className={`${itemClass} min-h-11 py-1.5 text-sm text-text-secondary`}>
        <span aria-hidden="true" className="grid place-items-center w-8 h-8 shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M19 8v6M16 11h6" /></svg>
        </span>
        {t("profileSwitcher.manage")}
      </button>
    </div>
  );

  if (variant === "popover") return menu;
  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-black/40" data-testid="profile-switcher-backdrop" />
      {menu}
    </>
  );
}
