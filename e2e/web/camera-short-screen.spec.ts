import type { Page } from "@playwright/test";
import { composerRow } from "../support/composer";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * The composer's camera on a short screen: a small window on its side, a window at 200% zoom. The 16:9 picture took its
 * height from its width, so the dialog was taller than the window with nothing to scroll: Close ran off the top and the
 * shutter off the bottom. Measured: every part of the dialog that is cut by the window's top or bottom.
 */
const cut = (page: Page) => page.getByTestId("camera-capture").evaluate((dialog) => {
  const height = window.innerHeight;
  return [dialog, ...dialog.querySelectorAll("video, img, button")].map((part) => [part, part.getBoundingClientRect()] as const)
    .filter(([, r]) => r.top < 0 || r.bottom > height)
    .map(([part, r]) => `${part.getAttribute("data-testid") ?? part.getAttribute("aria-label")} at ${Math.round(r.top)}..${Math.round(r.bottom)} of ${height}`);
});

for (const side of [{ width: 568, height: 320 }, { width: 667, height: 375 }, { width: 320, height: 568 }]) {
  test(`the camera at ${side.width}x${side.height}: the picture gives way, and Close, the shutter, Retake and Send are on the screen and work`, { tag: ["@feature:app.composer.attach", "@feature:app.responsive"] }, async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("camera-short-alice"), peer("camera-short-bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    const page = alice.page;
    await page.setViewportSize(side);
    await (await composerRow(page, "composer-camera")).click();

    const video = page.getByTestId("camera-video");
    await expect(video).toHaveJSProperty("readyState", 4);
    await expect.poll(() => cut(page), "the live picture").toEqual([]);
    expect((await video.boundingBox())!.height, "there is still a picture to aim with").toBeGreaterThan(100);

    await page.getByTestId("camera-shutter").click();
    await expect(page.getByTestId("camera-photo")).toBeVisible();
    await expect.poll(() => cut(page), "the photo").toEqual([]);
    await page.getByTestId("camera-retake").click();
    await expect(video).toHaveJSProperty("readyState", 4);

    await page.getByRole("button", { name: "Close camera" }).click();
    await expect(page.getByTestId("camera-capture")).toHaveCount(0);
  });
}
