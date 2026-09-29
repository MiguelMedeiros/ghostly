import { servicesPlatform } from "./platform";

/**
 * The clipboard's text for a paste button: call it straight from the click. Resolves to the text
 * ("" when the clipboard holds none), or to null when it cannot be read; the caller then focuses a
 * field and asks for {@link pasteShortcut}, so the button is never a dead end.
 *
 * The desktop app reads through its host (Rust), because WKWebView answers
 * `navigator.clipboard.readText()` with a "Paste" callout that has to be clicked a second time.
 * Either way it reads only while the page holds a click's user activation: nothing reads the
 * clipboard behind the user's back, and the engine never reads it at all. The web app and the
 * extension use the Clipboard API, which the browser gates too (Chrome asks once).
 */
export async function readClipboardText(): Promise<string | null> {
  const activation = (navigator as Partial<Pick<Navigator, "userActivation">>).userActivation;
  if (activation && !activation.isActive) return null;
  try {
    return await (servicesPlatform?.readClipboardText() ?? navigator.clipboard.readText());
  } catch {
    return null;
  }
}

/** The keys that paste on this device, for the hint beside the field. */
export function pasteShortcut(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘V" : "Ctrl+V";
}
