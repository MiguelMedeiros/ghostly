/**
 * Whether the Apps feature shows (WISP 1200). While it does not, nothing of it shows: no page, no place in the bar, no
 * composer entry, no app card (a card reads as its text, as in an older app), and no request at all.
 *
 * The rule is one function, `appsAvailable`, so a later rule (a browser apps are hidden or limited on) is added there
 * and every screen follows. The screens ask it through `useAppsState` / `useAppsAvailable`.
 */
import { useEffect, useState } from "react";
import { APPS_ENABLED } from "@ghostly/browser/shared/features";
import { servicesPlatform } from "../platform";
import { useAppOpener, type AppOpener } from "./open";
import { runnerAvailable } from "./runnerCheck";

/** The feature is on in this build: `APPS_ENABLED`, or the e2e suite's build (`VITE_APPS_TEST=1`, fixed at build time). */
export function appsEnabled(): boolean {
  return APPS_ENABLED || import.meta.env?.VITE_APPS_TEST === "1";
}

export type AppsState = "on" | "off" | "checking";

/** What the rule reads. */
export interface AppsFacts {
  /** The feature is on in this build (`appsEnabled`). */
  enabled: boolean;
  /** Where this client frames apps (`platform.apps.runnerUrl`), or null where it runs none (the extension, for now). */
  runner: string | null;
  /** An opener is registered (`setAppOpener`). */
  opener: AppOpener | null;
  /** This server sends the runner's policy as a header: undefined while it is being asked. */
  runnerPolicy: boolean | undefined;
}

/**
 * The one rule. Apps shows when the feature is on in this build, this client runs apps and registered how, and this
 * server sends the runner's policy as a header (a self-hosted server without it gets no apps). `checking` while only
 * the header check is still out. Extend here: every screen follows.
 */
export function appsAvailable(facts: AppsFacts): AppsState {
  if (!facts.enabled || !facts.runner || !facts.opener) return "off";
  if (facts.runnerPolicy === undefined) return "checking";
  return facts.runnerPolicy ? "on" : "off";
}

/** What the runner check answered, per runner page: later screens know at once. */
const answered = new Map<string, boolean>();

/** For tests: ask again. */
export function forgetAppsAvailable(): void {
  answered.clear();
}

/** `appsAvailable` for this client now, asking the runner page once when the rest already holds. */
export function useAppsState(): AppsState {
  const enabled = appsEnabled();
  // Read, not subscribed to: where apps run depends on the host, not on the engine's state, and every message bubble
  // asks (a subscription would draw each of them again on every change of state).
  const runner = servicesPlatform?.apps?.runnerUrl ?? null;
  // Desktop serves its runner itself, with the policy: there is no server to ask.
  const served = servicesPlatform?.apps?.runnerServed === true;
  const opener = useAppOpener();
  const ask = enabled && opener && !served ? runner : null;
  const [, setChecked] = useState(0);
  useEffect(() => {
    if (!ask || answered.has(ask)) return;
    let live = true;
    void runnerAvailable(ask).then((ok) => { answered.set(ask, ok); if (live) setChecked((n) => n + 1); });
    return () => { live = false; };
  }, [ask]);
  return appsAvailable({ enabled, runner, opener, runnerPolicy: served || (runner ? answered.get(runner) : undefined) });
}

/** Whether Apps shows here now. False until the runner check has answered. */
export function useAppsAvailable(): boolean {
  return useAppsState() === "on";
}

/**
 * The web app in a WebKit browser (Safari on macOS, and every browser on iOS and iPadOS): Apps is there, but an app's
 * frame can still open a connection to another server (WebKit's `<link rel=preconnect>` ignores the runner's policy,
 * WISP 1200 § Per client), so the install screen says so. Not Desktop: its app windows block that with a content rule
 * list. Chromium and Firefox name WebKit in their user agent too, so they are told apart by their own names.
 */
export function webKitAppLeak(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent, desktop: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window): boolean {
  if (desktop || !/AppleWebKit\//.test(userAgent)) return false;
  // On iOS and iPadOS every browser is WebKit, whatever it calls itself.
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  return !/\b(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|Firefox|FxiOS|SamsungBrowser|Android)\b/.test(userAgent);
}
