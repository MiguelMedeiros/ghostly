import { _android, type AndroidDevice, type Page } from "playwright";

export const PKG = "tools.ghostly.app";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
 */
export async function webViewPage(phone: Phone, pid: number, devices: () => Promise<AndroidDevice[]> = () => _android.devices()): Promise<Page> {
  const end = Date.now() + 120_000;
  let empty = 0;
  while (Date.now() < end) {
    const view = phone.device.webViews().find((v) => v.pkg() === PKG && v.pid() === pid);
    if (!view) {
      await sleep(250);
      continue;
    }
    const page = await view.page();
    if (page) return page;
    empty++;
    const serial = phone.device.serial();
    await phone.device.close().catch(() => {});
    const again = (await devices()).find((d) => d.serial() === serial);
    if (!again) throw new Error(`Playwright sees no device ${serial} after closing it for a WebView with no page`);
    phone.device = again;
    await sleep(500);
  }
  throw new Error(`No WebView page of ${PKG} (pid ${pid}) over adb within 120 s${empty ? ` (${empty} with no page yet, the device taken again each time)` : ""}`);
}
