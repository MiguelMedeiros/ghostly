import { test } from "@playwright/test";
import { reloadKeepsLines } from "./reload-place";

/**
 * A phone reader who reloads the home mid-page finds what they were reading, not the spot the old offset is at in
 * the server's page, whose chapters have another height (stage.tsx).
 */
for (const at of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  test(`a phone reader ${at * 100}% down the home keeps their lines over a reload`, async ({ page }) => {
    await reloadKeepsLines(page, at);
  });
}
