import { expect, test, type Page } from "@playwright/test";
import { axe } from "./axe";

/**
 * The Android app on a computer: the home's download panel has its own row (the APK of the release the panel offers,
 * the install page, and a QR code that opens that page on a phone), and /android says how to install it, how it
 * updates and how to check it. The site used to offer the APK to an Android phone only, so a computer never saw it.
 */

const FINGERPRINT = "DE:9A:AB:A1:32:50:BC:4B:0D:22:0F:17:95:F2:32:FC:A1:52:31:B0:51:61:8F:A4:87:D4:C0:39:26:CE:09:50";

/** The APK's address in the release `version`, as the Release workflow names the file. */
const apk = (version: string) => `https://github.com/MiguelMedeiros/ghostly/releases/download/v${version}/ghostly-${version}-android-arm64.apk`;

/** The QR code's drawn size and whether it has modules (scripts/qr.test.mjs checks the symbol itself). */
async function qrSize(page: Page, selector: string) {
  return page.locator(selector).evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    return { width: box.width, height: box.height, dark: svg.querySelector("path")?.getAttribute("d")?.length ?? 0 };
  });
}

test("1280px: the download panel has the Android app, its version's APK, the install page and a QR code", async ({ page }) => {
  await page.goto("/#download");
  const version = ((await page.locator(".fin-panel-title .chip").textContent()) ?? "").replace(/^v/, "");
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);

  const card = page.locator(".fin-card--android");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Android" })).toBeVisible();
  const download = card.getByRole("link", { name: /Download APK/ });
  await expect(download).toHaveAttribute("href", apk(version));
  await expect(download).toContainText(`v${version}`);
  // A computer's own installer is the marked one, not the APK.
  await expect(download).not.toHaveAttribute("aria-current", "true");
  await expect(card.getByRole("link", { name: /How to install it/ })).toHaveAttribute("href", "/android");

  const qr = card.getByRole("img", { name: "QR code for ghostly.tools/android" });
  await expect(qr).toBeVisible();
  const size = await qrSize(page, ".fin-qr-code");
  expect(size.width).toBeGreaterThanOrEqual(120);
  expect(size.dark).toBeGreaterThan(0);

  // After the three desktop cards: a computer's own platforms come first.
  const order = await page.locator(".fin-cards > .fin-card").evaluateAll((cards) => cards.map((c) => c.classList.contains("fin-card--android")));
  expect(order.indexOf(true)).toBe(3);
});

test("the hero, the nav and the footer point a computer at Android too", async ({ page }) => {
  await page.goto("/");
  // A computer keeps the web app first in the hero.
  await expect(page.locator(".hero-actions .btn--primary")).toHaveAttribute("href", "https://app.ghostly.tools");
  await expect(page.locator("footer").getByRole("link", { name: "Android app" })).toHaveAttribute("href", "/android");
  const more = page.getByRole("button", { name: "Ways to open Ghostly" });
  await expect(more).toBeEnabled();
  await more.click();
  await expect(page.locator("#nav-open-menu")).toContainText("Android");
});

test("/android: the APK, three steps, the updates, the fingerprint, a QR code; nothing serious for axe", async ({ page }) => {
  await page.goto("/android");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ghostly on your Android phone.");
  const download = page.locator(".an-actions").getByRole("link", { name: /Download APK/ });
  const href = (await download.getAttribute("href")) ?? "";
  const version = /\/v(\d+\.\d+\.\d+)\//.exec(href)?.[1] ?? "";
  expect(href).toBe(apk(version));
  await expect(download).toContainText(`v${version}`);
  await expect(page.getByText("Android 8.0 or newer")).toBeVisible();

  await expect(page.locator(".an-step")).toHaveCount(3);
  await expect(page.locator(".an-steps")).toContainText("Allow from this source");
  await expect(page.getByRole("heading", { name: "It tells you when there is a new version" })).toBeVisible();
  await expect(page.locator("#verify")).toContainText(FINGERPRINT);
  await expect(page.locator("#verify")).toContainText(`apksigner verify --print-certs ghostly-${version}-android-arm64.apk`);
  await expect(page.getByRole("img", { name: "QR code for ghostly.tools/android" })).toBeVisible();

  expect(await axe(page)).toEqual([]);
});

test("/android is in the sitemap and in llms.txt", async ({ request }) => {
  expect(await (await request.get("/sitemap.xml")).text()).toContain("https://ghostly.tools/android");
  expect(await (await request.get("/llms.txt")).text()).toContain("https://ghostly.tools/android");
});

for (const size of [
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
]) {
  test(`/android at ${size.width}px: no sideways scroll; the QR code only where a phone can scan it`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/android", { waitUntil: "networkidle" });
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(doc.sw, "the page scrolls sideways").toBeLessThanOrEqual(doc.cw);
    const qr = page.locator(".an-qr");
    if (size.width > 720) await expect(qr).toBeVisible();
    else await expect(qr).toBeHidden();
  });
}
