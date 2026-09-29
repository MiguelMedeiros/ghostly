import { expect, test } from "../support/fixtures";

/**
 * The web app finds out it is out of date by asking its own origin what it
 * serves. Nothing is applied on its own: a reload ends the peer and every call
 * it holds, so it waits for the button.
 */

const NEWER = JSON.stringify({ version: "9.9.9", build: "newer" });

test("offers the new version, and reloads into it when asked", { tag: ["@feature:app.updates.web"] }, async ({ peer }) => {
  const { page } = await peer("alice");

  let serving = NEWER;
  await page.route("**/version.json", (route) => route.fulfill({ contentType: "application/json", body: serving }));
  await page.reload();

  const banner = page.getByTestId("update-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("9.9.9");

  // The reload lands on what the server now serves, and there is nothing left to offer.
  serving = JSON.stringify({ version: "0.0.0", build: "same" });
  await banner.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await expect(banner).toBeHidden();
});

test("put aside, it stays aside", { tag: ["@feature:app.updates.web"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.route("**/version.json", (route) => route.fulfill({ contentType: "application/json", body: NEWER }));
  await page.reload();

  const banner = page.getByTestId("update-banner");
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Later" }).click();
  await expect(banner).toBeHidden();

  await page.reload();
  await expect(page.getByTitle("New Chat")).toBeVisible();
  await expect(banner).toBeHidden();
});

test("nothing is asked once the check is turned off", { tag: ["@feature:app.updates.web"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");

  const auto = page.getByRole("switch", { name: "Check for updates automatically" });
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "false");

  let asked = 0;
  await page.route("**/version.json", (route) => {
    asked++;
    return route.fulfill({ contentType: "application/json", body: NEWER });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("update-banner")).toBeHidden();
  expect(asked).toBe(0);

  // The button in Settings still asks, because the user pressed it.
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("update-status")).toContainText("9.9.9");
  expect(asked).toBe(1);
});
