import type { AndroidDevice, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { PKG, webViewPage } from "../../../e2e/android/support/webViewPage";

/*
 * The Android harness's `app` fixture failed at 5 of 9 starts on one evening: `webViewPage` handed back an undefined
 * page (`page.setDefaultTimeout` of undefined), and the test then lost its whole 5 min timeout. Playwright's
 * `AndroidWebView.page()` is `pages()[0]` of the context it connected to, undefined when that connection ended before
 * the WebView had a page, and it keeps that answer: the same view asked again says the same. Only a device taken again
 * has new views. These devices answer as Playwright's do.
 */

const PID = 4242;

/** A device as Playwright's: one view of the app, whose `page()` is asked once and kept. */
function device(serial: string, page: Page | undefined) {
  let asked: Promise<Page | undefined> | undefined;
  const state = { closed: false, connects: 0 };
  const view = {
    pkg: () => PKG,
    pid: () => PID,
    page: () => (asked ??= (state.connects++, Promise.resolve(page))),
  };
  const fake = {
    serial: () => serial,
    webViews: () => (state.closed ? [] : [view]),
    close: async () => void (state.closed = true),
  };
  return { device: fake as unknown as AndroidDevice, state };
}

const realPage = { url: () => "http://tauri.localhost/" } as unknown as Page;

describe("the app's WebView page on Android", () => {
  it("is the page of the app's WebView when it has one at once", async () => {
    const first = device("emulator-5554", realPage);
    const phone = { device: first.device };
    expect(await webViewPage(phone, PID, async () => { throw new Error("not asked"); })).toBe(realPage);
    expect(phone.device).toBe(first.device);
    expect(first.state.closed).toBe(false);
  });

  it("is asked again on the device taken again when the WebView had no page yet, not handed back undefined", async () => {
    const first = device("emulator-5554", undefined);
    const second = device("emulator-5554", realPage);
    const other = device("emulator-5556", realPage);
    const phone = { device: first.device };
    const page = await webViewPage(phone, PID, async () => [other.device, second.device]);
    expect(page).toBe(realPage);
    expect(first.state.closed, "the device whose view kept no page is closed").toBe(true);
    expect(phone.device, "the run goes on with the device taken again").toBe(second.device);
    expect(other.state.connects).toBe(0);
  });

  it("says so when the device is gone once taken again", async () => {
    const phone = { device: device("emulator-5554", undefined).device };
    await expect(webViewPage(phone, PID, async () => [])).rejects.toThrow(/no device emulator-5554 after closing it/);
  });
});
