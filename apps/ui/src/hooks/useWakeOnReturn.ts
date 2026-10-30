import { useEffect } from "react";
import { engine } from "@ghostly/browser/platform/engine";

/** How often the page checks that its own clock did not jump (a sleep stops every timer). */
export const WAKE_TICK_MS = 5_000;
/** A tick this much later than set means the computer slept, even with no event from the window. */
export const SLEPT_LATE_MS = 30_000;

/**
 * Coming back to the window or tab after a while: a laptop that slept, an app left in the background.
 * Chats look for their contacts now, and a connection that dropped meanwhile is dialled again at once.
 * A sleep the window says nothing about (it kept the focus and stayed visible) shows as a tick that fires far
 * later than set: that is a return too.
 */
export function useWakeOnReturn(): void {
  useEffect(() => {
    let last = 0;
    const wake = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 5_000) return;
      last = Date.now();
      void engine.call("wake").catch(() => {});
    };
    // Back online (another network, a VPN up or down): discovery forgets the relays that failed on the old one.
    const online = () => { last = Date.now(); void engine.call("wake", { network: true }).catch(() => {}); };
    let ticked = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      if (now - ticked > WAKE_TICK_MS + SLEPT_LATE_MS) wake();
      ticked = now;
    }, WAKE_TICK_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", online);
    return () => { clearInterval(tick); document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); window.removeEventListener("online", online); };
  }, []);
}
