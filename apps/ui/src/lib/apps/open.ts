/**
 * Opening an installed mini-app (WISP 1200): the screens ask `openApp`, and the client that can run apps registers how
 * (`setAppOpener`: the web app's runner and broker, `webOpener.ts`). Where none is registered, apps cannot run here.
 */
import { useSyncExternalStore } from "react";
import type { Translate } from "../../locales/translate";
import type { LinkedFilesHost } from "../platform";

/**
 * How to open it. `runAnyway`: the person chose "Run anyway" for a version a store of theirs removed (never a revoked one).
 * `again`: Open again under a chat's stopped app, that app's run: it starts only if the chat still shows that one once it
 * can start, so a panel closed meanwhile stays closed.
 */
export interface OpenAppOptions { runAnyway?: boolean; again?: unknown }

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
 * `focus`: it kept taking the page's focus by script, and the page stopped it (`holdFocus`).
 */
export type AppTakedown = { why: "revoked" } | { why: "removed"; store: string } | { why: "failed" } | { why: "unresponsive" } | { why: "offline" } | { why: "focus" };

/** "Chess was stopped: its maker revoked this version", where the app ran. */
export function takedownText(title: string, takedown: AppTakedown, t: Translate): string {
  if (takedown.why === "failed") return t("apps.view.stoppedFailed", { title });
  if (takedown.why === "offline") return t("apps.view.stoppedOffline", { title });
  if (takedown.why === "unresponsive") return t("apps.view.stoppedUnresponsive", { title });
  if (takedown.why === "focus") return t("apps.view.stoppedFocus", { title });
  return takedown.why === "revoked" ? t("apps.view.stoppedRevoked", { title }) : t("apps.view.stoppedRemoved", { title, store: takedown.store });
}

/** An app running now, as its opener registered it: its ref, the version it runs, whether the person chose Run anyway, and how to stop it. */
export interface RunningAppEntry {
  ref: string;
  /** The digest its entry had: the installed one may be another by now. */
  digest: string;
  runAnyway: boolean;
  /** The chat it runs in (null: alone), where its opener has nothing that goes with the chat (a Desktop window). */
  linkId?: string | null;
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

/** Why an open in a chat that closed meanwhile (the person went elsewhere) did not start. */
export const CHAT_CLOSED = "The chat closed before the app started";

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

/** How many times each chat was deleted (`stopAppsIn`): an open still on its way in it when it goes never starts. */
const deletions = new Map<string, number>();

/**
 * Stops every app still running in the chat `linkId` and says nothing: the chat was deleted, and the engine refuses its
 * storage and its frames from now on. The web's panel went with the chat already; a Desktop app window has no panel.
 */
export function stopAppsIn(linkId: string): void {
  deletions.set(linkId, (deletions.get(linkId) ?? 0) + 1);
  for (const entry of [...running]) if (entry.linkId === linkId) entry.stop();
}

/**
 * Read by an opener before its first wait, as `lockedSince`: the returned function says whether the chat `linkId` was
 * deleted since (never, for an app alone). A Desktop app is registered only once its window is there, so a deletion in
 * between stops nothing of it: the opener asks after every wait, and stops what it made.
 */
export function chatDeletedSince(linkId: string | null): () => boolean {
  if (linkId === null) return () => false;
  const at = deletions.get(linkId) ?? 0;
  return () => (deletions.get(linkId) ?? 0) !== at;
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
type InstalledApps = readonly { ref: string; digest: string; run: RunOf; stopped?: readonly { digest: string; run: RunOf }[] }[];

/** Why `ref` at `digest` must not run by `apps`: taken down, or "uninstalled"; null when it may. */
function takedownOf(apps: InstalledApps, ref: string, digest: string, runAnyway: boolean): AppTakedown | "uninstalled" | null {
  const app = apps.find((a) => a.ref === ref);
  if (!app) return "uninstalled";
  const run = app.digest === digest ? app.run : app.stopped?.find((v) => v.digest === digest)?.run;
  if (run?.status === "revoked") return { why: "revoked" };
  if (run?.status === "removed" && !runAnyway) return { why: "removed", store: run.by?.[0]?.name ?? "" };
  return null;
}

/** How many reads of the installed apps were asked, and the newest one read (`stopTakenDown`) with its number. */
let reads = 0;
let lastRead: { at: number; apps: InstalledApps } | null = null;

/** Called as a read of the installed apps is asked: its number, for `stopTakenDown`. */
export function readingApps(): number {
  return ++reads;
}

/**
 * After the installed apps were read again (an update check, the scheduled one included): every running app whose
 * version is revoked, or removed by a store without Run anyway, is stopped, and says why. The version is the one that
 * runs: after an update, `stopped` holds what the engine found of the one it started with. One no longer
 * installed (the person uninstalled it, on this page or another) is stopped too. `at`: the read's number
 * (`readingApps`), which an app still opening compares with its own (`takenDownSince`).
 */
export function stopTakenDown(apps: InstalledApps, at: number = readingApps()): void {
  if (!lastRead || at > lastRead.at) lastRead = { at, apps };
  for (const entry of [...running]) {
    const why = takedownOf(apps, entry.ref, entry.digest, entry.runAnyway);
    if (why === "uninstalled") entry.stop();
    else if (why) entry.takeDown(why);
  }
}

/**
 * Read by an opener before its first wait, as `lockedSince`: an app is registered only once its entry is there (and on
 * Desktop its window), so a read in between stops nothing of it. After its last wait the opener asks with the version
 * the engine gave it, and one a read asked since found revoked, removed (without Run anyway) or uninstalled throws, in
 * the engine's words: it stops what it made and does not start the app. A read asked before is older than the engine's check.
 */
export function takenDownSince(): (ref: string, digest: string, runAnyway: boolean) => void {
  const at = reads;
  return (ref, digest, runAnyway) => {
    if (!lastRead || lastRead.at <= at) return;
    const why = takedownOf(lastRead.apps, ref, digest, runAnyway);
    if (why === "uninstalled") throw new Error("not-installed: This app is not installed");
    if (why?.why === "revoked") throw new Error("revoked: Its publisher revoked this version");
    if (why?.why === "removed") throw new Error(`removed: Removed by ${why.store}`);
  };
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
