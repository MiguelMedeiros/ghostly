import { expect, test } from "@playwright/test";

/**
 * The Developers page says what dev ships (components/dev/Negotiation.tsx,
 * content/developers.ts):
 *
 * - Negotiation mirrors rankTransports() in packages/core/src/pairedTransports.ts:
 *   a browser offers Iroh through a relay, and a relayed transport ranks after
 *   every direct one; nothing in common keeps the chat on the DHT.
 * - The availability map has the headless CLI column, with Bark and Fedimint
 *   left to the app.
 */

test.use({ reducedMotion: "reduce" });

test("a browser's relayed Iroh ranks after direct WebRTC", async ({ page }) => {
  await page.goto("/developers", { waitUntil: "networkidle" });
  const ng = page.locator(".ng");
  await ng.locator(".ng-tab", { hasText: "Desktop ↔ browser" }).click();
  const rows = ng.locator(".ng-result .ng-rows li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("webrtc/1");
  await expect(rows.nth(1)).toContainText("iroh/1");
  await expect(rows.nth(1).locator(".ng-relayed")).toHaveText("relayed");
});

test("nothing in common keeps the chat on the DHT", async ({ page }) => {
  await page.goto("/developers", { waitUntil: "networkidle" });
  const ng = page.locator(".ng");
  await ng.locator(".ng-tab", { hasText: "No common transport" }).click();
  await expect(ng.locator(".ng-verdict")).toHaveText("No live line");
  await expect(ng.locator(".ng-fail")).toContainText("stays on DHT text");
});

test("the availability map has the headless CLI", async ({ page }) => {
  await page.goto("/developers", { waitUntil: "networkidle" });
  const table = page.locator("table.avail");
  await expect(table.locator("thead th").last()).toHaveText("CLI");
  const cli = (name: string) => table.locator("tr", { has: page.locator("th", { hasText: name }) }).locator("td").last();
  await expect(cli("Text chat, ghostly1 invites")).toHaveText("✓");
  await expect(cli("Bark & Fedimint wallets")).toHaveText("No");
  await expect(cli("Voice calls")).toHaveText("✓");
  await expect(cli("Video calls, screen sharing")).toHaveText("No");
  await expect(page.locator(".avail-notes")).toContainText("--confirm-real");
});
