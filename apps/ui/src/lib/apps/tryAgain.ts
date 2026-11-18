import { useState } from "react";

/**
 * Try again on a read that failed (the installed apps, the stores): busy while the read is on its way, and each read
 * that ends counted, so the line that says why can be keyed on it. One that fails again is then a new alert, read out
 * again: the same words left in place say nothing to a screen reader, and nothing on screen would have changed.
 */
export function useTryAgain(read: () => Promise<unknown>): { busy: boolean; tries: number; again: () => void } {
  const [busy, setBusy] = useState(false);
  const [tries, setTries] = useState(0);
  const again = () => {
    setBusy(true);
    void read().catch(() => {}).finally(() => { setBusy(false); setTries((n) => n + 1); });
  };
  return { busy, tries, again };
}
