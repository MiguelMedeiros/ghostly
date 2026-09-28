import { expect, test } from "@playwright/test";

/**
 * The map (components/dev/BlockGrid.tsx) on /roadmap and /developers: each row lists its blocks
 * available first, then planned, then research.
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
