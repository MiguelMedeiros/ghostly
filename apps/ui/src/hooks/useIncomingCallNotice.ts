import { useEffect } from "react";
import { showPrivateNotification } from "../lib/notifications";
import { loadSettings } from "../lib/settings";

/** The app is out of sight: another tab or window is in front, or the app is behind another one. */
const away = () => document.visibilityState === "hidden" || !document.hasFocus();

/**
 * A call that rings while the app is out of sight says so with a system notification, as a new message does
 * (Settings → Notifications): its ring alone is easy to miss, and a tab whose sound was never started by a click plays
 * nothing at all. Private like every notice (no name), once per ring: at once, or when the app goes out of sight while
 * it still rings. A click opens the chat, where the call is answered.
 */
export function useIncomingCallNotice(ringing: boolean, chat: string, body: string): void {
  useEffect(() => {
    if (!ringing) return;
    let told = false;
    const tell = () => {
      if (told || !away() || !loadSettings().notifications.systemEnabled) return;
      told = true;
      void showPrivateNotification(`call:${chat}:${Date.now()}`, body, chat);
    };
    tell();
    document.addEventListener("visibilitychange", tell);
    window.addEventListener("blur", tell);
    return () => {
      document.removeEventListener("visibilitychange", tell);
      window.removeEventListener("blur", tell);
    };
  }, [ringing, chat, body]);
}
