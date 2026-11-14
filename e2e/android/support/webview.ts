import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Whether a device's WebView can show the app at all. One older than the app's minimum (MainActivity.kt `MIN_WEBVIEW`)
 * gets the app's "Update Android System WebView" screen over the page, so no spec reaches the UI: the API 30 emulator
 * image ships WebView 83, and every spec waited 120 s for "the UI rendered", then failed. Plain functions, so a unit
 * test reads them (tools/scripts/test/androidWebView.test.ts).
 */

const MAIN_ACTIVITY = resolve(import.meta.dirname, "../../../apps/desktop/gen/android/app/src/main/java/tools/ghostly/app/MainActivity.kt");

/** The oldest WebView major version the app takes, read from MainActivity.kt so the two never differ. */
export function minWebView(source = readFileSync(MAIN_ACTIVITY, "utf8")): number {
  const found = source.match(/\bMIN_WEBVIEW\s*=\s*(\d+)/)?.[1];
  if (!found) throw new Error("No MIN_WEBVIEW in MainActivity.kt");
  return Number(found);
}

/** The WebView the device's apps get, from `dumpsys webviewupdate`; null when it does not say. */
export function currentWebView(dump: string): { pkg: string; version: string; major: number } | null {
  const found = dump.match(/Current WebView package \(name, version\): \(([^,\s]+), ((\d+)[\d.]*)\)/);
  return found ? { pkg: found[1], version: found[2], major: Number(found[3]) } : null;
}

/** Why the app cannot show its page on this device (its WebView is older than `min`), or null. */
export function webViewTooOld(dump: string, min: number): string | null {
  const webView = currentWebView(dump);
  if (!webView || webView.major >= min) return null;
  return `The device's WebView ${webView.version} (${webView.pkg}) is older than the app's minimum, ${min} (MainActivity.kt MIN_WEBVIEW): the app shows its "Update Android System WebView" screen and no spec can reach its page. Use an emulator image whose WebView is ${min} or later.`;
}
