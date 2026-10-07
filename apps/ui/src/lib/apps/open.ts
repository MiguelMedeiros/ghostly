/**
 * Opening an installed mini-app (WISP 1200): the screens ask `openApp`, and the client that can run apps registers how
 * (`setAppOpener`: the web app's runner and broker, `webOpener.ts`). Where none is registered, apps cannot run here.
 */
import { useSyncExternalStore } from "react";
import type { Translate } from "../../locales/translate";

/** How to open it. `runAnyway`: the person chose "Run anyway" for a version a store of theirs removed (never a revoked one). */
export interface OpenAppOptions { runAnyway?: boolean }

/** Opens `ref` in the 1:1 chat `linkId`, or alone when it is null. Rejects when it cannot start (revoked, removed, no runner…). */
export type AppOpener = (ref: string, linkId: string | null, options?: OpenAppOptions) => Promise<void>;

let opener: AppOpener | null = null;
const listeners = new Set<() => void>();

export function setAppOpener(next: AppOpener | null): void {
  opener = next;
  for (const listener of [...listeners]) listener();
}

export function openApp(ref: string, linkId: string | null = null, options: OpenAppOptions = {}): Promise<void> {
  return opener ? opener(ref, linkId, options) : Promise.reject(new Error("Apps cannot run in this app"));
}

/** The registered opener, or null where apps cannot run (a screen hides what would open one). */
export function useAppOpener(): AppOpener | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => opener, () => opener);
}

/** Why the client stopped a running app (WISP 1200 § Takedowns): its publisher revoked the version, or a store removed it. */
export type AppTakedown = { why: "revoked" } | { why: "removed"; store: string };

/** "Chess was stopped: its maker revoked this version", where the app ran. */
export function takedownText(title: string, takedown: AppTakedown, t: Translate): string {
  return takedown.why === "revoked" ? t("apps.view.stoppedRevoked", { title }) : t("apps.view.stoppedRemoved", { title, store: takedown.store });
}

/** An app running now, as its opener registered it: its ref, whether the person chose Run anyway, and how to stop it. */
export interface RunningAppEntry {
  ref: string;
  runAnyway: boolean;
  /** Stops the app and says why where it ran. */
  takeDown(takedown: AppTakedown): void;
}

const running = new Set<RunningAppEntry>();

/** Every opener registers what it runs (web panel and overlay, Desktop window); the returned function unregisters it. */
export function registerRunningApp(entry: RunningAppEntry): () => void {
  running.add(entry);
  return () => { running.delete(entry); };
}

/** Whether any app runs now: an update check then reads the installed apps even when no screen has. */
export function appsRunning(): boolean {
  return running.size > 0;
}

/**
 * After the installed apps were read again (an update check, the scheduled one included): every running app whose
 * version is revoked, or removed by a store without Run anyway, is stopped, and says why.
 */
export function stopTakenDown(apps: readonly { ref: string; run: { status: string; by?: readonly { name: string }[] } }[]): void {
  for (const entry of [...running]) {
    const run = apps.find((app) => app.ref === entry.ref)?.run;
    if (run?.status === "revoked") entry.takeDown({ why: "revoked" });
    else if (run?.status === "removed" && !entry.runAnyway) entry.takeDown({ why: "removed", store: run.by?.[0]?.name ?? "" });
  }
}
