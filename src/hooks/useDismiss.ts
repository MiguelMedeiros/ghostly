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

/**
 * A modal made of plain elements: focus moves into it when it opens (so keys reach it even when what
 * opened it is gone), Escape anywhere closes it, and focus goes back where it was on close.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const callback = useRef(onClose); callback.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); callback.current(); } };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (before?.isConnected) before.focus(); };
  }, [ref]);
}
