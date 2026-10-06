/**
 * Whether the Apps feature shows (WISP 1200). Three things must hold, and while one does not, nothing of it shows: no
 * page, no place in the bar, no composer entry, no app card (a card reads as its text, as in an older app), and no
 * request at all:
 * - the feature is on in this build: `APPS_ENABLED`, or the e2e suite's build (`VITE_APPS_TEST=1`, fixed when the
 *   build is made, never at runtime);
 * - this client runs apps (`platform.apps`: the web app; the extension has none yet) and registered how (`openApp`);
 * - this server sends the runner's policy as a header (`runnerAvailable`, asked once of the runner page itself): a
 *   self-hosted server without it gets no apps.
 */
import { useEffect, useState } from "react";
import { APPS_ENABLED } from "@ghostly/browser/shared/features";
import { servicesPlatform } from "../platform";
import { useAppOpener } from "./open";
import { runnerAvailable } from "./runnerCheck";

/** The feature is on in this build. */
export function appsEnabled(): boolean {
  return APPS_ENABLED || import.meta.env?.VITE_APPS_TEST === "1";
}

/** What the runner check answered, per runner page: later screens know at once. */
const answered = new Map<string, boolean>();

/** For tests: ask again. */
export function forgetAppsAvailable(): void {
  answered.clear();
}

/** Whether Apps shows here now. False until the runner check has answered. */
export function useAppsAvailable(): boolean {
  return useAppsState() === "on";
}

/** `checking` while the runner check has not answered (a page waits, rather than sending the person away). */
export function useAppsState(): "on" | "off" | "checking" {
  const enabled = appsEnabled();
  // Read, not subscribed to: where apps run depends on the host, not on the engine's state, and every message bubble
  // asks (a subscription would draw each of them again on every change of state).
  const apps = servicesPlatform?.apps;
  const opener = useAppOpener();
  const runner = enabled && apps && opener ? apps.runnerUrl : null;
  const [, setChecked] = useState(0);
  useEffect(() => {
    if (!runner || answered.has(runner)) return;
    let live = true;
    void runnerAvailable(runner).then((ok) => { answered.set(runner, ok); if (live) setChecked((n) => n + 1); });
    return () => { live = false; };
  }, [runner]);
  if (!runner) return "off";
  const ok = answered.get(runner);
  return ok === undefined ? "checking" : ok ? "on" : "off";
}
