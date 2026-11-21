import { useEffect, useState } from "react";

/**
 * How long a connection's state must hold before a live region says it. Back on Automatic over Iroh's relay, a chat
 * moves to a direct transport in 0.25 s between two browsers, about 1 s in the core's restart harness (WISP 100); a
 * link that flaps (a Wi-Fi to mobile handover, the contact's app reloading) drops and comes back within seconds.
 */
export const SAID_QUIET_MS = 3_000;

/**
 * What a polite live region says of a state that comes and goes (a connection's label): its words once they held for
 * `SAID_QUIET_MS`. A link that flaps is said where it settles, once, and a flap that ends where it started says
 * nothing: the words are back to what was last said. Only what is said waits; what is shown follows the state at once.
 *
 * `atOnce` takes the words now: a trouble the person must hear without delay (offline, a connection issue), or a
 * region muted meanwhile, which says nothing anyway. The way back from it waits like any other change, so a trouble
 * that flaps is said once, not at every return.
 */
export function useSaidSettled(words: string, atOnce: boolean): string {
  const [said, setSaid] = useState(words);
  if (atOnce && said !== words) setSaid(words);
  useEffect(() => {
    if (said === words) return;
    const timer = window.setTimeout(() => setSaid(words), SAID_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [words, said]);
  return said;
}
