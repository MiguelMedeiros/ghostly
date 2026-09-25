import { expect, test } from "@playwright/test";

/**
 * The join page (WISP 801, Q11): a visit to ghostly.tools/#ghostly1… opens a dialog over the page,
 * the code leaves the address before analytics load, and no request ever carries it.
 */

// WISP 801's test vector (synthetic bytes), and codes made from it: version 2, version 0, 96 bytes.
const CODE = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";
const V2 = "ghostly1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l87xe98gx";
const V0 = "ghostly1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l87y36t7p";
const SHORT = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tu5fqcad";
const TYPO = CODE.slice(0, 100) + (CODE[100] === "q" ? "p" : "q") + CODE.slice(101);
// A stretch of the code that any leak would carry.
const SECRET = CODE.slice(9, 60);

test.describe("join page", () => {
  test("offers the three ways to open an invite, and the code never leaves this browser", async ({ page, context }) => {
    const leaks: string[] = [];
    context.on("request", (request) => {
      const seen = [request.url(), request.headers()["referer"] ?? "", request.postData() ?? ""].join(" ").toLowerCase();
      if (seen.includes(SECRET)) leaks.push(request.url());
    });
    await page.goto(`/#${CODE}`);
    const dialog = page.getByTestId("join-landing");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "You're invited to a chat" })).toBeVisible();
    // Out of the address (and so out of analytics and the history) before anything else ran.
    expect(page.url()).not.toContain("#");
    await expect(dialog.getByTestId("join-browser")).toHaveAttribute("href", `https://app.ghostly.tools/#${CODE}`);
    await expect(dialog.getByTestId("join-browser")).toHaveAttribute("rel", "noreferrer");
    await expect(dialog.getByText("The invite stays in this browser. It was never sent to ghostly.tools.")).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(leaks).toEqual([]);
  });

  test("a code in capitals, as a QR holds it, opens in lower case", async ({ page }) => {
    await page.goto(`/#${CODE.toUpperCase()}`);
    await expect(page.getByTestId("join-browser")).toHaveAttribute("href", `https://app.ghostly.tools/#${CODE}`);
  });

  test("the desktop app: the invite is copied, with what to do next", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/#${CODE}`);
    await page.getByTestId("join-desktop").click();
    await expect(page.getByRole("status")).toHaveText("Invite copied. In Ghostly, choose Join, then Paste.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
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
    await page.goto("/");
    await page.evaluate((code) => { location.hash = code; }, CODE);
    await expect(page.getByTestId("join-landing")).toBeVisible();
    expect(page.url()).not.toContain("#");
  });

  for (const [name, code, message] of [
    ["a typo", TYPO, "This code has a typo. Check it, or ask for the code again."],
    ["a newer version", V2, "This invite was made by a newer Ghostly. Update to join."],
    ["version 0", V0, "This is not a Ghostly invite."],
    ["a damaged invite", SHORT, "This invite is damaged. Ask for a new one."],
  ]) {
    test(`says why it refuses ${name}`, async ({ page }) => {
      await page.goto(`/#${code}`);
      await expect(page.getByTestId("join-refused")).toHaveText(message);
      await expect(page.getByTestId("join-browser")).toHaveCount(0);
      expect(page.url()).not.toContain("#");
    });
  }

  test("in Portuguese on /pt-br", async ({ page }) => {
    await page.goto(`/pt-br#${CODE}`);
    await expect(page.getByRole("heading", { name: "Você recebeu um convite para conversar" })).toBeVisible();
    await page.goto(`/pt-br#${V2}`);
    await expect(page.getByTestId("join-refused")).toHaveText("Este convite foi criado por um Ghostly mais novo. Atualize para entrar.");
  });
});
