/**
 * The web app's way to open a mini-app (WISP 1200): the entry the engine checked, the runner's header checked once,
 * then the app in its sandboxed frame. In a 1:1 chat it runs in that chat's panel (`running.ts`, ChatAppPanel.tsx):
 * beside the chat on a wide screen, over it on a phone, with the contact and the connection in its header. Opened
 * again in the same chat, it is shown as it was. Opened alone (the Apps page), it is full screen with the client's own
 * bar above it (the app's name and Close), outside the frame. Its manifest's `view` says which: a `full` app covers the
 * whole chat too, never beside it; a `chat` app opens in a chat only (the Apps page asks which one).
 *
 * Each app it runs is registered (`registerRunningApp`): a version found revoked, or removed without Run anyway, is
 * stopped there, and its place says why until the person closes it (WISP 1200 § Takedowns).
 */
import { runnerFor, startApp, type AppStopReason, type AppView, type RunningApp } from "./broker";
import { appSlot, chatApp, setChatApp, updateChatApp } from "./running";
import { runnerPolicy } from "./runnerCheck";
import { CHAT_CLOSED, LOCKED, lockedSince, registerRunningApp, type AppOpener, type AppTakedown } from "./open";
import type { AppsPlatform, LinkedFilesHost } from "../platform";
import { openLayer } from "../layerHistory";

export interface WebOpenerOptions {
  apps: () => AppsPlatform | null | undefined;
  /** "Close", in the person's language. */
  closeLabel: () => string;
  /** "Chess was stopped: its maker revoked this version", in the person's language (an app opened alone). */
  stoppedLabel?: (title: string, takedown: AppTakedown) => string;
  /** "Open again", in the person's language: under an app opened alone that the watchdog stopped. */
  openAgainLabel?: () => string;
  /** Why Open again failed there, in the person's language (`appErrorText`); without it, the console only. */
  errorText?: (error: unknown) => string;
  /** The person's name in a chat, for an app granted `name`: what the contact was told, or none (`nameInChat`). */
  nameIn: (linkId: string) => string | undefined;
  onStop?: (ref: string, reason: AppStopReason) => void;
  /** Files the person picks for an app granted `files` (`webFiles.ts`); none: `files.*` is `not-allowed`. */
  linkedFiles?: LinkedFilesHost;
}

/**
 * An app the person did not close (its frame navigated, broke the protocol, never started, or kept taking the focus)
 * says why in the console, and its place says it stopped (WISP 1200 § the runner, step 7): it is not told apart from
 * Close otherwise. One that never started while the person is offline did not fail: its runner page never loaded.
 */
function warnStop(title: string, reason: AppStopReason): AppTakedown | null {
  if (reason === "closed" || reason === "stopped") return null;
  console.warn(`[apps] ${title} stopped: ${reason}`);
  if (reason === "timeout" && navigator.onLine === false) return { why: "offline" };
  return reason === "unresponsive" || reason === "focus" ? { why: reason } : { why: "failed" };
}

export function webOpener({ apps, closeLabel, stoppedLabel = (title) => title, openAgainLabel, errorText, nameIn, onStop, linkedFiles }: WebOpenerOptions): AppOpener {
  /** The layer of each app open alone, by app and chat: the same one opened again is shown as it is. */
  const alone = new Map<string, HTMLElement>();
  const open: AppOpener = (ref, linkId, options) => start(ref, linkId, options);
  /** `replace`: Open again on a stopped layer, which goes only once the app can start, so a failure is said there. */
  const start = async (ref: string, linkId: string | null | undefined, options: Parameters<AppOpener>[2], replace?: () => void): Promise<void | "shown"> => {
    const engine = apps();
    if (!engine) throw new Error("Apps cannot run in this app");
    const host: AppsPlatform = linkedFiles ? { ...engine, linkedFiles } : engine;
    // The profile locking while it opens (its files downloading, the runner checked) stops nothing yet: it never starts.
    const locked = lockedSince();
    // A version a store removed runs only with "Run anyway"; a revoked one never (the engine checks both again).
    const entry = await host.entry(ref, options?.runAnyway === true);
    if (locked()) throw new Error(LOCKED);
    // The runner from what the person granted; its server must send that runner's policy. The runner pages are never
    // cached (sw/policy.ts): offline, or when it could not be asked, it would not load, and the person is told so.
    const internet = entry.permissions.includes("internet");
    const policy = navigator.onLine === false ? null : await runnerPolicy(runnerFor(host, entry), fetch, internet);
    if (policy === null) throw new Error("offline: the runner page could not be reached");
    if (!policy) throw new Error("runner: This server does not send the policy apps run under");
    if (locked()) throw new Error(LOCKED);
    replace?.();

    const launch = { ...entry, chat: linkId ? { linkId, name: nameIn(linkId) } : null };
    const view: AppView = {
      theme: () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
      locale: () => document.documentElement.lang || navigator.language,
    };

    // In a chat: its panel. The same app there is shown again; another one takes its place. A chat closed while it
    // opened (its files fetched again, the runner asked) has no panel: the app never starts, nor alone over the page the
    // person went to.
    const slot = linkId ? appSlot(linkId) : undefined;
    if (linkId && !slot) throw new Error(CHAT_CLOSED);
    if (linkId && slot) {
      const there = chatApp(linkId);
      if (there?.ref === ref && !there.stopped) { updateChatApp(linkId, { shown: true }); return "shown"; }
      if (there && !there.stopped) there.running.stop();
      let running: RunningApp | null = null;
      let takenDown: AppTakedown | null = null;
      const runAnyway = options?.runAnyway === true;
      const unregister = registerRunningApp({
        ref, digest: entry.digest, runAnyway,
        takeDown: (takedown) => { takenDown = takedown; running?.stop(); },
        stop: () => running?.stop(),
      });
      running = startApp({
        container: slot, host, launch, view,
        onStop: (reason) => {
          unregister();
          const mine = !running || chatApp(linkId)?.running === running;
          const why = takenDown ?? warnStop(entry.title, reason);
          // Taken down, or stopped on its own: the panel stays, shown, and says why until the person closes it.
          if (mine && why) setChatApp(linkId, { ref, title: entry.title, shown: true, wide: chatApp(linkId)?.wide ?? false, view: entry.view ?? "chat", running: running!, runAnyway, stopped: why });
          else if (mine) setChatApp(linkId, null);
          onStop?.(ref, reason);
        },
        onServing: (on) => { if (chatApp(linkId)?.running === running) updateChatApp(linkId, { serving: on }); },
      });
      setChatApp(linkId, { ref, title: entry.title, shown: true, wide: false, view: entry.view ?? "chat", running, runAnyway });
      return;
    }

    // Alone: full screen and modal. The app under it is inert until it goes; Close has the focus, Escape closes, and
    // the focus goes back to what opened it (or that app's Open on the Apps page, when a dialog opened it and went).
    // Open pressed twice before it shows (a double click) gets here twice: the second finds the first one's layer.
    const place = `${linkId ?? ""} ${ref}`;
    if (alone.get(place)?.isConnected) return "shown";
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", entry.title);
    overlay.setAttribute("data-testid", "mini-app");
    overlay.setAttribute("data-place", "alone");
    overlay.className = "fixed inset-0 z-50 flex flex-col bg-sidebar-bg text-text-primary";
    const bar = document.createElement("div");
    // `alone-bar`: on a phone the layer covers the whole screen, status bar included, so the bar starts below the clock
    // and the notch (index.css), or Close sits under them and cannot be pressed (the installed web app on an iPhone).
    bar.className = "alone-bar flex items-center gap-2 border-b border-border px-3 py-2 text-sm";
    const title = document.createElement("span");
    title.className = "text-match-parent flex-1 truncate font-medium";
    title.setAttribute("data-testid", "mini-app-title");
    title.dir = "auto";
    title.textContent = entry.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "min-h-11 rounded px-3 py-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
    close.textContent = closeLabel();
    const box = document.createElement("div");
    box.className = "relative flex-1 [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0";
    bar.append(title, close);
    overlay.append(bar, box);
    // The app's shell (App.tsx), not the whole page: the lock screen, drawn above the app, must still take a password.
    const under = [...document.querySelectorAll<HTMLElement>(".two-pane, .app-shell")].filter((node) => !node.inert);
    document.body.appendChild(overlay);
    alone.set(place, overlay);
    for (const node of under) node.inert = true;
    close.focus({ preventScroll: true });
    // Back (Android's back gesture) closes it, as it does every dialog and sheet: without an entry of its own, Back moved
    // the page under it to the one before, the app stayed on top, and Close then left the focus nowhere.
    const closed = openLayer(() => end());

    const dismiss = () => {
      closed();
      for (const node of under) node.inert = false;
      overlay.remove();
      if (alone.get(place) === overlay) alone.delete(place);
      const row = document.querySelector<HTMLElement>(`[data-testid=installed-app][data-ref="${CSS.escape(ref)}"] [data-testid=installed-app-open]`);
      (before?.isConnected ? before : row)?.focus({ preventScroll: true });
    };
    let takenDown: AppTakedown | null = null;
    const unregister = registerRunningApp({
      ref, digest: entry.digest, runAnyway: options?.runAnyway === true,
      takeDown: (takedown) => { takenDown = takedown; running.stop(); },
      stop: () => running.stop(),
    });
    const running = startApp({
      container: box, host, launch, view,
      onStop: (reason) => {
        unregister();
        const stopped = takenDown ?? warnStop(entry.title, reason);
        onStop?.(ref, reason);
        if (!stopped) { dismiss(); return; }
        // Taken down, or stopped on its own: its place says why, under the same bar, until Close.
        const why = document.createElement("p");
        why.setAttribute("role", "status");
        why.setAttribute("data-testid", "mini-app-stopped");
        why.className = "m-0 p-6 text-center text-sm text-text-secondary";
        why.textContent = stoppedLabel(entry.title, stopped);
        box.replaceWith(why);
        // Stopped by the watchdog: it may run fine once started again, and the person decides.
        if (stopped.why === "unresponsive" && openAgainLabel) {
          const again = document.createElement("button");
          again.type = "button";
          again.setAttribute("data-testid", "mini-app-open-again");
          again.className = "mx-auto min-h-11 rounded border border-accent px-4 py-1 text-sm font-medium text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
          again.textContent = openAgainLabel();
          const failed = document.createElement("p");
          failed.setAttribute("role", "alert");
          failed.setAttribute("data-testid", "mini-app-open-again-error");
          failed.className = "m-0 px-6 py-2 text-center text-sm text-danger-ink empty:hidden";
          again.addEventListener("click", () => {
            if (again.getAttribute("aria-busy") === "true") return;
            again.setAttribute("aria-busy", "true");
            again.setAttribute("aria-disabled", "true");
            failed.textContent = "";
            // The layer stays until the app can start: a failure is said under the button, not on the page under it.
            // Closed meanwhile: it stays closed.
            const replace = () => { if (!overlay.isConnected) throw new Error("closed while it opened again"); dismiss(); };
            start(ref, linkId, options, replace).catch((error: unknown) => {
              console.warn(`[apps] ${entry.title} did not open again`, error);
              if (!overlay.isConnected) return;
              again.removeAttribute("aria-busy");
              again.removeAttribute("aria-disabled");
              if (errorText) failed.textContent = errorText(error);
            });
          });
          why.after(again, failed);
        }
        // The focus was in the app's frame, gone with it: Close has it, so Escape still closes.
        if (overlay.isConnected && !overlay.contains(document.activeElement)) close.focus({ preventScroll: true });
      },
    });
    const end = () => { if (overlay.isConnected && !running.frame.isConnected) dismiss(); else running.stop(); };
    close.addEventListener("click", end);
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); end(); } });
  };
  return open;
}
