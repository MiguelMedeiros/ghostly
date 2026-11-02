import { useEffect } from "react";
import { clearNotification, showPrivateNotification } from "../lib/notifications";
import { loadSettings } from "../lib/settings";
import { appAway } from "../lib/appInSight";
import { windowAway } from "../lib/windowAway";

/**
 * A call that rings while the app is out of sight says so with a system notification, as a new message does
 * (Settings → Notifications): its ring alone is easy to miss, and a tab whose sound was never started by a click plays
 * nothing at all. Private like every notice (no name), once per ring: at once, or when the app goes out of sight while
 * it still rings. A click opens the chat, where the call is answered. The notification goes when the ring ends
 * (answered, declined, or given up by the caller), where the app can take one back: it would say a call is coming in
 * long after.
 */
export function useIncomingCallNotice(ringing: boolean, chat: string, body: string): void {
  useEffect(() => {
    if (!ringing) return;
    let told: { event: string; shown: Promise<void> } | undefined;
    let over = false;
    let asking = false;
    const tell = () => {
      if (told || asking || !windowAway() || !loadSettings().notifications.systemEnabled) return;
      // Not while another page of the app is in sight (an extension tab in front): the call rings there too, before the
      // person's eyes. That page tells once it goes out of sight itself.
      asking = true;
      void appAway().then((away) => {
        asking = false;
        if (!away || told || over) return;
        const event = `call:${chat}:${Date.now()}`;
        told = { event, shown: showPrivateNotification(event, body, chat) };
      });
    };
    tell();
    document.addEventListener("visibilitychange", tell);
    window.addEventListener("blur", tell);
    return () => {
      document.removeEventListener("visibilitychange", tell);
      window.removeEventListener("blur", tell);
      over = true;
      // Once it is shown: a ring that ended at once would otherwise leave the notification it was about to post.
      const { event, shown } = told ?? {};
      if (event) void shown?.then(() => clearNotification(event));
    };
  }, [ringing, chat, body]);
}
