import { useCallback, useEffect, useState } from "react";
import { WAKE_CALL_WAIT_MS } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";

/**
 * Calling a contact whose app is closed (WISP 401 § Wake-up push, calls): the call buttons stay usable when the
 * contact shared how to wake its app. Pressing one sends a "call" wake-up (its app shows "Incoming call"), then waits
 * for the chat to go live and places the call; the contact's app rings as for any call. It gives up after
 * `WAKE_CALL_WAIT_MS`, or when the person cancels.
 */
export function useWakeCall(linkId: string | undefined, callsPossible: boolean, place: (withVideo: boolean) => void) {
  const [waking, setWaking] = useState<{ video: boolean; until: number } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const ring = useCallback(async (withVideo: boolean) => {
    if (!linkId) return;
    setGaveUp(false);
    const woken = await engine.call("wakeForCall", { linkId }).catch(() => false);
    if (woken) setWaking({ video: withVideo, until: Date.now() + WAKE_CALL_WAIT_MS });
    else setGaveUp(true);
  }, [linkId]);

  const cancel = useCallback(() => setWaking(null), []);

  // The contact's app is live: the call goes now, while it still shows the wake-up.
  useEffect(() => {
    if (!waking || !callsPossible) return;
    setWaking(null);
    place(waking.video);
  }, [waking, callsPossible, place]);

  useEffect(() => {
    if (!waking) return;
    const timer = setTimeout(() => { setWaking(null); setGaveUp(true); }, Math.max(0, waking.until - Date.now()));
    return () => clearTimeout(timer);
  }, [waking]);

  useEffect(() => {
    if (!gaveUp) return;
    const timer = setTimeout(() => setGaveUp(false), 6000);
    return () => clearTimeout(timer);
  }, [gaveUp]);

  return { waking: !!waking, gaveUp, ring, cancel };
}
