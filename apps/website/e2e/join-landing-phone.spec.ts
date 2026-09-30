import { devices, expect, test, type Page } from "@playwright/test";

/**
 * A phone that scans an invite QR (ghostly.tools/#GHOSTLY1…, WISP 801): the page counts down and opens the
 * chat in the web app, with Cancel in reach. The `phone` project is Android Chrome (Pixel 7); iOS Safari's
 * screen, agent and touch are emulated below on the same engine, since CI installs Chromium only.
 */

const CODE = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";
const APP = "https://app.ghostly.tools";
const SECRET = CODE.slice(9, 60);
// Playwright's device picks WebKit, which a describe cannot switch to; the rest of it applies.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iPhone } = devices["iPhone 15"];

function checks(name: string) {
  test(`${name}: a scanned QR opens the chat with no tap`, async ({ page, context }) => {
    const leaks: string[] = [];
    context.on("request", (request) => {
      const seen = [request.url(), request.headers()["referer"] ?? ""].join(" ").toLowerCase();
      if (seen.includes(SECRET)) leaks.push(request.url());
    });
    await standInApp(page);
    await page.goto(`/#${CODE.toUpperCase()}`);
    await inView(page, "join-cancel");
    await inView(page, "join-go-now");
    await expect(page).toHaveURL(`${APP}/#${CODE}`, { timeout: 10_000 });
    expect(leaks).toEqual([]);
  });

  test(`${name}: Cancel is a tap away and holds`, async ({ page }) => {
    await standInApp(page);
    await page.goto(`/#${CODE.toUpperCase()}`);
    await page.getByTestId("join-cancel").tap();
    await inView(page, "join-browser");
    await page.waitForTimeout(4_000);
    await expect(page.getByTestId("join-landing")).toBeVisible();
    expect(new URL(page.url()).host).not.toBe(new URL(APP).host);
  });
}

async function standInApp(page: Page) {
  await page.route(`${APP}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>app</title>" }));
}

/** On screen as the page opens, with no scrolling, and big enough for a finger. */
async function inView(page: Page, testId: string) {
  const target = page.getByTestId(testId);
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

test.describe("join page, Android Chrome", () => {
  checks("Android");
});

test.describe("join page, iOS Safari", () => {
  test.use(iPhone);
  checks("iPhone");
});
