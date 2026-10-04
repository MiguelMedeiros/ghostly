import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * The join page (WISP 801, Q11): a visit to ghostly.tools/#ghostly1… opens a dialog over the page,
 * the code leaves the address before anything else runs, and no request ever carries it.
 */

// WISP 801's test vector (synthetic bytes), and codes made from it: version 2 (a code that adds a device, WISP 06),
// version 3 (above every version a reader knows: a newer Ghostly's), version 0, 96 bytes.
const CODE = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";
const V2 = "ghostly1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l87xe98gx";
const V3 = "ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l878a7pr3";
const V0 = "ghostly1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l87y36t7p";
const SHORT = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tu5fqcad";
const TYPO = CODE.slice(0, 100) + (CODE[100] === "q" ? "p" : "q") + CODE.slice(101);
const APP = "https://app.ghostly.tools";
// A stretch of the code that any leak would carry.
const SECRET = CODE.slice(9, 60);

/** The web app, stood in for: the check is where the page goes and with what, not the app itself. */
async function standInApp(page: Page) {
  await page.route(`${APP}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>app</title>" }));
}

/** Every request whose address, referrer or body carries the code. */
function watchLeaks(context: BrowserContext) {
  const leaks: string[] = [];
  context.on("request", (request) => {
    const seen = [request.url(), request.headers()["referer"] ?? "", request.postData() ?? ""].join(" ").toLowerCase();
    if (seen.includes(SECRET)) leaks.push(request.url());
  });
  return leaks;
}

/** Chose the Ghostly app on an earlier visit. */
async function preferApp(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("ghostly.join.open", "app"));
}

test.describe("join page", () => {
  test("a scanned invite opens the chat in the web app by itself, and the code never leaves this browser", async ({ page, context }) => {
    const leaks = watchLeaks(context);
    await standInApp(page);
    await page.goto(`/#${CODE}`);
    const dialog = page.getByTestId("join-landing");
    await expect(dialog.getByRole("heading", { name: "You're invited to a chat" })).toBeVisible();
    // Out of the address (and so out of the history) before anything else ran.
    expect(page.url()).not.toContain("#");
    await expect(dialog.getByTestId("join-going")).toContainText(/Opening the chat in [123]/);
    await expect(dialog.getByRole("status")).toHaveText("Opening the chat in your browser in 3 seconds.");
    await expect(dialog.getByTestId("join-cancel")).toBeFocused();
    await expect(dialog.getByTestId("join-go-now")).toHaveAttribute("rel", "noreferrer");
    await expect(dialog.getByText("The invite stays in this browser. It was never sent to ghostly.tools.")).toBeVisible();
    const entries = await page.evaluate(() => history.length);
    await expect(page).toHaveURL(`${APP}/#${CODE}`, { timeout: 10_000 });
    // replace, not a new entry: Back does not come back to the countdown.
    expect(await page.evaluate(() => history.length)).toBe(entries);
    expect(leaks).toEqual([]);
  });

  test("Cancel stays on the page and offers the three ways to open it", async ({ page }) => {
    await standInApp(page);
    await page.goto(`/#${CODE}`);
    await page.getByTestId("join-cancel").click();
    const browser = page.getByTestId("join-browser");
    await expect(browser).toBeFocused();
    await expect(browser).toHaveAttribute("href", `${APP}/#${CODE}`);
    await expect(browser).toHaveAttribute("rel", "noreferrer");
    await expect(page.getByTestId("join-desktop")).toHaveText("Open in the Ghostly app");
    await expect(page.getByTestId("join-download")).toBeVisible();
    await page.waitForTimeout(4_000);
    expect(new URL(page.url()).host).not.toBe(new URL(APP).host);
    await expect(page.getByTestId("join-going")).toHaveCount(0);
  });

  test("Open now goes at once", async ({ page }) => {
    await standInApp(page);
    await page.goto(`/#${CODE}`);
    await page.getByTestId("join-go-now").click();
    await expect(page).toHaveURL(`${APP}/#${CODE}`);
  });

  test("a code in capitals, as a QR holds it, opens in lower case", async ({ page }) => {
    await standInApp(page);
    await page.goto(`/#${CODE.toUpperCase()}`);
    await expect(page.getByTestId("join-go-now")).toHaveAttribute("href", `${APP}/#${CODE}`);
    await expect(page).toHaveURL(`${APP}/#${CODE}`, { timeout: 10_000 });
  });

  test("the Ghostly app: the invite is copied, with what to do next, and this device is remembered", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/#${CODE}`);
    await page.getByTestId("join-desktop").click();
    await expect(page.getByRole("status")).toHaveText("Invite copied. In Ghostly, choose Join, then Paste.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    await expect(page.getByTestId("join-going")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("ghostly.join.open"))).toBe("app");
  });

  test("a device that chose the Ghostly app: no countdown, the app first", async ({ page }) => {
    await preferApp(page);
    await page.goto(`/#${CODE}`);
    await expect(page.getByTestId("join-landing")).toBeVisible();
    await expect(page.getByTestId("join-going")).toHaveCount(0);
    await expect(page.getByTestId("join-desktop")).toBeFocused();
    await expect(page.locator(".join-actions > .btn").first()).toHaveAttribute("data-testid", "join-desktop");
    await page.waitForTimeout(4_000);
    await expect(page.getByTestId("join-landing")).toBeVisible();
  });

  test("choosing the browser again forgets the app", async ({ page }) => {
    await preferApp(page);
    await standInApp(page);
    await page.goto(`/#${CODE}`);
    await page.getByTestId("join-browser").click();
    await expect(page).toHaveURL(`${APP}/#${CODE}`);
    await page.goto("/");
    expect(await page.evaluate(() => localStorage.getItem("ghostly.join.open"))).toBeNull();
  });

  test("download closes the dialog and goes to the downloads", async ({ page }) => {
    await page.goto(`/#${CODE}`);
    await page.getByTestId("join-download").click();
    await expect(page.getByTestId("join-landing")).toHaveCount(0);
    await expect(page).toHaveURL(/\/#download$/);
    // A plain anchor is not an invite.
    await page.reload();
    await expect(page.getByTestId("join-landing")).toHaveCount(0);
  });

  test("closing leaves the page as it was", async ({ page }) => {
    await page.goto(`/#${CODE}`);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("join-landing")).toHaveCount(0);
    await expect(page.locator("#hero")).toBeVisible();
  });

  test("a code pasted into the address bar later opens too", async ({ page }) => {
    await standInApp(page);
    await page.goto("/");
    await page.evaluate((code) => { location.hash = code; }, CODE);
    await expect(page.getByTestId("join-landing")).toBeVisible();
    expect(page.url()).not.toContain("#");
  });

  for (const [name, code, message] of [
    ["a typo", TYPO, "This code has a typo. Check it, or ask for the code again."],
    ["a newer version", V3, "This invite was made by a newer Ghostly. Update to join."],
    ["version 0", V0, "This is not a Ghostly invite."],
    ["a damaged invite", SHORT, "This invite is damaged. Ask for a new one."],
  ]) {
    test(`says why it refuses ${name}`, async ({ page }) => {
      await page.goto(`/#${code}`);
      await expect(page.getByTestId("join-refused")).toHaveText(message);
      await expect(page.getByTestId("join-browser")).toHaveCount(0);
      // A code that does not read is never handed to the web app.
      await expect(page.getByTestId("join-going")).toHaveCount(0);
      expect(page.url()).not.toContain("#");
    });
  }

  test("a code that adds a device: Open in Ghostly hands it to the web app in the fragment, never by itself, and no request carries it", async ({ page, context }) => {
    const leaks: string[] = [];
    const secret = V2.slice(9, 60);
    context.on("request", (request) => {
      const seen = [request.url(), request.headers()["referer"] ?? "", request.postData() ?? ""].join(" ").toLowerCase();
      if (seen.includes(secret)) leaks.push(request.url());
    });
    await standInApp(page);
    // In capitals, as a phone's camera opens the QR code's link.
    await page.goto(`/#${V2.toUpperCase()}`);
    const dialog = page.getByTestId("join-landing");
    await expect(dialog).toHaveAttribute("data-kind", "device");
    await expect(dialog.getByRole("heading", { name: "Add this device to your profile" })).toBeVisible();
    expect(page.url()).not.toContain("#");
    await expect(dialog.getByTestId("join-device-steps")).toHaveText("Or open Ghostly on this device, choose Add this device to another profile, and scan or paste the code.");
    const open = dialog.getByTestId("join-device-open");
    await expect(open).toHaveText("Open in Ghostly");
    await expect(open).toHaveAttribute("href", `${APP}/#${V2}`);
    // No countdown: it opens only when the person chooses it.
    await expect(dialog.getByTestId("join-going")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(new URL(page.url()).host).not.toBe(new URL(APP).host);
    await open.click();
    await page.waitForURL(`${APP}/**`);
    expect(new URL(page.url()).hash).toBe(`#${V2}`);
    expect(leaks).toEqual([]);
  });

  test("an invite link from the old /pt-br pages opens in English", async ({ page }) => {
    await standInApp(page);
    await page.goto(`/pt-br#${CODE}`);
    await expect(page.getByRole("heading", { name: "You're invited to a chat" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });
});
