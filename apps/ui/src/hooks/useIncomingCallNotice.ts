import { useEffect, useRef } from "react";
import { RING_MS } from "@ghostly/react";
import { claimFeedback } from "../lib/feedbackClaims";
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
 *
 * `ring` names the ring on every page of the engine (its offer's time): the extension's tabs ring for the same call, and
 * with none in sight, only the first of them to tell posts it.
 */
export function useIncomingCallNotice(ringing: boolean, chat: string, body: string, ring?: number): void {
  const ringRef = useRef(ring);
  ringRef.current = ring;
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
      const post = async () => {
        const away = await appAway();
        if (!away || told || over) return;
        // Claimed for as long as the call can ring: a tab that goes out of sight later still finds it told.
        const id = ringRef.current;
        if (id !== undefined && !claimFeedback(`call:${chat}:${id}`, Date.now() + RING_MS)) return;
        const event = `call:${chat}:${Date.now()}`;
        told = { event, shown: showPrivateNotification(event, body, chat) };
      };
      // Under the lock the messages' claims take (AttentionFeedback): two tabs that tell at once post one notice.
      void (navigator.locks ? navigator.locks.request("ghostly-feedback", post) : post()).finally(() => { asking = false; });
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
