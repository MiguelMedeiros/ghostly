/**
 * Opening an installed mini-app (WISP 1200): the screens ask `openApp`, and the client that can run apps registers how
 * (`setAppOpener`: the web app's runner and broker, `webOpener.ts`). Where none is registered, apps cannot run here.
 */
import { useSyncExternalStore } from "react";
import type { Translate } from "../../locales/translate";
import type { LinkedFilesHost } from "../platform";

/** How to open it. `runAnyway`: the person chose "Run anyway" for a version a store of theirs removed (never a revoked one). */
export interface OpenAppOptions { runAnyway?: boolean }

/**
 * Opens `ref` in the 1:1 chat `linkId`, or alone when it is null. Rejects when it cannot start (revoked, removed, no runner…).
 * Resolves "shown" when it already ran there and was shown again: nothing new started, so the contact is not told again.
 */
export type AppOpener = (ref: string, linkId: string | null, options?: OpenAppOptions) => Promise<"shown" | void>;

let opener: AppOpener | null = null;
const listeners = new Set<() => void>();

export function setAppOpener(next: AppOpener | null): void {
  opener = next;
  for (const listener of [...listeners]) listener();
}

export function openApp(ref: string, linkId: string | null = null, options: OpenAppOptions = {}): Promise<"shown" | void> {
  return opener ? opener(ref, linkId, options) : Promise.reject(new Error("Apps cannot run in this app"));
}

/** The registered opener, or null where apps cannot run (a screen hides what would open one). */
export function useAppOpener(): AppOpener | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => opener, () => opener);
}

/**
 * Why the client stopped a running app (WISP 1200 § Takedowns): its publisher revoked the version, or a store removed it.
 * `failed`: the app stopped on its own (its frame navigated, broke the protocol, or never started; § the runner, step 7).
 * `unresponsive`: it held its thread past the watchdog's bound, and the page stopped it; it may be opened again.
 * `offline`: it never started, the person being offline (the web runner page never loaded).
 */
export type AppTakedown = { why: "revoked" } | { why: "removed"; store: string } | { why: "failed" } | { why: "unresponsive" } | { why: "offline" };

/** "Chess was stopped: its maker revoked this version", where the app ran. */
export function takedownText(title: string, takedown: AppTakedown, t: Translate): string {
  if (takedown.why === "failed") return t("apps.view.stoppedFailed", { title });
  if (takedown.why === "offline") return t("apps.view.stoppedOffline", { title });
  if (takedown.why === "unresponsive") return t("apps.view.stoppedUnresponsive", { title });
  return takedown.why === "revoked" ? t("apps.view.stoppedRevoked", { title }) : t("apps.view.stoppedRemoved", { title, store: takedown.store });
}

/** An app running now, as its opener registered it: its ref, the version it runs, whether the person chose Run anyway, and how to stop it. */
export interface RunningAppEntry {
  ref: string;
  /** The digest its entry had: the installed one may be another by now. */
  digest: string;
  runAnyway: boolean;
  /** Stops the app and says why where it ran. */
  takeDown(takedown: AppTakedown): void;
  /** Stops the app and says nothing: the person uninstalled it. */
  stop(): void;
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

/** Why an open that the profile's lock overtook did not start. */
export const LOCKED = "The profile locked before the app started";

/** How many times the profile locked (`stopRunningApps`): an open still on its way when it locks never starts. */
let locks = 0;

/**
 * Read by an opener before its first wait: the returned function says whether the profile locked since. An app is
 * registered only once its entry is there (and on Desktop its window), so a lock in between stops nothing of it: the
 * opener asks after every wait, and one that finds it locked stops what it made and does not start the app.
 */
export function lockedSince(): () => boolean {
  const at = locks;
  return () => locks !== at;
}

/** Stops every running app and says nothing: the profile locked, and nothing of it answers an app behind the lock. */
export function stopRunningApps(): void {
  locks += 1;
  for (const entry of [...running]) entry.stop();
}

const inputListeners = new Set<() => void>();

/**
 * The person tapped or typed in an app they are in (its runner's `activity`, WISP 1200): their input there never reaches
 * this page, so the lock screen counts it here (`onAppInput`), or a game longer than the lock time would be locked out.
 */
export function appInput(): void {
  for (const listener of [...inputListeners]) listener();
}

export function onAppInput(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => { inputListeners.delete(listener); };
}

type RunOf = { status: string; by?: readonly { name: string }[] };

/**
 * After the installed apps were read again (an update check, the scheduled one included): every running app whose
 * version is revoked, or removed by a store without Run anyway, is stopped, and says why. The version is the one that
 * runs: after an update, `stopped` holds what the engine found of the one it started with. One no longer
 * installed (the person uninstalled it, on this page or another) is stopped too.
 */
export function stopTakenDown(apps: readonly { ref: string; digest: string; run: RunOf; stopped?: readonly { digest: string; run: RunOf }[] }[]): void {
  for (const entry of [...running]) {
    const app = apps.find((a) => a.ref === entry.ref);
    if (!app) { entry.stop(); continue; }
    const run = app.digest === entry.digest ? app.run : app.stopped?.find((v) => v.digest === entry.digest)?.run;
    if (run?.status === "revoked") entry.takeDown({ why: "revoked" });
    else if (run?.status === "removed" && !entry.runAnyway) entry.takeDown({ why: "removed", store: run.by?.[0]?.name ?? "" });
  }
}

/**
 * The files people picked for apps on this client (WISP 1200 · Linked files), as its opener keeps them: set once by
 * the client that runs apps. An app uninstalled drops its links (`forgetLinkedFiles`); the files are never touched.
 */
let linkedFiles: LinkedFilesHost | null = null;

export function setLinkedFiles(host: LinkedFilesHost | null): void {
  linkedFiles = host;
}

/** Drops every link of an app: it was uninstalled. Never fails the uninstall. */
export async function forgetLinkedFiles(ref: string): Promise<void> {
  await linkedFiles?.forget(ref, "all").catch(() => {});
}
