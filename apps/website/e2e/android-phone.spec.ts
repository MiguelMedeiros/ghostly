import { expect, test } from "@playwright/test";

/**
 * On an Android phone (the `phone` project is Android Chrome on a Pixel 7) the APK comes first: the hero's main
 * button downloads it, the web app is the second way in, the download panel leads with the Android card, and no QR
 * code is shown (a phone does not scan its own screen).
 */

const apk = /^https:\/\/github\.com\/MiguelMedeiros\/ghostly\/releases\/download\/v(\d+\.\d+\.\d+)\/ghostly-\1-android-arm64\.apk$/;

test("the hero's main button is the APK, the web app the second", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const actions = page.locator(".hero-actions");
  const primary = actions.locator(".btn--primary");
  await expect(primary).toHaveText(/Download for Android/);
  await expect(primary).toHaveAttribute("href", apk);
  await expect(actions.locator(".btn").nth(1)).toHaveAttribute("href", "https://app.ghostly.tools");
});

test("the download panel leads with the Android card, marked, without a QR code", async ({ page }) => {
  await page.goto("/#download", { waitUntil: "networkidle" });
  const first = page.locator(".fin-cards > .fin-card").first();
  await expect(first).toHaveClass(/fin-card--android/);
  const download = first.getByRole("link", { name: /Download APK/ });
  await expect(download).toHaveAttribute("href", apk);
  await expect(download).toHaveAttribute("aria-current", "true");
  await expect(first.getByRole("link", { name: /How to install it/ })).toHaveAttribute("href", "/android");
  await expect(page.locator(".fin-qr")).toHaveCount(0);
});

test("/android on the phone: the APK first, the steps, no QR code", async ({ page }) => {
  await page.goto("/android", { waitUntil: "networkidle" });
  const download = page.locator(".an-actions").getByRole("link", { name: /Download APK/ });
  await expect(download).toBeInViewport();
  await expect(download).toHaveAttribute("href", apk);
  await expect(page.locator(".an-qr")).toBeHidden();
  await expect(page.locator(".an-step")).toHaveCount(3);
});
