import { expect, test } from "@playwright/test";
import { axe } from "./axe";

/**
 * The map (components/dev/BlockGrid.tsx) on /roadmap and /developers: each row lists its blocks
 * available first, then planned, then research. A block that is not lit (on /roadmap, one that is not built yet) is
 * quieter, and its name and level still read at AA contrast.
 */

const ORDER = ["available", "planned", "research"];

for (const path of ["/roadmap", "/developers"]) {
  test(`${path}: every row of the map goes from available to planned to research`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const rows = page.locator(".bgrid-row");
    expect(await rows.count()).toBeGreaterThan(0);
    const found = await rows.evaluateAll((all) =>
      all.map((row) => ({
        dim: row.querySelector(".bgrid-dim")?.textContent?.trim() ?? "",
        levels: [...row.querySelectorAll(".bgrid-block")].map((b) => b.getAttribute("data-level") ?? ""),
      })),
    );
    for (const { dim, levels } of found) {
      expect(levels.length, `${dim} has blocks`).toBeGreaterThan(0);
      const ranks = levels.map((l) => ORDER.indexOf(l));
      expect(ranks.every((r) => r >= 0), `${dim}: known levels (${levels.join(", ")})`).toBe(true);
      expect(ranks, `${dim}: ${levels.join(", ")}`).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
}

for (const path of ["/roadmap", "/developers"]) {
  test(`${path}: Close on a block's details hands the keyboard focus back to the block`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    // Once React runs (the nav's chevron is disabled until then): before that a block opens nothing.
    await expect(page.locator(".nav-open-more")).toBeEnabled({ timeout: 45_000 });
    const block = page.locator(".bgrid-block").filter({ has: page.locator(".bgrid-name", { hasText: /^Tor$/ }) });
    await block.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("region", { name: "Tor" });
    await expect(details).toBeVisible();

    await details.locator(".bgrid-close").focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveCount(0);
    await expect(block).toHaveAttribute("aria-expanded", "false");
    await expect(block).toBeFocused();
  });
}

for (const [path, group, count] of [
  ["/roadmap", "Stages", 3],
  ["/developers", "Compositions", 4],
] as const) {
  test(`${path}: the map's ${group.toLowerCase()} are one tab stop and the arrow keys move the check`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await expect(page.locator(".nav-open-more")).toBeEnabled({ timeout: 45_000 });
    const radios = page.locator(".bgrid-controls [role=radiogroup]").getByRole("radio");
    await expect(radios).toHaveCount(count);
    const tabStops = () => radios.evaluateAll((all) => all.filter((r) => (r as HTMLElement).tabIndex >= 0).length);
    expect(await tabStops(), "tab stops").toBe(1);

    await radios.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "false");
    expect(await tabStops(), "tab stops after an arrow").toBe(1);

    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(radios.nth(count - 1), "ArrowLeft on the first wraps to the last").toBeFocused();
    await expect(radios.nth(count - 1)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Home");
    await expect(radios.nth(0)).toBeFocused();
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "true");
  });
}

test("/roadmap: axe finds nothing serious, wide or on a phone", async ({ page }) => {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/roadmap", { waitUntil: "networkidle" });
    expect(await page.locator('.bgrid-block[data-on="false"]').count(), "blocks that are not built yet").toBeGreaterThan(0);
    expect(await axe(page), `at ${width}px`).toEqual([]);
  }
});
