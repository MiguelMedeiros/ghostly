/**
 * The web app's way to open a mini-app (WISP 1200): the entry the engine checked, the runner's header checked once,
 * then the app in its sandboxed frame. In a 1:1 chat it runs in that chat's panel (`running.ts`, ChatAppPanel.tsx):
 * beside the chat on a wide screen, over it on a phone, with the contact and the connection in its header. Opened
 * again in the same chat, it is shown as it was. Opened alone (the Apps page), it is full screen with the client's own
 * bar above it (the app's name and Close), outside the frame.
 *
 * Each app it runs is registered (`registerRunningApp`): a version found revoked, or removed without Run anyway, is
 * stopped there, and its place says why until the person closes it (WISP 1200 § Takedowns).
 */
import { runnerFor, startApp, type AppStopReason, type AppView, type RunningApp } from "./broker";
import { appSlot, chatApp, setChatApp, updateChatApp } from "./running";
import { runnerAvailable } from "./runnerCheck";
import { registerRunningApp, type AppOpener, type AppTakedown } from "./open";
import type { AppsPlatform } from "../platform";

export interface WebOpenerOptions {
  apps: () => AppsPlatform | null | undefined;
  /** "Close", in the person's language. */
  closeLabel: () => string;
  /** "Chess was stopped: its maker revoked this version", in the person's language (an app opened alone). */
  stoppedLabel?: (title: string, takedown: AppTakedown) => string;
  /** The person's name in a chat, for an app granted `name`. */
  nameIn?: (linkId: string) => string | undefined;
  onStop?: (ref: string, reason: AppStopReason) => void;
}

/**
 * An app the person did not close (its frame navigated, broke the protocol, or never started) says why in the console:
 * the only trace of it, since the app's own frame is gone.
 */
function warnStop(title: string, reason: AppStopReason): void {
  if (reason !== "closed" && reason !== "stopped") console.warn(`[apps] ${title} stopped: ${reason}`);
}

export function webOpener({ apps, closeLabel, stoppedLabel = (title) => title, nameIn, onStop }: WebOpenerOptions): AppOpener {
  return async (ref, linkId, options) => {
    const host = apps();
    if (!host) throw new Error("Apps cannot run in this app");
    // A version a store removed runs only with "Run anyway"; a revoked one never (the engine checks both again).
    const entry = await host.entry(ref, options?.runAnyway === true);
    // The runner from what the person granted; its server must send that runner's policy.
    const internet = entry.permissions.includes("internet");
    if (!(await runnerAvailable(runnerFor(host, entry), fetch, internet))) throw new Error("This server does not send the policy apps run under");

    const launch = { ...entry, chat: linkId ? { linkId, name: nameIn?.(linkId) } : null };
    const view: AppView = {
      theme: () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
      locale: () => document.documentElement.lang || navigator.language,
    };

    // In a chat: its panel. The same app there is shown again; another one takes its place.
    const slot = linkId ? appSlot(linkId) : undefined;
    if (linkId && slot) {
      const there = chatApp(linkId);
      if (there?.ref === ref && !there.stopped) { updateChatApp(linkId, { shown: true }); return; }
      if (there && !there.stopped) there.running.stop();
      let running: RunningApp | null = null;
      let takenDown: AppTakedown | null = null;
      const unregister = registerRunningApp({
        ref, runAnyway: options?.runAnyway === true,
        takeDown: (takedown) => { takenDown = takedown; running?.stop(); },
      });
      running = startApp({
        container: slot, host, launch, view,
        onStop: (reason) => {
          unregister();
          const mine = !running || chatApp(linkId)?.running === running;
          // Taken down: the panel stays, shown, and says why until the person closes it.
          if (mine && takenDown) setChatApp(linkId, { ref, title: entry.title, shown: true, wide: chatApp(linkId)?.wide ?? false, running: running!, stopped: takenDown });
          else if (mine) setChatApp(linkId, null);
          warnStop(entry.title, reason);
          onStop?.(ref, reason);
        },
      });
      setChatApp(linkId, { ref, title: entry.title, shown: true, wide: false, running });
      return;
    }

    // Alone: full screen and modal. The app under it is inert until it goes; Close has the focus, Escape closes, and
    // the focus goes back to what opened it (or that app's Open on the Apps page, when a dialog opened it and went).
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", entry.title);
    overlay.setAttribute("data-testid", "mini-app");
    overlay.setAttribute("data-place", "alone");
    overlay.className = "fixed inset-0 z-50 flex flex-col bg-sidebar-bg text-text-primary";
    const bar = document.createElement("div");
    bar.className = "flex items-center gap-2 border-b border-border px-3 py-2 text-sm";
    const title = document.createElement("span");
    title.className = "flex-1 truncate font-medium";
    title.setAttribute("data-testid", "mini-app-title");
    title.textContent = entry.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rounded px-2 py-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    close.textContent = closeLabel();
    const box = document.createElement("div");
    box.className = "relative flex-1 [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0";
    bar.append(title, close);
    overlay.append(bar, box);
    // The app's shell (App.tsx), not the whole page: the lock screen, drawn above the app, must still take a password.
    const under = [...document.querySelectorAll<HTMLElement>(".two-pane, .app-shell")].filter((node) => !node.inert);
    document.body.appendChild(overlay);
    for (const node of under) node.inert = true;
    close.focus({ preventScroll: true });

    const dismiss = () => {
      for (const node of under) node.inert = false;
      overlay.remove();
      const row = document.querySelector<HTMLElement>(`[data-testid=installed-app][data-ref="${CSS.escape(ref)}"] [data-testid=installed-app-open]`);
      (before?.isConnected ? before : row)?.focus({ preventScroll: true });
    };
    let takenDown: AppTakedown | null = null;
    const unregister = registerRunningApp({
      ref, runAnyway: options?.runAnyway === true,
      takeDown: (takedown) => { takenDown = takedown; running.stop(); },
    });
    const running = startApp({
      container: box, host, launch, view,
      onStop: (reason) => {
        unregister();
        warnStop(entry.title, reason);
        onStop?.(ref, reason);
        if (!takenDown) { dismiss(); return; }
        // Taken down: its place says why, under the same bar, until Close.
        const why = document.createElement("p");
        why.setAttribute("role", "status");
        why.setAttribute("data-testid", "mini-app-stopped");
        why.className = "m-0 p-6 text-center text-sm text-text-secondary";
        why.textContent = stoppedLabel(entry.title, takenDown);
        box.replaceWith(why);
      },
    });
    const end = () => { if (overlay.isConnected && !running.frame.isConnected) dismiss(); else running.stop(); };
    close.addEventListener("click", end);
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); end(); } });
  };
}
