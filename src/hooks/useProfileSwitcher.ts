import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { profileGlance, type ProfileGlance } from "../lib/profileData";
import { currentProfile, listProfiles, type ProfileEntry } from "../lib/profiles";

/**
 * The account switcher (WISP 04): the profiles saved on this device, one tap from any of them, like the
 * account switcher of other social apps. The Profile page stays where profiles are made and managed.
 */

const OPEN_EVENT = "open-profile-switcher";
/** Opens the switcher of whichever place holds it now: the account bar on a wide screen, the tab bar on a phone. */
export function openProfileSwitcher(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Alt+Shift+P (⌥⇧P): Ctrl/Cmd+Shift+P is Firefox's private window and cannot be taken from it. */
export const SWITCHER_SHORTCUT = "Alt+Shift+P";
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const shortcutLabel = () => (isMac() ? "⌥⇧P" : SWITCHER_SHORTCUT);
const isShortcut = (e: globalThis.KeyboardEvent) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyP";

export interface OtherProfile { entry: ProfileEntry; glance?: ProfileGlance }

/**
 * The active profile and the others with what can be known of them without starting them (their picture,
 * unread messages left in them, whether they are locked). Re-read when profiles or chats change.
 */
export function useProfileGlances(): { current: ProfileEntry; others: OtherProfile[]; othersUnread: number } {
  const [state, setState] = useState(() => ({ current: currentProfile(), others: listProfiles().filter((p) => p.id !== currentProfile().id).map((entry) => ({ entry }) as OtherProfile) }));
  useEffect(() => {
    let alive = true;
    const load = () => {
      const current = currentProfile();
      const entries = listProfiles().filter((p) => p.id !== current.id);
      setState((old) => ({ current, others: entries.map((entry) => ({ entry, glance: old.others.find((o) => o.entry.id === entry.id)?.glance })) }));
      void Promise.all(entries.map(async (entry) => ({ entry, glance: await profileGlance(entry.id).catch(() => undefined) })))
        .then((others) => { if (alive) setState({ current, others }); });
    };
    load();
    const events = ["profiles-updated", "settings-updated", "storage"];
    for (const name of events) window.addEventListener(name, load);
    return () => { alive = false; for (const name of events) window.removeEventListener(name, load); };
  }, []);
  const othersUnread = state.others.reduce((sum, o) => sum + (o.glance?.unread ?? 0), 0);
  return { ...state, othersUnread };
}

/**
 * Open/closed state of a switcher, opened by `openProfileSwitcher()` and by the keyboard shortcut. Only
 * one place holds it at a time (the account bar and the tab bar are never on screen together).
 */
export function useProfileSwitcher(available: boolean) {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const show = useCallback(() => {
    if (!available) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, [available]);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) returnFocus.current?.focus();
  }, []);
  useEffect(() => {
    if (!available) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      setOpen((was) => { if (!was) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; return !was; });
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener(OPEN_EVENT, show); window.removeEventListener("keydown", onKey); };
  }, [available, show]);
  return { open, show, close, toggle: () => (open ? close() : show()) };
}

/**
 * A press held for about half a second (touch or pen), and a right-click: the same as the switcher's
 * chevron. The tap that ends a long press does not also count as a tap.
 */
export function useLongPress(onLongPress: () => void, ms = 480) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pressing = useRef(false), fired = useRef(false), origin = useRef({ x: 0, y: 0 });
  const cancel = () => { clearTimeout(timer.current); pressing.current = false; };
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === "mouse") return;
      fired.current = false; pressing.current = true; origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => { pressing.current = false; fired.current = true; navigator.vibrate?.(10); onLongPress(); }, ms);
    },
    onPointerMove: (e: ReactPointerEvent) => { if (pressing.current && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 10) cancel(); },
    onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      if (fired.current) return;
      // A right-click, or a phone's own long-press menu arriving before the timer.
      if (pressing.current) { cancel(); fired.current = true; }
      onLongPress();
    },
    onClickCapture: (e: ReactMouseEvent) => { if (fired.current) { fired.current = false; e.preventDefault(); e.stopPropagation(); } },
  };
}
