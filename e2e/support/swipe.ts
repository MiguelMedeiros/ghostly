import type { BrowserContext, Locator } from "@playwright/test";

/**
 * A finger on `target`, dragged sideways by `share` of its width, held still, then lifted: touch events, as a phone
 * sends them. Not `Input.synthesizeScrollGesture`: on Linux (CI) its touch gesture sends no touchmove and scrolls
 * nothing. Held before lifting so the release has no speed: a snapping track comes to rest where the snap alone says.
 */
export async function swipe(context: BrowserContext, target: Locator, share: number): Promise<void> {
  const page = target.page();
  const box = (await target.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2, dx = box.width * share;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at === undefined ? [] : [{ x: at, y }] });
  await touch("touchStart", x);
  for (let step = 1; step <= 12; step++) await touch("touchMove", x + (dx * step) / 12);
  for (let still = 0; still < 4; still++) { await page.waitForTimeout(50); await touch("touchMove", x + dx); }
  await touch("touchEnd");
  await cdp.detach();
}
