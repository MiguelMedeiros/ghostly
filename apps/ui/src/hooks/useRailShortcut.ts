import { useEffect } from "react";

/** Alt+Shift+L (⌥⇧L), as the profile switcher's Alt+Shift+P: the browsers keep Ctrl/Cmd+Shift for their own. */
export const RAIL_SHORTCUT = "Alt+Shift+L";
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const railShortcutLabel = () => (isMac() ? "⌥⇧L" : RAIL_SHORTCUT);
const isShortcut = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyL";

/** The shortcut folds the chat list to its rail or unfolds it (ChatRail.tsx) wherever the focus is, while there is a side list (`enabled`). */
export function useRailShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, toggle]);
}
