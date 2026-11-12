import { useEffect } from "react";
import { isAltLetterKey } from "../lib/appCommands";
import { modalOpen } from "./useAppCommands";

/** Alt+Shift+L (⌥⇧L), as the profile switcher's Alt+Shift+P: the browsers keep Ctrl/Cmd+Shift for their own. */
export const RAIL_SHORTCUT = "Alt+Shift+L";
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const railShortcutLabel = () => (isMac() ? "⌥⇧L" : RAIL_SHORTCUT);
// The key that types L, as Ctrl+N's (appCommands.ts): on Dvorak the key at a US keyboard's L types N, and L's is P's.
const isShortcut = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && isAltLetterKey(e, "l");

/**
 * The shortcut folds the chat list to its rail or unfolds it (ChatRail.tsx) wherever the focus is, while there is a side
 * list (`enabled`). Not behind a modal dialog or the lock screen: the button a dialog gives the focus back to would go.
 */
export function useRailShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e) || modalOpen()) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toggle]);
}
