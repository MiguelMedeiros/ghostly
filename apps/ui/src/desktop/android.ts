import { RTC_CONFIG } from "@ghostly/core";
import type { ClipboardFile } from "@ghostly/browser/host";
import { receiveShare } from "../lib/incomingShare";
import { PLATFORM_PASTE_MAX, readPlatformFiles } from "../lib/pastedFiles";

/*
 * What the page does only in the Android app (apps/desktop built for Android, src/android.rs): the system bars follow
 * the theme, shares from other apps reach the Share to… picker, and a test start keeps WebRTC off public STUN.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (event: string, handler: () => void) => Promise<unknown>;
type ListenWith = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<unknown>;

/**
 * Away and back. Android's WebView leaves `document.visibilityState` "visible" and `hasFocus()` true while the app is
 * in the background (Home, another app, the screen off), so the page never knew it was away: a message that came then
 * made no notification (AttentionFeedback, `windowAway`, the call notice all ask those two). The activity says when it
 * stops and comes back (Rust's `app-visibility`, "hidden" or "visible"); the page's document then answers as a
 * browser tab's does, and fires `visibilitychange`.
 */
export function followAppVisibility(listen: ListenWith, doc: Document = document): void {
  let away = false;
  const own = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  const ownHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  const hasFocus = doc.hasFocus.bind(doc);
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => (away ? "hidden" : own?.get?.call(doc) ?? "visible") });
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => away || !!ownHidden?.get?.call(doc) });
  doc.hasFocus = () => !away && hasFocus();
  void listen<string>("app-visibility", ({ payload }) => {
    const next = payload === "hidden";
    if (next === away) return;
    away = next;
    doc.dispatchEvent(new Event("visibilitychange"));
  }).catch(() => {});
}

/** A share from another app as Rust hands it over: its text, and its files on the paste shelf, by token. */
interface Shared {
  title: string;
  text: string;
  files: { token: string; name: string | null; size: number; mime: string | null }[];
}

/**
 * An RTC configuration without the apps' public STUN servers (`RTC_CONFIG`, Google's); the profile's own ICE servers
 * stay. A copy of the CLI's `withoutPublicStun` (packages/cli/src/runtime/engine.ts): keep the two alike.
 */
export function withoutPublicStun(config: RTCConfiguration | undefined): RTCConfiguration | undefined {
  if (!config?.iceServers) return config;
  const ours = new Set((RTC_CONFIG.iceServers ?? []).flatMap((server) => [server.urls].flat()));
  const iceServers = config.iceServers
    .map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !ours.has(url)) }))
    .filter((server) => server.urls.length);
  return { ...config, iceServers };
}

/**
 * A debug e2e start keeps the page off the public STUN servers (`GHOSTLY_STUN=0`, MainActivity.kt): Rust's environment
 * does not reach the WebView's WebRTC, so the page asks Rust once (`test_network`) and, when they are off, every
 * RTCPeerConnection made from then on leaves them out, as the CLI's `leaveOutPublicStun` does. Call it before the engine
 * makes a connection. True when it wrapped.
 */
export async function leaveOutPublicStun(invoke: Invoke, scope: { RTCPeerConnection?: typeof RTCPeerConnection } = window): Promise<boolean> {
  const { stun } = await invoke<{ stun: boolean }>("test_network");
  const Base = scope.RTCPeerConnection;
  if (stun || !Base) return false;
  scope.RTCPeerConnection = class extends Base {
    constructor(config?: RTCConfiguration) { super(withoutPublicStun(config)); }
  };
  return true;
}

/** "rgb(11, 20, 26)" (what `getComputedStyle` gives) as "#0b141a"; undefined for a see-through colour or anything else. */
export function cssColorHex(css: string): string | undefined {
  const match = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(css.trim());
  if (!match) return undefined;
  if (match[4] !== undefined && Number(match[4]) === 0) return undefined;
  return `#${[match[1], match[2], match[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Android's status and navigation bars take the page's background, and icons that read on it (Rust's `system_bars`):
 * now, and whenever the theme changes (Light or Dark, the colour theme), so no light strip sits over a dark app.
 * Returns a stop.
 */
export function followSystemBars(invoke: Invoke, root: HTMLElement = document.documentElement): () => void {
  let last = "";
  const send = () => {
    const color = cssColorHex(getComputedStyle(document.body).backgroundColor);
    if (!color) return;
    const dark = root.getAttribute("data-theme") !== "light";
    const key = `${color} ${dark}`;
    if (key === last) return;
    last = key;
    void invoke("system_bars", { color, dark }).catch(() => { last = ""; });
  };
  const observer = new MutationObserver(send);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-color-theme"] });
  send();
  return () => observer.disconnect();
}

/**
 * "Share to Ghostly" from another app: taken when the app starts (a share can be what started it) and whenever Rust
 * says one arrived. Its files are read whole into the page, as a paste's; one too large to paste is left out. The page
 * then shows the Share to… picker, as the web app's share target does. A share taken later wins over one still
 * being read: a big share's files that end late never replace the one made after it.
 */
export function takeIncomingShares(invoke: Invoke, listen: Listen): void {
  let latest = 0;
  const take = async () => {
    const shared = await invoke<Shared | null>("incoming_share_take");
    if (!shared) return;
    const mine = ++latest;
    const clips: ClipboardFile[] = shared.files
      .filter((file) => file.size <= PLATFORM_PASTE_MAX)
      .map(({ token, ...file }) => ({
        ...file,
        read: async (offset: number, length: number) => {
          // Raw bytes, or a JSON array of them where the IPC goes through `postMessage` (Android).
          const bytes = await invoke<ArrayBuffer | number[]>("read_pasted_bytes", { token, offset, length });
          return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
        },
      }));
    const files = await readPlatformFiles(clips);
    if (mine !== latest) return;
    receiveShare({ title: shared.title, text: shared.text, url: "", files });
    if (location.hash !== "#/shared") location.hash = "#/shared";
  };
  void listen("incoming-share", () => void take().catch(() => {})).catch(() => {});
  void take().catch(() => {});
}
