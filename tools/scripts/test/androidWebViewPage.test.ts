import type { AndroidDevice, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/*
 * backgroundFile.spec.ts:103 failed its first run in 3 of 12 Android e2e runs on 2026-11-23 with "No WebView page of
 * tools.ghostly.app (pid N) over adb within 120 s", and no "with no page yet": the new pid's WebView was never listed.
 * Playwright's device reads its WebViews every 500 ms over adb, and the first read that fails (the emulator's adb gone
 * for a moment) closes the device for good: its list stays as it was, without the new process's WebView.
 */
describe("the app's WebView page on a device Playwright closed", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A device whose WebView list stopped at what it held when a read failed: the app's new process is never in it. */
  function closedByPlaywright(serial: string) {
    const state = { closed: false };
    const fake = { serial: () => serial, webViews: () => [], close: async () => void (state.closed = true) };
    return { device: fake as unknown as AndroidDevice, state };
  }

  it("takes the device again when it never lists the app's WebView, and gets the page there", async () => {
    const stale = closedByPlaywright("emulator-5554");
    const fresh = device("emulator-5554", realPage);
    const phone = { device: stale.device };
    const found = webViewPage(phone, PID, async () => [fresh.device]);
    const settled = found.then(() => "page", () => "failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await Promise.race([settled, "still waiting"])).toBe("page");
    expect(await found).toBe(realPage);
    expect(stale.state.closed).toBe(true);
    expect(phone.device).toBe(fresh.device);
  });

  it("takes the device again when the listed WebView's page never comes (asked of a closed device)", async () => {
    const view = { pkg: () => PKG, pid: () => PID, page: () => new Promise<Page>(() => {}) };
    const hung = { closed: false };
    const stale = { serial: () => "emulator-5554", webViews: () => [view], close: async () => void (hung.closed = true) } as unknown as AndroidDevice;
    const fresh = device("emulator-5554", realPage);
    const phone = { device: stale };
    const found = webViewPage(phone, PID, async () => [fresh.device]);
    const settled = found.then(() => "page", () => "failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await Promise.race([settled, "still waiting"])).toBe("page");
    expect(hung.closed).toBe(true);
    expect(phone.device).toBe(fresh.device);
  });

  it("does not take the device again for a WebView listed a few seconds after the start", async () => {
    const late = device("emulator-5554", realPage);
    let listed = false;
    const lateDevice = { ...late.device, serial: () => "emulator-5554", webViews: () => (listed ? late.device.webViews() : []), close: late.device.close } as unknown as AndroidDevice;
    const phone = { device: lateDevice };
    const found = webViewPage(phone, PID, async () => { throw new Error("not asked"); });
    await vi.advanceTimersByTimeAsync(5_000);
    listed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await found).toBe(realPage);
    expect(phone.device).toBe(lateDevice);
    expect(late.state.closed).toBe(false);
  });
});
