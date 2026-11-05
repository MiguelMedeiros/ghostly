import { useEffect } from "react";
import { focusLost } from "../lib/focus";

/**
 * A control that went with what it did (a form's Share or Cancel once the form closes, a row's Remove once the row
 * goes) leaves the focus on the page, where a screen reader loses its place. Once `selector` matches something after a
 * draw (a row just added can come a draw after the form closed), `onLanded` runs and that element gets the focus,
 * unless the person put it somewhere else meanwhile. `onLanded` clears what gave `selector`.
 */
export function useFocusLanding(selector: string | null, onLanded: () => void): void {
  useEffect(() => {
    if (!selector) return;
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    onLanded();
    if (focusLost()) el.focus({ preventScroll: true });
  });
}
