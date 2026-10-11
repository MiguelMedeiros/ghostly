import { expect, test } from "@playwright/test";
import { VERSION } from "../lib/release";

/**
 * The caption under an app screenshot names the release the site offers, without its patch (SHOTS_VERSION,
 * lib/release.ts): the home page's eight windows of "What happens next" and the Profile page of "Your space", and the
 * AI agents page's screens. The CLI session of "What happens next" is drawn, and says so.
 */
const SHOTS = `Ghostly ${VERSION.split(".").slice(0, 2).join(".")}`;

test("the home page's screenshots are captioned with the release's version", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#next figcaption")).toHaveText([...Array(8).fill(SHOTS), "Illustration"]);
  await expect(page.locator("#space .sp-shot figcaption")).toHaveText(SHOTS);
});

test("the AI agents page's screenshots too, and cards still come with 1.0.1", async ({ page }) => {
  await page.goto("/developers/agents");
  await expect(page.locator(".ag-shots figcaption")).toHaveText(`${SHOTS} on the web, with a bot on the CLI`);
  await expect(page.locator(".ag-version")).toContainText("Cards and buttons come with ghostly 1.0.1.");
});
