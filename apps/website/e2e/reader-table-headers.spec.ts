import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * A WISP table whose first column has no title (`|   | 8 members | 16 members |`) keeps that corner as a plain cell,
 * so a screen reader hears no blank column header; a header row with no title at all is no header row.
 */
test("the reader gives an untitled table column no blank header", async ({ page }) => {
  const wisps = ["200-payments", "404-store-and-forward", "8xx-contact-links", "902-group-mesh", "903-group-community"];
  for (const wisp of [...wisps, "1100-headless", "1200-marketplace", "3xx-x401", "protocol"]) {
    await page.goto(`/wisps/${wisp}`);
    const { violations } = await new AxeBuilder({ page }).include(".reader-prose").withRules(["empty-table-header"]).analyze();
    expect(violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))), wisp).toEqual([]);
  }

  // 902: the corner is a cell, the members still head their columns.
  await page.goto("/wisps/902-group-mesh");
  const mesh = page.locator(".reader-prose table", { has: page.getByRole("columnheader", { name: "8 members", exact: true }) });
  await expect(mesh.locator("thead tr > *").first()).toHaveJSProperty("tagName", "TD");
  await expect(mesh.getByRole("columnheader")).toHaveText(["8 members", "16 members", "32 members"]);
  await expect(mesh.locator("thead td")).toHaveCSS("background-color", await mesh.locator("thead th").first().evaluate((th) => getComputedStyle(th).backgroundColor));

  // 1100: the Audio table's empty header row is gone, its first row is "Format".
  await page.goto("/wisps/1100-headless");
  const audio = page.locator(".reader-prose table", { has: page.locator("td", { hasText: /^Format$/ }) });
  await expect(audio.locator("thead")).toHaveCount(0);
  await expect(audio.locator("tr").first().locator("td").first()).toHaveText("Format");
});
