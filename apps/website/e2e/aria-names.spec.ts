import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * A name only on an element whose role takes one: on a plain b/span/pre a screen reader drops it, so axe leaves
 * `aria-prohibited-attr` to review. What such a label said is text the reader reads (the map's arrows, the support
 * table's "No"), and a focusable code box is a named region.
 */
const PAGES = ["/", "/cli", "/android", "/developers", "/developers/agents", "/wisps/map", "/wisps/adapter-roadmap", "/wisps/400-chat"];

for (const path of PAGES) {
  test(`no name left for review on ${path}`, async ({ page }) => {
    await page.goto(path);
    const { violations, incomplete } = await new AxeBuilder({ page }).withRules(["aria-prohibited-attr"]).analyze();
    expect([...violations, ...incomplete].flatMap((r) => r.nodes.map((n) => n.target.join(" ")))).toEqual([]);
  });
}

test("the map says what each arrow means, once", async ({ page }) => {
  await page.goto("/wisps/map");
  const arrows = page.locator(".reference-diagram li b");
  expect(await arrows.count()).toBeGreaterThan(0);
  for (const said of await arrows.evaluateAll((els) => els.map((b) => b.querySelector("[aria-hidden='true']")?.textContent))) expect(said).toBe("→");
  await expect(page.locator(".reference-diagram li b .sr-only", { hasText: "connects to" }).first()).toBeAttached();
  await page.goto("/wisps/400-chat");
  await expect(page.locator(".reference-diagram li b", { hasText: "stream handshake verified first" }).first()).toHaveText("→stream handshake verified first");
});

test("a code box that scrolls is a region with its name", async ({ page }) => {
  for (const [path, name] of [["/", "Example CLI session"], ["/android", "SHA-256"]] as const) {
    await page.goto(path);
    await expect(page.getByRole("region", { name, exact: true })).toHaveAttribute("tabindex", "0");
  }
});

test("the support table reads a missing feature as not supported", async ({ page }) => {
  await page.goto("/developers");
  const cell = page.locator(".avail td .dim").first();
  await expect(cell.locator(".sr-only")).toHaveText("Not supported");
  await expect(cell.locator("[aria-hidden='true']")).toHaveText("No");
});
