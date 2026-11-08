import { getBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { servicesPlatform } from "./platform";

export type ShareOutcome = "shared" | "copied" | "cancelled";

/** Copies text, with the old textarea route where the Clipboard API is refused. Throws when neither works. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* the older route below */ }
  const previous = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed"; textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Copy unavailable");
  } finally {
    textarea.remove();
    if (previous?.isConnected) previous.focus();
  }
}

/**
 * Copies a secret (an invite, a device's link, a group's link, ecash): marked sensitive where the host can (the Android
 * app, whose copy preview then shows dots and whose keyboards keep no history of it), elsewhere as `copyText`. A
 * refused sensitive copy throws: the caller shows the text to copy by hand rather than copy it unmarked.
 */
export async function copySecret(text: string): Promise<void> {
  let host: BrowserHost | null = null;
  try { host = getBrowserHost(); } catch { /* none yet: the page copies */ }
  if (host?.copySecret) return host.copySecret(text);
  return copyText(text);
}

/**
 * Shares a link the best way this device has: the system's share sheet (the desktop app, through
 * its host), the Web Share API (phones, most browsers), and otherwise a copy, so there is always
 * something to paste. `anchor` is the button, for a sheet that points at it. The link is a secret (a group's): the
 * copy is `copySecret`.
 */
export async function shareLink(url: string, title: string, anchor?: HTMLElement | null): Promise<ShareOutcome> {
  const box = anchor?.getBoundingClientRect();
  const sheet = servicesPlatform?.shareText(url, box ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined);
  if (sheet) {
    try { if (await sheet) return "shared"; } catch { /* no sheet after all: the next way */ }
  }
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return "cancelled";
    }
  }
  await copySecret(url);
  return "copied";
}
