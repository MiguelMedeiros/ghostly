import { _android, type AndroidDevice, type Page } from "playwright";

export const PKG = "tools.ghostly.app";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** How long the app's WebView may stay unlisted after its start before the device is taken again (`webViewPage`). */
const UNLISTED_MS = 15_000;

/** The device as Playwright has it for the run: taken again by `webViewPage` when a WebView's page never came. */
export interface Phone {
  device: AndroidDevice;
}

/**
 * The WebView of the app's process `pid`, not one of a process that is gone (`pm clear` kills it; the list lags).
 *
 * Its page can come back undefined: Playwright connects to the WebView's devtools socket as soon as it is listed, and
 * the connection can end before the WebView has a page (right after `pm clear` + `am start -W`), so `view.page()` is
 * `pages()[0]` of an empty context. Playwright keeps that answer for the view, and the device keeps the view while
 * the socket stays, so asking again gets nothing: only a device taken again (`_android.devices()` hands back the one
 * it has until it is closed) has new views. `phone.device` is that new device from then on.
 *
 * The view may also never be listed: Playwright's device reads the WebViews every 500 ms, and the first read that fails
 * (the emulator's adb gone for a moment) closes the device for good, its list left as it was. A view still not listed
 * after UNLISTED_MS takes the device again too.
 */
export async function webViewPage(phone: Phone, pid: number, devices: () => Promise<AndroidDevice[]> = () => _android.devices()): Promise<Page> {
  const end = Date.now() + 120_000;
  let empty = 0;
  let unlisted = 0;
  let listedBy = Date.now() + UNLISTED_MS;
  const takeAgain = async (why: string) => {
    const serial = phone.device.serial();
    await phone.device.close().catch(() => {});
    const again = (await devices()).find((d) => d.serial() === serial);
    if (!again) throw new Error(`Playwright sees no device ${serial} after closing it for ${why}`);
    phone.device = again;
    listedBy = Date.now() + UNLISTED_MS;
  };
  while (Date.now() < end) {
    const view = phone.device.webViews().find((v) => v.pkg() === PKG && v.pid() === pid);
    if (!view) {
      if (Date.now() >= listedBy) {
        unlisted++;
        await takeAgain("a WebView it did not list");
      }
      await sleep(250);
      continue;
    }
    const page = await view.page();
    if (page) return page;
    empty++;
    await takeAgain("a WebView with no page");
    await sleep(500);
  }
  const retaken = [empty && `${empty} with no page yet`, unlisted && `${unlisted} not listed`].filter(Boolean).join(", ");
  throw new Error(`No WebView page of ${PKG} (pid ${pid}) over adb within 120 s${retaken ? ` (${retaken}, the device taken again each time)` : ""}`);
}
