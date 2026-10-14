import { expect, test, type Page } from "@playwright/test";

/**
 * A page of another site that opens the app (`window.open`, as a "chat with me on Ghostly" button would) keeps no
 * handle on the app's window: every location of the app's server sends Cross-Origin-Opener-Policy (apps/web/nginx.conf,
 * and apps/web/runnerPolicy.ts for the server this suite runs on). The windows the app opens itself stay its own, and
 * so does the sign-in's return page, the one address served without the header (oidc-proofs has the whole sign-in).
 */

const OTHER_SITE = "https://forum.example/";
const LOOK_ALIKE = "https://look-alike.example/";

type Holder = Window & { opened?: Window | null };

/** Pages of other sites, answered here: none of them sends an opener policy. */
async function otherSites(page: Page): Promise<void> {
  for (const site of [OTHER_SITE, LOOK_ALIKE]) {
    await page.context().route(site, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>${new URL(site).hostname}</title>` }));
  }
}

test("a page of another site that opens the app cannot point its window elsewhere", { tag: ["@feature:app.web-opener"] }, async ({ page, baseURL }) => {
  await otherSites(page);
  await page.goto(OTHER_SITE);
  const [app] = await Promise.all([
    page.context().waitForEvent("page"),
    page.evaluate((url) => { (window as Holder).opened = window.open(url); }, `${baseURL}/`),
  ]);
  await expect(app).toHaveTitle(/Ghostly/);

  // What the other site holds is a window that reads as closed, with no frames to count or post to.
  await expect.poll(() => page.evaluate(() => (window as Holder).opened?.closed), { timeout: 10_000 }).toBe(true);
  expect(await page.evaluate(() => (window as Holder).opened?.length)).toBe(0);
  // Sending it elsewhere does nothing to the app's window.
  await page.evaluate((url) => { try { (window as Holder).opened!.location.href = url; } catch { /* refused */ } }, LOOK_ALIKE);
  await page.waitForTimeout(1000);
  expect(new URL(app.url()).origin).toBe(new URL(baseURL!).origin);
  await expect(app).toHaveTitle(/Ghostly/);
  expect(await app.evaluate(() => window.opener)).toBeNull();
  // The app's page, a path of it, a file of the build, the worker and the runner: all the same.
  for (const path of ["/", "/chat/none", "/version.json", "/sw.js", "/app-frame.html", "/app-frame-net.html"]) {
    expect((await app.request.get(`${baseURL}${path}`)).headers()["cross-origin-opener-policy"], path).toBe("same-origin-allow-popups");
  }
});

test("a window the app opens itself stays the app's to point and close", { tag: ["@feature:app.web-opener"] }, async ({ page }) => {
  await otherSites(page);
  await page.goto("/");
  await expect(page).toHaveTitle(/Ghostly/);
  // As the sign-in windows are opened: blank from the click, then pointed at the provider.
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.evaluate(() => { (window as Holder).opened = window.open("about:blank", "ghostly-oidc", "popup,width=520,height=720"); }),
  ]);
  await page.evaluate((url) => { (window as Holder).opened!.location.href = url; }, OTHER_SITE);
  await popup.waitForURL(OTHER_SITE);
  expect(await page.evaluate(() => (window as Holder).opened?.closed)).toBe(false);
  await Promise.all([popup.waitForEvent("close"), page.evaluate(() => (window as Holder).opened!.close())]);
  // As the Pubky Passport window is opened: at the other site's address from the start.
  const [passport] = await Promise.all([
    page.context().waitForEvent("page"),
    page.evaluate((url) => { (window as Holder).opened = window.open(url, "pubky-passport", "popup,width=520,height=760"); }, OTHER_SITE),
  ]);
  await passport.waitForURL(OTHER_SITE);
  expect(await page.evaluate(() => (window as Holder).opened?.closed)).toBe(false);
  await Promise.all([passport.waitForEvent("close"), page.evaluate(() => (window as Holder).opened!.close())]);
});

test("the sign-in's return page, reached from the provider's page in the app's popup, stays the app's to close", { tag: ["@feature:app.web-opener", "@feature:proofs.oidc.callback.web"] }, async ({ page, baseURL }) => {
  const callback = `${baseURL}/oidc-callback.html`;
  // The provider's page sends the window back, as a sign-in's redirect does. No state: the page has nothing to hand over
  // and stays open, so what is checked is the window, not the answer.
  await page.context().route(OTHER_SITE, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>provider</title><a href="${callback}">Continue</a>` }));
  await page.goto("/");
  await expect(page).toHaveTitle(/Ghostly/);
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.evaluate(() => { (window as Holder).opened = window.open("about:blank", "ghostly-oidc", "popup,width=520,height=720"); }),
  ]);
  await page.evaluate((url) => { (window as Holder).opened!.location.href = url; }, OTHER_SITE);
  await popup.getByRole("link", { name: "Continue" }).click();
  await popup.waitForURL(callback);
  await expect(popup.getByText("Nothing to do here.")).toBeVisible();
  // Still the window the app opened: it reads as open, and the app closes it (popupWindow's close()).
  expect(await page.evaluate(() => (window as Holder).opened?.closed)).toBe(false);
  expect((await page.request.get(callback)).headers()["cross-origin-opener-policy"]).toBeUndefined();
  await Promise.all([popup.waitForEvent("close"), page.evaluate(() => (window as Holder).opened!.close())]);
});
