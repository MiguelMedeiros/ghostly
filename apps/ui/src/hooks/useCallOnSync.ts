import { useEffect, useSyncExternalStore } from "react";
import { callHoldsDevice, subscribeCalls } from "@ghostly/react";
import { engine } from "@ghostly/browser/platform/engine";

/**
 * Tells the engine whether a call is on in this page (placed, answered or ringing in, until it ends): while one is, the
 * device answers a handoff with "A call is on. Try again after it." instead of moving the profile and cutting or losing
 * the call (WISP 06 § States and events). The calls live in the page; the handoff in the engine.
 */
export function useCallOnSync(): void {
  const on = useSyncExternalStore(subscribeCalls, callHoldsDevice, () => false);
  useEffect(() => {
    void engine.call("setCallOn", { on }).catch(() => {});
  }, [on]);
}
