import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { hasPublicProfile } from "@ghostly/browser/profiles/readers";
import { isGood, type Badge } from "./contactBadges";

/* When a contact's identity marks open their card (IdentityTip.tsx), in the chat list and in the chat's header. */

/** How long the pointer rests on a mark before its card opens; moving to the next mark while one is open is at once. */
export const TIP_HOVER_DELAY = 300;
/** A touch held this long is a long press: the card, not the chat. */
export const TIP_LONG_PRESS = 450;
/** How long a long press's card stays up. */
const TIP_TOUCH_SHOW = 3000;

/** Every mark at once (keyboard focus, the "+N" chip), rather than one. */
export const ALL_MARKS = "*";

export interface TipAt { key: string; top?: number; bottom?: number; left: number }

/** Where a card goes: under its mark, or over it near the bottom of the window, kept on screen. */
function tipAt(el: Element, key: string): TipAt {
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left + r.width / 2 - 140, window.innerWidth - 288));
  return r.bottom + 200 > window.innerHeight && r.top > 200 ? { key, bottom: window.innerHeight - r.top + 6, left } : { key, top: r.bottom + 6, left };
}

/** Whether focus came from the keyboard; a click's focus opens nothing. jsdom and older engines count as keyboard. */
const keyboardFocus = (el: Element) => { try { return el.matches(":focus-visible"); } catch { return true; } };

/**
 * The open/close logic of a mark's card. `onShow` is told which key opened (a mark's `data-badge`, or ALL_MARKS).
 * Spread `handlers(...)` on the element holding the marks; `swallow` on its click says whether a long press just
 * ended there (the click is then eaten, so a row or a header never opens under it).
 */
export function useMarkTip(onShow: (key: string) => void) {
  const [tip, setTip] = useState<TipAt | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean }>({ held: false });
  const shown = useRef(onShow);
  shown.current = onShow;
  const open = useRef(false);
  open.current = !!tip;
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(press.current.timer); }, []);
  const showNow = (key: string, el: Element) => { clearTimeout(timer.current); setTip(tipAt(el, key)); shown.current(key); };
  const hide = () => { clearTimeout(timer.current); setTip(null); };
  const markOf = (target: EventTarget, holder: Element) => (target as Element).closest?.<HTMLElement>("[data-badge]") ?? holder;
  const keyOf = (el: Element) => (el as HTMLElement).dataset?.badge ?? ALL_MARKS;
  return {
    tip,
    hide,
    /** Eats the click that ends a long press. */
    swallow(e: MouseEvent) {
      if (!press.current.held) return false;
      press.current.held = false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    handlers: {
      onPointerOver(e: PointerEvent<HTMLElement>) {
        if (e.pointerType !== "mouse") return;
        const el = markOf(e.target, e.currentTarget);
        if (open.current) { showNow(keyOf(el), el); return; }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => showNow(keyOf(el), el), TIP_HOVER_DELAY);
      },
      onPointerLeave(e: PointerEvent<HTMLElement>) { if (e.pointerType === "mouse") hide(); },
      onPointerDown(e: PointerEvent<HTMLElement>) {
        if (e.pointerType === "mouse") return;
        const el = markOf(e.target, e.currentTarget);
        press.current.held = false;
        clearTimeout(press.current.timer);
        press.current.timer = setTimeout(() => {
          press.current.held = true;
          showNow(keyOf(el), el);
          timer.current = setTimeout(() => setTip(null), TIP_TOUCH_SHOW);
        }, TIP_LONG_PRESS);
      },
      onPointerUp() { clearTimeout(press.current.timer); },
      // A touch that scrolls the list is no long press.
      onPointerCancel() { clearTimeout(press.current.timer); },
      onContextMenu(e: MouseEvent) { if (press.current.held) e.preventDefault(); },
      onFocus(e: FocusEvent<HTMLElement>) { if (e.target === e.currentTarget && keyboardFocus(e.currentTarget)) showNow(ALL_MARKS, e.currentTarget); },
      onBlur() { hide(); },
      onKeyDown(e: KeyboardEvent) { if (e.key === "Escape" && open.current) { e.stopPropagation(); hide(); } },
    },
  };
}

/** A shown identity's profile is a card on screen: asked for, the way the ID cards ask (the engine caches it). */
export function loadShownProfiles(badges: Badge[]): void {
  for (const b of badges) {
    if (isGood(b.state) && hasPublicProfile(b.provider))
      void engine.call("loadPublicProfile", { provider: b.provider, subject: b.subject }).catch(() => {});
  }
}

