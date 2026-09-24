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
 * Shares a link the best way this device has: the system's share sheet (the desktop app, through
 * its host), the Web Share API (phones, most browsers), and otherwise a copy, so there is always
 * something to paste. `anchor` is the button, for a sheet that points at it.
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
  await copyText(url);
  return "copied";
}
