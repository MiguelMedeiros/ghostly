import { useEffect, useRef, type RefObject } from "react";

/** Where a right-click asked for a menu, in the window: the menu opens there (Menu's `at`). */
export type MenuPoint = { x: number; y: number };

/** What keeps the webview's own menu, for its Copy, Paste and Copy Link: a field, a link. */
const NATIVE = "input, textarea, select, [contenteditable]:not([contenteditable=false]), a[href]";

/** How the last press began (a mouse, a finger, a pen), and whether it was on chosen text: read by the menu it asks for. */
let press: { touch: boolean; target: EventTarget | null; selected: boolean } | undefined;
let watching = false;

/** Notes how each press begins, once for the page, before anything under it hears the press. */
function watchPresses() {
  if (watching) return;
  watching = true;
  window.addEventListener("pointerdown", (e) => {
    // Any button: a Control-click on a Mac asks for the menu with the main one.
    press = { touch: e.pointerType !== "mouse", target: e.target, selected: onSelection(e.target) };
  }, true);
}

const onSelection = (target: EventTarget | null) => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !(target instanceof Node)) return false;
  return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)).some(range => range.intersectsNode(target));
};

/**
 * Whether a right-click (a `contextmenu`) is the webview's to answer: on a field or a link, on chosen text (the webview's
 * menu has Copy for it), or from a finger or a pen, whose long press stays as it was (a message's long press opens its
 * quick bar, MessageBubble's useLongPress). Chosen text counts when it was there before the press and still is: a right
 * press on a word chooses it in WKWebView, which is not a choice, and WebKitGTK lets go of the choice under a right press
 * before asking, so its menu would have no Copy, only Back and Reload.
 */
export function keepsNativeMenu(e: MouseEvent): boolean {
  const on = e.target instanceof Element ? e.target : null;
  if (on?.closest(NATIVE)) return true;
  const kind = (e as PointerEvent).pointerType;
  if (kind ? kind !== "mouse" : press?.touch) return true;
  return (press?.target !== e.target || press.selected) && onSelection(e.target);
}

/**
 * The webview's own menu (Back, Forward, Stop, Reload, on Linux, macOS and Windows) never shows in the desktop app:
 * where nothing in the app answered a right-click, it is refused, but for a field, a link or chosen text
 * (keepsNativeMenu). In a browser (`suppress` false) the browser's menu stays where the app has none.
 */
export function guardContextMenu({ suppress }: { suppress: boolean }, target: Window = window): () => void {
  watchPresses();
  if (!suppress) return () => {};
  const menu = (e: MouseEvent) => { if (!e.defaultPrevented && !keepsNativeMenu(e)) e.preventDefault(); };
  target.addEventListener("contextmenu", menu);
  return () => target.removeEventListener("contextmenu", menu);
}

/**
 * A right-click on the item `ref` is in (its closest `owner`, a message's row) opens the item's own ⋮ menu at the
 * pointer, in place of the webview's: `open` gets the point. A right-click on an item inside it with a menu of its own,
 * or one the webview keeps (keepsNativeMenu), is left alone.
 */
export function useContextMenu(ref: RefObject<HTMLElement | null>, owner: string, open: (at: MenuPoint) => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    watchPresses();
    const item = ref.current?.closest<HTMLElement>(owner);
    if (!item) return;
    const menu = (e: MouseEvent) => {
      if (e.defaultPrevented || keepsNativeMenu(e) || (e.target as Element).closest(owner) !== item) return;
      e.preventDefault();
      latest.current({ x: e.clientX, y: e.clientY });
    };
    item.addEventListener("contextmenu", menu);
    return () => item.removeEventListener("contextmenu", menu);
  }, [ref, owner]);
}
