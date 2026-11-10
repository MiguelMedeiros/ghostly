/**
 * The windows a contact's shared web app opens in (Desktop's viewer, `open_service_window`): the page that opened
 * them answers their requests over its chat with that contact. When the profile locks they close, as running apps
 * stop (`stopRunningApps`): nothing of the profile answers them behind the lock screen.
 */
import type { Translate, TranslationKey } from "../locales/translate";
import { contactTag } from "./publicKeyLabel";

let closer: (() => void) | null = null;

/** How to close them: set by the Desktop host, the extension's (its viewer tabs) and the web's (its drawn view). */
export function setServiceWindowsCloser(next: (() => void) | null): void {
  closer = next;
}

/** How many times they were closed for the lock: an open still on its way then never shows its app. */
let closes = 0;

/** Closes every one of them, where the app has them. */
export function closeServiceWindows(): void {
  closes += 1;
  closer?.();
}

/**
 * Read by an opener before its first wait: the returned function says whether they were closed since (the profile
 * locked, here or in another tab). There is nothing to close until the app is on screen, so the opener asks after every
 * wait, and one that finds them closed shows nothing (`lockedSince` for an app, `apps/open.ts`).
 */
export function serviceWindowsClosedSince(): () => boolean {
  const at = closes;
  return () => closes !== at;
}

/** Why an open that the profile's lock overtook showed nothing. */
export const SERVICE_LOCKED = "The profile locked before the contact's app opened";

/*
 * On the web a contact's app is drawn over the whole app (apps/web/src/svc/opener.ts), a call's windows with it: it
 * makes way for a call that rings or starts, and does not open over one. Desktop's windows are windows of their own.
 */
let viewCloser: (() => void) | null = null;
let callWindows = 0;
/** Others drawn over the whole app that make way too: a video filling the window (Desktop on Linux). */
const makingWay = new Set<() => void>();

/** How to close a contact's app drawn over the app: set by the web host. */
export function setServiceViewCloser(next: (() => void) | null): void {
  viewCloser = next;
}

/** Calls `leave` when a call's window comes on screen, until the returned end. */
export function onCallWindowShown(leave: () => void): () => void {
  makingWay.add(leave);
  return () => { makingWay.delete(leave); };
}

/** A call's window (a ringing call, a call full screen or small) on screen, from its effect: returns its end. */
export function callWindowShown(): () => void {
  callWindows += 1;
  viewCloser?.();
  for (const leave of [...makingWay]) leave();
  return () => { callWindows -= 1; };
}

/** Whether a call's window is on screen: a contact's app does not open over it. */
export function callWindowOn(): boolean {
  return callWindows > 0;
}

/*
 * A video filling the window (Desktop on Linux) is drawn over everything. A call already in its small window when it
 * started stays over it: its End call and Mute in reach, a video call's picture in sight.
 */
let filling = 0;
const fillingWatchers = new Set<() => void>();

/** A video fills the window, from its effect: returns its end. */
export function windowFilled(): () => void {
  filling += 1;
  for (const watch of [...fillingWatchers]) watch();
  return () => {
    filling -= 1;
    for (const watch of [...fillingWatchers]) watch();
  };
}

/** For `useSyncExternalStore`: `watch` is called when a video starts or stops filling the window. */
export function watchWindowFilled(watch: () => void): () => void {
  fillingWatchers.add(watch);
  return () => { fillingWatchers.delete(watch); };
}

/** Whether a video fills the window now. */
export function windowFilledNow(): boolean {
  return filling > 0;
}

const HOST_ERRORS: Record<string, TranslationKey> = {
  unreachable: "services.window.notAnswering",
  timeout: "services.window.tooSlow",
  "redirect-blocked": "services.window.elsewhere",
  // The contact took it back: not a broken app, and nothing to ask them to fix.
  "unknown-service": "services.window.unshared",
  busy: "services.window.busy",
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

/**
 * What frames a contact's app, in Ghostly's words: whose it is and that it is not Ghostly. The app's name is the
 * contact's free choice ("Ghostly", "Security check"), so it never stands alone: `label` names the view (the dialog's
 * name, Desktop's window title) and `owner` is the line always under it. The contact as this side calls them (the
 * chat's label, else their nickname), isolated so their name cannot turn the sentence's direction.
 */
export function serviceFraming(app: string, names: { label?: string; nick?: string } | undefined, peer: string, t: Translate): { label: string; owner: string } {
  const named = names?.label?.trim() || names?.nick?.trim() || t("common.unnamedContact", { key: contactTag(peer) });
  const contact = `\u2068${named}\u2069`;
  return { label: t("services.window.label", { app, contact }), owner: t("services.window.owner", { contact }) };
}
