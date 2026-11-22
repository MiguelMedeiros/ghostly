import { devices } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * A browser with no push service (GrapheneOS's Vanadium: Chromium without Google Play services): `PushManager` is
 * there, so "Wake me while closed" is offered, but every subscription is refused with "AbortError: Registration failed
 * - push service not available". The refusal is stood in for here; the rest is the browser's own.
 */
const phone = devices["Pixel 7"]!;
test.use({ channel: "chromium", viewport: phone.viewport, userAgent: phone.userAgent, deviceScaleFactor: phone.deviceScaleFactor, isMobile: true, hasTouch: true });

const WHY = "This browser has no push service, so Ghostly can't be woken while it's closed. On GrapheneOS, install sandboxed Google Play or use another browser.";

test("no push service: the switch goes back off with why, which stays, and the next visit reads it as unavailable with Try again", { tag: ["@feature:push.wake.notify"] }, async ({ peer }) => {
  const bo = await peer("bo", { serviceWorkers: "allow" });
  await bo.context.grantPermissions(["notifications"], { origin: new URL(bo.page.url()).origin });
  await bo.context.addInitScript(() => {
    PushManager.prototype.subscribe = async function () {
      sessionStorage.setItem("qa-subscribe-tries", String(Number(sessionStorage.getItem("qa-subscribe-tries") ?? 0) + 1));
      throw new DOMException("Registration failed - push service not available", "AbortError");
    };
  });
  await bo.page.reload();
  await bo.page.goto("/#/settings/notifications");
  const wake = bo.page.getByTestId("settings-wake");
  const hint = bo.page.getByTestId("settings-wake-hint");
  const tries = () => bo.page.evaluate(() => Number(sessionStorage.getItem("qa-subscribe-tries") ?? 0));
  await wake.tap();
  await expect(hint).toHaveText(WHY);
  await expect(wake).toHaveAttribute("aria-checked", "false");
  await expect(wake).toHaveAttribute("aria-disabled", "true");
  // Still there long after.
  await bo.page.waitForTimeout(10_000);
  await expect(hint).toHaveText(WHY);
  expect(await tries()).toBe(1);

  // The app opened again: unavailable at once, and the switch tries nothing.
  await bo.page.reload();
  await expect(hint).toHaveText(WHY);
  await expect(wake).toHaveAttribute("aria-disabled", "true");
  // aria-disabled: Playwright waits for an enabled element unless forced; the person can still tap it.
  await wake.tap({ force: true });
  await bo.page.waitForTimeout(500);
  expect(await tries()).toBe(1);
  // Try again does try.
  await bo.page.getByTestId("settings-wake-retry").tap();
  await expect.poll(tries).toBe(2);
  await expect(hint).toHaveText(WHY);
  await expect(wake).toHaveAttribute("aria-checked", "false");
});
