/**
 * Desktop's way to open a mini-app (WISP 1200, "Per client", Desktop row): a window of its own per app, labelled
 * `app-<random>`, which Rust makes and guards (apps/desktop/src/app_sandbox.rs). The broker is the web's
 * (`createBroker`), here in the Ghostly window, one per app window, so the API, its checks and its caps are the same:
 *
 * - The runner in the app window asks `app_broker`. Rust answers `start` itself (the entry it holds for that window),
 *   checks every other request (the caller's label, 66 KiB, 50 a second) and hands it here as `ghostly-app-request`
 *   with the window's label; the broker knows the app by that label, never by anything the app says.
 * - The broker's answers and events go back through `app_post`: an answer to the request waiting for it (the
 *   result of the app's `app_broker` call), an event into that window alone; bytes go raw (`app_post_bytes`). A `file` answer names where the bytes lie
 *   in Rust's file storage (`byReference`): Rust reads and checks them and hands them to the app window as they are,
 *   so a 16 MiB file is never base64 and JSON on this window's thread (32 ms each in Chromium).
 * - There is no frame load to count: the window loads once, and Rust refuses every navigation after it. The broker's
 *   second load is the answer to `writing`.
 * - While the app serves the contact a file (WISP 1200 § A read lane to the contact), its window's title says so
 *   (`app_title`): "Chess · sharing a file with Ana", where the web's panel header says it.
 * - The app stops when the broker says so (`app_close`) or when the person closes its window (`ghostly-app-closed`).
 * - Opened again in the same chat (or alone again) while it runs, its window comes to the front (`app_focus`).
 * - A `files.pick` is taken only while the app's window has the focus (`app_focused`): its sheet raises the Ghostly window.
 *   So is the runner's `activity`: the person's taps and keys there count for the lock screen of the Ghostly window.
 */
import { createBroker, runnerFor, START_TIMEOUT_MS, type AppStopReason, type AppView, type Broker } from "./broker";
import { appInput, CHAT_CLOSED, chatDeletedSince, LOCKED, lockedSince, registerRunningApp, type AppOpener } from "./open";
import type { AppsPlatform, LinkedFilesHost } from "../platform";

/** Rust's events to the Ghostly window (apps/desktop/src/app_sandbox.rs). */
export const APP_REQUEST_EVENT = "ghostly-app-request";
export const APP_CLOSED_EVENT = "ghostly-app-closed";

/** Tauri's `invoke`: JSON args, or raw bytes placed by headers. */
type Invoke = <T>(command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<T>;
type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<unknown>;

export interface DesktopOpenerOptions {
  apps: () => AppsPlatform | null | undefined;
  invoke: Invoke;
  listen: Listen;
  /** The person's name in a chat, for an app granted `name`: what the contact was told, or none (`nameInChat`). */
  nameIn: (linkId: string) => string | undefined;
  /** The app window's title: "Chess with Ana" in a chat (`appWithContact`), "Chess · sharing a file with Ana" while it
   * serves the contact a file, the app's name alone by default. */
  windowTitle?: (title: string, linkId: string | null, serving: boolean) => string;
  onStop?: (ref: string, reason: AppStopReason) => void;
  view?: AppView;
  startTimeoutMs?: number;
  /** Files the person picks for an app granted `files` (`desktopFiles.ts`); none: `files.*` is `not-allowed`. */
  linkedFiles?: LinkedFilesHost;
}

/** How long a request for a window the opener does not know yet is kept: the window's label comes back a moment
 * after the window starts asking. */
const EARLY_MS = 5_000;

const defaultView: AppView = {
  theme: () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
  locale: () => document.documentElement.lang || navigator.language,
};

/**
 * A broker message on its way to the app window `label`, through Rust. An answer that is bytes (`files.read`,
 * `remote.read`, a `file` not read by reference) goes raw (`app_post_bytes`, the window and request in its headers),
 * and Rust makes the base64 the runner reads: here, an app reading 1 MiB slices at 16 MiB a second cost this window
 * ~2 ms a MiB of base64 and a 1.4 MB JSON string per answer. Anything else is JSON (`app_post`).
 */
function postTo(invoke: Invoke, label: string, message: unknown): Promise<unknown> {
  const { id, value } = (message ?? {}) as { id?: unknown; value?: unknown };
  if (value instanceof ArrayBuffer && typeof id === "number") {
    return invoke("app_post_bytes", new Uint8Array(value), { headers: { "x-label": label, "x-id": String(id) } });
  }
  return invoke("app_post", { label, message });
}

export function desktopOpener({ apps, invoke, listen, nameIn, windowTitle = (title) => title, onStop, view = defaultView, startTimeoutMs = START_TIMEOUT_MS, linkedFiles }: DesktopOpenerOptions): AppOpener {
  const brokers = new Map<string, Broker>();
  /** The window of each app running, by chat and app: the same one opened again is brought to the front (as on the
   * web), never a second window, whose close would close the app in the chat for the first one too. */
  const windows = new Map<string, Promise<string>>();
  const early = new Map<string, { at: number; requests: unknown[] }>();
  void listen<{ label: string; request: unknown }>(APP_REQUEST_EVENT, ({ payload }) => {
    if (!payload || typeof payload.label !== "string") return;
    const broker = brokers.get(payload.label);
    if (broker) return deliver(broker, payload.request);
    const now = Date.now();
    for (const [label, held] of early) if (now - held.at > EARLY_MS) early.delete(label);
    const held = early.get(payload.label) ?? { at: now, requests: [] };
    held.requests.push(payload.request);
    early.set(payload.label, held);
  });
  void listen<string>(APP_CLOSED_EVENT, ({ payload }) => {
    early.delete(payload);
    brokers.get(payload)?.stop("stopped");
  });

  function deliver(broker: Broker, request: unknown) {
    broker.message(request);
    // The answer to `writing` went: the app is written next, with no load to wait for (Rust refuses every navigation).
    if (broker.phase === "writing") broker.load();
  }

  return async (ref, linkId, options) => {
    const engine = apps();
    if (!engine) throw new Error("Apps cannot run in this app");
    const host: AppsPlatform = linkedFiles ? { ...engine, linkedFiles } : engine;
    // The profile locking while it opens (its files downloading, its window being made) stops nothing yet: it never starts.
    const locked = lockedSince();
    // Its chat deleted while it opens (`stopAppsIn` found nothing of it running): it never starts either.
    const deleted = chatDeletedSince(linkId);
    // A version a store removed runs only with "Run anyway"; a revoked one never (the engine checks both again).
    const entry = await host.entry(ref, options?.runAnyway === true);
    if (locked()) throw new Error(LOCKED);
    if (deleted()) throw new Error(CHAT_CLOSED);
    // Throws where this client has no runner for what the person granted.
    runnerFor(host, entry);
    // Open pressed twice before its window is there (a double click) gets here twice: the second waits for the first's.
    const place = `${linkId ?? ""} ${ref}`;
    const there = windows.get(place);
    if (there) {
      const label = await there;
      if (locked()) throw new Error(LOCKED);
      if (deleted()) throw new Error(CHAT_CLOSED);
      await invoke("app_focus", { label }).catch(() => { /* it went meanwhile */ });
      return "shown";
    }
    const opening = invoke<string>("app_open", {
      // A full-screen app's window opens at the Ghostly window's size; a chat app's is smaller, as it sits beside it.
      request: { app: entry.ref, title: windowTitle(entry.title, linkId, false), entry: entry.entry, internet: entry.permissions.includes("internet"), view: entry.view ?? "chat" },
    });
    windows.set(place, opening);
    const label = await opening.catch((e: unknown) => { windows.delete(place); throw e; });
    if (locked() || deleted()) {
      // Its window is there already, over the locked Ghostly window or for a chat that is gone: it closes before the app starts in it.
      if (windows.get(place) === opening) windows.delete(place);
      early.delete(label);
      void invoke("app_close", { label }).catch(() => { /* already gone */ });
      throw new Error(locked() ? LOCKED : CHAT_CLOSED);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A version found revoked, or removed without Run anyway, while it runs: its window closes (WISP 1200 § Takedowns).
    // Its chat deleted, its window closes too (`stopAppsIn`).
    const unregister = registerRunningApp({ ref, digest: entry.digest, runAnyway: options?.runAnyway === true, linkId, takeDown: () => broker.stop("stopped"), stop: () => broker.stop("stopped") });
    const broker = createBroker({
      host,
      launch: { ...entry, chat: linkId ? { linkId, name: nameIn(linkId) } : null },
      view,
      post: (message) => { void postTo(invoke, label, message).catch(() => { /* the window went */ }); },
      byReference: true,
      shown: () => invoke<boolean>("app_focused", { label }).catch(() => false),
      inUse: () => invoke<boolean>("app_focused", { label }).catch(() => false),
      onInput: appInput,
      serving: (on) => { void invoke("app_title", { label, title: windowTitle(entry.title, linkId, on) }).catch(() => { /* the window went */ }); },
      stopped: (reason) => {
        if (timer) clearTimeout(timer);
        unregister();
        brokers.delete(label);
        if (windows.get(place) === opening) windows.delete(place);
        void invoke("app_close", { label }).catch(() => { /* already gone */ });
        onStop?.(ref, reason);
      },
    });
    // The window's one load: the runner is there, and asks for its entry.
    broker.load();
    brokers.set(label, broker);
    timer = setTimeout(() => { if (broker.phase === "starting" || broker.phase === "writing") broker.stop("timeout"); }, startTimeoutMs);
    const held = early.get(label);
    early.delete(label);
    for (const request of held?.requests ?? []) deliver(broker, request);
  };
}
