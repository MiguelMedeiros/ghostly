import { useEffect } from "react";

interface Sentinel { released: boolean; release(): Promise<void> }
interface WakeLockNavigator { wakeLock?: { request(type: "screen"): Promise<Sentinel> } }

/**
 * Keeps the screen on while `active` (a call): a phone that dims and locks mid-call would drop the video and,
 * in a browser, may suspend the page. The system lets go of the lock whenever the page is hidden, so it is
 * asked for again each time the page comes back. Where there is no Screen Wake Lock, nothing happens.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const api = (navigator as WakeLockNavigator).wakeLock;
    if (!active || !api) return;
    let sentinel: Sentinel | null = null;
    let stopped = false;
    const acquire = () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      api.request("screen").then((lock) => {
        if (stopped) void lock.release().catch(() => {});
        else sentinel = lock;
      }, () => { /* refused (battery saver, no permission): the screen dims as usual */ });
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}
