import { describe, expect, it } from "vitest";
import { currentWebView, minWebView, webViewTooOld } from "../../../e2e/android/support/webview";

/*
 * An emulator whose WebView is older than the app's minimum (MainActivity.kt `MIN_WEBVIEW`) shows the app's "Update
 * Android System WebView" screen over the page, so no spec can reach the UI. The API 30 image ships WebView 83: every
 * spec waited 120 s for "the UI rendered" and failed, 20 of 20, every night. The harness says why at once instead.
 */

/** `adb shell dumpsys webviewupdate` on the API 30 google_apis emulator. */
const API30 = `Current WebView Update Service state
  Fallback logic enabled: true
  Current WebView package (name, version): (com.google.android.webview, 83.0.4103.106)
  Minimum targetSdkVersion: 30
  Minimum WebView version code: 410310600
  Number of relros started: 2
  Number of relros finished: 2
  WebView package dirty: false
  Any WebView package installed: true
  Preferred WebView package (name, version): (com.google.android.webview, 83.0.4103.106)
`;

const API35 = API30.replaceAll("83.0.4103.106", "124.0.6367.219");

describe("the emulator's WebView", () => {
  it("is read from dumpsys webviewupdate", () => {
    expect(currentWebView(API30)).toEqual({ pkg: "com.google.android.webview", version: "83.0.4103.106", major: 83 });
    expect(currentWebView(API35)?.major).toBe(124);
    expect(currentWebView("Can't find service: webviewupdate")).toBeNull();
  });

  it("takes the app's minimum from MainActivity.kt", () => {
    expect(minWebView()).toBe(111);
    expect(() => minWebView("class MainActivity")).toThrow(/MIN_WEBVIEW/);
  });

  it("older than the app's minimum is refused with its version and the minimum; a newer one, or one not read, is not", () => {
    expect(webViewTooOld(API30, 111)).toMatch(/WebView 83\.0\.4103\.106.*111/);
    expect(webViewTooOld(API35, 111)).toBeNull();
    // A device that does not say: the start itself shows what is wrong, as before.
    expect(webViewTooOld("", 111)).toBeNull();
  });
});
