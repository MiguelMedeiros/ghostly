import { isDesktopApp } from "./externalLink";
import type { SoundsRelease } from "./sounds";

/**
 * Whether the sounds' output is suspended between sounds on WebKitGTK `version` (null: not known). Before 2.52 it
 * holds the page inside an `AudioContext.resume()` that follows a `suspend()` (0.5 s, then 5 to 16 s; 2.52 resumes in
 * milliseconds), so there the output stays running, and so it does while the version cannot be told: about 4% CPU
 * idle rather than a page frozen for seconds. Closing the output instead is no way out: a new AudioContext does not
 * start there without a fresh user gesture. The Desktop (desktop/host.ts) and the web app on Linux both ask this.
 */
export function webkitGtkSoundsRelease(version: readonly number[] | null): SoundsRelease {
  if (!version) return "keep";
  const [major = 0, minor = 0] = version;
  return major > 2 || (major === 2 && minor >= 52) ? "suspend" : "keep";
}

/**
 * A WebKitGTK (or WPE) browser: GNOME Web (Epiphany) and the other browsers built on it. Their user agent is
 * WebKit's own (Source/WebCore/platform/glib/UserAgentGLib.cpp): `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15
 * (KHTML, like Gecko) Version/… Safari/605.1.15`, `(Linux; like Android 4.4) … Mobile Safari/605.1.15` on a Linux
 * phone, another OS or a distribution's branding in the parentheses. Epiphany adds nothing of its own. Safari on a
 * Mac or an iPhone says so; Chrome, Edge, Opera and Android's browsers carry their own token, Firefox has no WebKit.
 */
export function isWebKitGtk(agent: string): boolean {
  if (!/AppleWebKit\/605\.1\.15 /.test(agent) || !/Safari\/605\.1\.15/.test(agent)) return false;
  if (/Macintosh|iPhone|iPad|iPod|Windows|CrOS/.test(agent)) return false;
  return !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\/|SamsungBrowser|Firefox|\bAndroid (?!4\.4\))/.test(agent);
}

/** What `webkitGtkFloor` looks at: the page's window, or a stand-in in tests. */
export interface WebFeatures {
  navigation?: unknown;
  CSS?: { supports?: (property: string, value: string) => boolean };
}

/**
 * The oldest WebKitGTK this page can be on, or null when it cannot be told. The user agent does not say: WebKitGTK
 * freezes `AppleWebKit/605.1.15` and makes its `Version/` up (higher than Safari's, for sites that turn Safari away).
 * What 2.52 enables does: the Navigation API (`window.navigation`) and CSS `field-sizing`, both new in 2.52 ("WebKitGTK
 * 2.52 highlights", webkitgtk.org/2026/03/18/webkitgtk-2.52-highlights.html: "now enabled", "now available"; neither
 * is in 2.50's). Both are asked for, so one turned off in some build says "not known" rather than 2.52.
 */
export function webkitGtkFloor(features: WebFeatures): readonly number[] | null {
  const fieldSizing = (() => { try { return !!features.CSS?.supports?.("field-sizing", "content"); } catch { return false; } })();
  return "navigation" in features && fieldSizing ? [2, 52] : null;
}

/**
 * Whether this browser page suspends the sounds' output between sounds, or null to leave it as it is: the Desktop
 * sets its own (it asks Rust for the WebKitGTK it runs on), and every browser but a WebKitGTK one resumes at once.
 */
export function browserSoundsRelease(
  agent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  features: WebFeatures = typeof window === "undefined" ? {} : window,
  desktop = isDesktopApp(),
): SoundsRelease | null {
  if (desktop || !isWebKitGtk(agent)) return null;
  return webkitGtkSoundsRelease(webkitGtkFloor(features));
}
