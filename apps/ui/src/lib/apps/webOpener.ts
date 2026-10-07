/**
 * The web app's way to open a mini-app (WISP 1200): the entry the engine checked, the runner's header checked once,
 * then the app full screen in its sandboxed frame, with the client's own bar above it (the app's name and Close),
 * outside the frame. The Apps page and the chat card (the next step) may give it a place of their own instead.
 */
import { runnerFor, startApp, type AppStopReason } from "./broker";
import { runnerAvailable } from "./runnerCheck";
import type { AppOpener } from "./open";
import type { AppsPlatform } from "../platform";

export interface WebOpenerOptions {
  apps: () => AppsPlatform | null | undefined;
  /** "Close", in the person's language. */
  closeLabel: () => string;
  /** The person's name in a chat, for an app granted `name`. */
  nameIn?: (linkId: string) => string | undefined;
  onStop?: (ref: string, reason: AppStopReason) => void;
}

export function webOpener({ apps, closeLabel, nameIn, onStop }: WebOpenerOptions): AppOpener {
  return async (ref, linkId, options) => {
    const host = apps();
    if (!host) throw new Error("Apps cannot run in this app");
    // A version a store removed runs only with "Run anyway"; a revoked one never (the engine checks both again).
    const entry = await host.entry(ref, options?.runAnyway === true);
    // The runner from what the person granted; its server must send that runner's policy.
    const internet = entry.permissions.includes("internet");
    if (!(await runnerAvailable(runnerFor(host, entry), fetch, internet))) throw new Error("This server does not send the policy apps run under");

    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", entry.title);
    overlay.setAttribute("data-testid", "mini-app");
    overlay.className = "fixed inset-0 z-50 flex flex-col bg-sidebar-bg text-text-primary";
    const bar = document.createElement("div");
    bar.className = "flex items-center gap-2 border-b border-border px-3 py-2 text-sm";
    const title = document.createElement("span");
    title.className = "flex-1 truncate font-medium";
    title.textContent = entry.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rounded px-2 py-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    close.textContent = closeLabel();
    const box = document.createElement("div");
    box.className = "relative flex-1 [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0";
    bar.append(title, close);
    overlay.append(bar, box);
    document.body.appendChild(overlay);

    const running = startApp({
      container: box,
      host,
      launch: { ...entry, chat: linkId ? { linkId, name: nameIn?.(linkId) } : null },
      view: {
        theme: () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
        locale: () => document.documentElement.lang || navigator.language,
      },
      onStop: (reason) => {
        overlay.remove();
        // An app the person did not close (its frame navigated, broke the protocol, or never started) says why in the
        // console: the only trace of it, since the app's own frame is gone.
        if (reason !== "closed" && reason !== "stopped") console.warn(`[apps] ${entry.title} stopped: ${reason}`);
        onStop?.(ref, reason);
      },
    });
    close.addEventListener("click", () => running.stop());
  };
}
