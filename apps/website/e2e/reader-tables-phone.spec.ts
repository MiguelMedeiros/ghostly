import { expect, test } from "@playwright/test";

/**
 * A WISP's tables on a phone: a table of three or more columns stacks each row as a card, so no cell is squeezed to
 * a few words per line and each cell says its column. A two-column table keeps its columns.
 */
test("the reader stacks a wide table's rows on a phone", async ({ page }) => {
  await page.goto("/wisps/1200-marketplace");
  const tables = await page.locator(".reader-prose table").evaluateAll((els) =>
    els.map((table) => {
      const heads = [...table.querySelectorAll("thead tr > *")].map((th) => th.textContent!.trim());
      const cells = [...table.querySelectorAll("tbody td")].map((td) => ({
        width: td.getBoundingClientRect().width,
        label: getComputedStyle(td, "::before").content,
        column: heads[[...td.parentElement!.children].indexOf(td)],
      }));
      return { columns: heads.length, width: table.getBoundingClientRect().width, cells };
    }),
  );
  const wide = tables.filter((table) => table.columns >= 3);
  expect(wide.length).toBeGreaterThan(5);
  for (const table of wide)
    for (const cell of table.cells) {
      expect(cell.width).toBeGreaterThanOrEqual(table.width - 4);
      expect(cell.label).toBe(cell.column ? JSON.stringify(cell.column) : "none");
    }

  // The longest row ("Desktop" under Client | Phase 1 | Limits) was 5,313 px on a 412 px phone.
  const desktop = page.locator(".reader-prose tr", { has: page.locator("td:first-child", { hasText: /^Desktop$/ }) }).first();
  expect((await desktop.boundingBox())!.height).toBeLessThan(3000);

  // Its cells are still a table for a screen reader.
  await expect(page.getByRole("columnheader", { name: "Phase 1" }).first()).toBeAttached();
});
