/**
 * The windows a contact's shared web app opens in (Desktop's viewer, `open_service_window`): the page that opened
 * them answers their requests over its chat with that contact. When the profile locks they close, as running apps
 * stop (`stopRunningApps`): nothing of the profile answers them behind the lock screen.
 */
import type { Translate, TranslationKey } from "../locales/translate";

let closer: (() => void) | null = null;

/** How to close them: set by the Desktop host; nowhere else has such windows. */
export function setServiceWindowsCloser(next: (() => void) | null): void {
  closer = next;
}

/** Closes every one of them, where the app has them. */
export function closeServiceWindows(): void {
  closer?.();
}

/*
 * On the web a contact's app is drawn over the whole app (apps/web/src/svc/opener.ts), a call's windows with it: it
 * makes way for a call that rings or starts, and does not open over one. Desktop's windows are windows of their own.
 */
let viewCloser: (() => void) | null = null;
let callWindows = 0;

/** How to close a contact's app drawn over the app: set by the web host. */
export function setServiceViewCloser(next: (() => void) | null): void {
  viewCloser = next;
}

/** A call's window (a ringing call, a call full screen or small) on screen, from its effect: returns its end. */
export function callWindowShown(): () => void {
  callWindows += 1;
  viewCloser?.();
  return () => { callWindows -= 1; };
}

/** Whether a call's window is on screen: a contact's app does not open over it. */
export function callWindowOn(): boolean {
  return callWindows > 0;
}

const HOST_ERRORS: Record<string, TranslationKey> = {
  unreachable: "services.window.notAnswering",
  timeout: "services.window.tooSlow",
  "redirect-blocked": "services.window.elsewhere",
};

/**
 * What to show for an answer the contact's machine gave in place of their app (an `x-ghostly-error` header,
 * docs/PROTOCOL.md "Host errors"): its own text is English and from the contact's side ("The local service…"), so the
 * opener says it in `t`'s language, from this side, and the code goes to the console. Null for the app's own answer.
 */
export function hostErrorText(headers: readonly (readonly [string, string])[], app: string, t: Translate): string | null {
  const code = headers.find(([name]) => name.toLowerCase() === "x-ghostly-error")?.[1];
  if (code === undefined) return null;
  console.warn(`The contact's machine answered for ${app}: ${code}`);
  const key = HOST_ERRORS[code];
  return key ? t(key, { app }) : t("services.window.failed");
}
