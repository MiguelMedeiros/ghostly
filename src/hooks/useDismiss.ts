import {useEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent} from "react";

const layers: RefObject<HTMLElement | null>[] = [];

/** Require both ends of the gesture outside, so dragging out never dismisses. */
export function useBackdropDismiss(onClose: () => void) {
  const beganOutside = useRef(false);
  const outside = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return false;
    if (e.currentTarget.tagName !== "DIALOG") return true;
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => { beganOutside.current = outside(e); },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => { if (beganOutside.current && outside(e)) onClose(); beganOutside.current = false; },
    onPointerCancel: () => { beganOutside.current = false; },
  };
}

export function useOutsideDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, anchorRef?: RefObject<HTMLElement | null>) {
  const callback = useRef(onClose); callback.current = onClose;
  useEffect(() => {
    if (!open) return;
    layers.push(ref);
    const topLayer = () => {
      const leaves=layers.filter(r=>r.current && !layers.some(other=>other!==r && other.current && r.current!.contains(other.current)));
      return leaves[leaves.length - 1]===ref;
    };
    let beganOutside = false;
    // By the event's path, not by what holds its target now: a click that swaps what it landed on (a card turning
    // over, a step back to the deck) leaves that target detached before this runs, and it was still inside.
    const outside = (e: PointerEvent) => { const path = e.composedPath(); return !!ref.current && !path.includes(ref.current) && !(anchorRef?.current && path.includes(anchorRef.current)); };
    const blocked = () => !topLayer() || !!document.querySelector("dialog[open]");
    const down = (e: PointerEvent) => { beganOutside = !blocked() && outside(e); };
    const up = (e: PointerEvent) => { if (beganOutside && !blocked() && outside(e)) callback.current(); beganOutside = false; };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !blocked() && !e.defaultPrevented) callback.current(); };
    document.addEventListener("pointerdown", down); document.addEventListener("pointerup", up); document.addEventListener("keydown", key);
    return () => {const index=layers.indexOf(ref); if(index>=0) layers.splice(index,1);document.removeEventListener("pointerdown", down);document.removeEventListener("pointerup", up);document.removeEventListener("keydown", key);};
  }, [open, ref, anchorRef]);
}

/** The open modals made of plain elements, the newest last: only the newest answers Escape and keeps Tab inside it. */
const modals: RefObject<HTMLElement | null>[] = [];

/** What Tab can reach inside `root`, in order: enabled, shown, not taken out with tabindex="-1". */
function tabbables(root: HTMLElement): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]');
  return [...all].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && !el.closest("[inert], [hidden]") && (el.checkVisibility?.() ?? true));
}

/**
 * A modal made of plain elements: focus moves into it when it opens (so keys reach it even when what
 * opened it is gone), Tab and Shift+Tab go round its own controls and never to the page behind it, Escape anywhere
 * closes it, and focus goes back where it was on close, unless `restore` says no (what it made takes the focus instead).
 * A layer of its own that holds the focus (a select's list, a menu drawn over the page) keeps its Tab.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, restore: () => boolean = () => true) {
  const callback = useRef(onClose); callback.current = onClose;
  const restoring = useRef(restore); restoring.current = restore;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
    modals.push(ref);
    const key = (e: KeyboardEvent) => {
      // Over another one, the newest answers: Escape closes it alone, Tab stays in it.
      if (modals[modals.length - 1] !== ref) return;
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); callback.current(); return; }
      keepTabInside(e, ref.current);
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      const at = modals.lastIndexOf(ref);
      if (at >= 0) modals.splice(at, 1);
      if (before?.isConnected && restoring.current()) before.focus();
    };
  }, [ref]);
}

/**
 * Tab only, for a modal that moves the focus and answers Escape its own way (the message details panel): Tab and
 * Shift+Tab go round its own controls and never to the page behind it. Over other open modals, the newest keeps Tab.
 */
export function useTabTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    modals.push(ref);
    const key = (e: KeyboardEvent) => { if (modals[modals.length - 1] === ref) keepTabInside(e, ref.current); };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      const at = modals.lastIndexOf(ref);
      if (at >= 0) modals.splice(at, 1);
    };
  }, [ref]);
}

/**
 * Tab and Shift+Tab go round `root`'s own controls, and a Tab from the page's body goes into it. Focus in a layer of
 * its own (a select's list, a menu drawn over the page) keeps its Tab.
 */
function keepTabInside(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || e.defaultPrevented || !root) return;
  const active = document.activeElement;
  const inside = !!active && root.contains(active);
  if (!inside && active && active !== document.body) return;
  const stops = tabbables(root);
  if (!stops.length) { e.preventDefault(); root.focus(); return; }
  const first = stops[0], last = stops[stops.length - 1];
  if (!inside || active === root) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
