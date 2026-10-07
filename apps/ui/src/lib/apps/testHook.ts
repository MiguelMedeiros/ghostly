/**
 * The e2e build's way to run a mini-app before the app has a screen for it (WISP 1200; the Apps page comes later).
 * Only a build made with VITE_APPS_TEST=1 imports this (apps/web/src/main.tsx): a release build has none of it. It
 * runs apps through the real runner and broker, on an in-memory host the test can read.
 */
import type { AppFrameEvent } from "@ghostly/core";
import { startApp, type AppLaunch, type AppStopReason, type RunningApp } from "./broker";
import { memoryHost, memoryAppId } from "./memoryHost";
import { runnerAvailable } from "./runnerCheck";

export interface AppsTestHook {
  /** Runs an app; its frame goes in a box of its own on the page. Returns its handle. */
  open(launch: Omit<AppLaunch, "chat"> & { chat?: AppLaunch["chat"]; files?: Record<string, string>; unguarded?: boolean }): number;
  /** Where an app is, and why it stopped. */
  status(handle: number): { phase: RunningApp["phase"]; stopped: AppStopReason | null };
  stop(handle: number): void;
  /** Every host call, with the app reference the broker named. */
  calls(): { op: string; ref: string; scope?: string; linkId?: string; key?: string }[];
  /** What an app keeps in a scope. */
  stored(ref: string, scope: string): Record<string, unknown>;
  /** The chat data frames apps sent. */
  sent(): { linkId: string; ref: string; data: unknown }[];
  /** A frame from the contact, as the engine would pass it on. */
  receive(linkId: string, frame: AppFrameEvent): void;
  /** The chat app id the host gives an app in a chat. */
  appId(linkId: string, ref: string): string;
  /** Whether this server sends the runner's policy. */
  runnerAvailable(): Promise<boolean>;
}

export function installAppsTestHook(): void {
  const host = memoryHost();
  const apps: { app: RunningApp; stopped: AppStopReason | null }[] = [];
  const hook: AppsTestHook = {
    open({ files, chat, unguarded, ...launch }) {
      host.files.set(launch.ref, new Map(Object.entries(files ?? {}).map(([path, text]) => [path, new TextEncoder().encode(text)])));
      const box = document.createElement("div");
      box.setAttribute("data-testid", "mini-app");
      box.style.cssText = "position:fixed;right:0;bottom:0;width:320px;height:240px;z-index:2147483647;background:#fff";
      document.body.appendChild(box);
      const handle = apps.length;
      const entry = { app: null as unknown as RunningApp, stopped: null as AppStopReason | null };
      apps.push(entry);
      entry.app = startApp({
        container: box,
        // The runner without its hint guard (the e2e build's own copy): the nonce lock alone.
        host: unguarded ? { ...host, runnerUrl: "/app-frame-unguarded.html" } : host,
        launch: { ...launch, chat: chat ?? null },
        view: { theme: () => "dark", locale: () => "pt-BR" },
        onStop: (reason) => { entry.stopped = reason; box.remove(); },
      });
      entry.app.frame.setAttribute("data-app", launch.ref);
      return handle;
    },
    status: (handle) => ({ phase: apps[handle]!.app.phase, stopped: apps[handle]!.stopped }),
    stop: (handle) => apps[handle]?.app.stop(),
    calls: () => host.calls.map((call) => ({ ...call })),
    stored: (ref, scope) => Object.fromEntries(host.stored.get(`${ref} ${scope}`) ?? []),
    sent: () => host.sent.map((s) => ({ ...s })),
    receive: (linkId, frame) => host.receive(linkId, frame),
    appId: memoryAppId,
    runnerAvailable: () => Promise.all([runnerAvailable(host.runnerUrl), runnerAvailable(host.netRunnerUrl!, fetch, true)]).then(([plain, net]) => plain && net),
  };
  (window as unknown as { __ghostlyApps: AppsTestHook }).__ghostlyApps = hook;
}
