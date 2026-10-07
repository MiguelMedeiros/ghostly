/**
 * Desktop's way to open a mini-app (WISP 1200, "Per client", Desktop row): a window of its own per app, labelled
 * `app-<random>`, which Rust makes and guards (apps/desktop/src/app_sandbox.rs). The broker is the web's
 * (`createBroker`), here in the Ghostly window, one per app window, so the API, its checks and its caps are the same:
 *
 * - The runner in the app window asks `app_broker`. Rust answers `start` itself (the entry it holds for that window),
 *   checks every other request (the caller's label, 64 KiB, 50 a second) and hands it here as `ghostly-app-request`
 *   with the window's label; the broker knows the app by that label, never by anything the app says.
 * - The broker's answers and events go back through `app_post`: an answer to the request waiting for it (the
 *   result of the app's `app_broker` call), an event into that window alone.
 * - There is no frame load to count: the window loads once, and Rust refuses every navigation after it. The broker's
 *   second load is the answer to `writing`.
 * - The app stops when the broker says so (`app_close`) or when the person closes its window (`ghostly-app-closed`).
 */
import { createBroker, runnerFor, START_TIMEOUT_MS, type AppStopReason, type AppView, type Broker } from "./broker";
import { registerRunningApp, type AppOpener } from "./open";
import type { AppsPlatform } from "../platform";

/** Rust's events to the Ghostly window (apps/desktop/src/app_sandbox.rs). */
export const APP_REQUEST_EVENT = "ghostly-app-request";
export const APP_CLOSED_EVENT = "ghostly-app-closed";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<unknown>;

export interface DesktopOpenerOptions {
  apps: () => AppsPlatform | null | undefined;
  invoke: Invoke;
  listen: Listen;
  /** The person's name in a chat, for an app granted `name`. */
  nameIn?: (linkId: string) => string | undefined;
  /** The app window's title: "Chess with Ana" in a chat (`appWithContact`), the app's name alone by default. */
  windowTitle?: (title: string, linkId: string | null) => string;
  onStop?: (ref: string, reason: AppStopReason) => void;
  view?: AppView;
  startTimeoutMs?: number;
}

/** How long a request for a window the opener does not know yet is kept: the window's label comes back a moment
 * after the window starts asking. */
const EARLY_MS = 5_000;

const defaultView: AppView = {
  theme: () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
  locale: () => document.documentElement.lang || navigator.language,
};

/** Base64 of bytes, in pieces (a file may be megabytes). */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A broker message as it travels to Rust: JSON, a file's bytes as base64 (`bytes`), which the runner turns back. */
export function forIpc(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const { value, ...rest } = message as { value?: unknown };
  if (value instanceof ArrayBuffer) return { ...rest, bytes: toBase64(new Uint8Array(value)) };
  return message;
}

export function desktopOpener({ apps, invoke, listen, nameIn, windowTitle = (title) => title, onStop, view = defaultView, startTimeoutMs = START_TIMEOUT_MS }: DesktopOpenerOptions): AppOpener {
  const brokers = new Map<string, Broker>();
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
    const host = apps();
    if (!host) throw new Error("Apps cannot run in this app");
    // A version a store removed runs only with "Run anyway"; a revoked one never (the engine checks both again).
    const entry = await host.entry(ref, options?.runAnyway === true);
    // Throws where this client has no runner for what the person granted.
    runnerFor(host, entry);
    const label = await invoke<string>("app_open", {
      request: { app: entry.ref, title: windowTitle(entry.title, linkId), entry: entry.entry, internet: entry.permissions.includes("internet") },
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A version found revoked, or removed without Run anyway, while it runs: its window closes (WISP 1200 § Takedowns).
    const unregister = registerRunningApp({ ref, runAnyway: options?.runAnyway === true, takeDown: () => broker.stop("stopped") });
    const broker = createBroker({
      host,
      launch: { ...entry, chat: linkId ? { linkId, name: nameIn?.(linkId) } : null },
      view,
      post: (message) => { void invoke("app_post", { label, message: forIpc(message) }).catch(() => { /* the window went */ }); },
      stopped: (reason) => {
        if (timer) clearTimeout(timer);
        unregister();
        brokers.delete(label);
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
