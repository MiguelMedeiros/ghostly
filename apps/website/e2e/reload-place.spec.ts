import { test } from "@playwright/test";
import { reloadKeepsLines } from "./reload-place";

/**
 * A reader who reloads the home mid-page finds what they were reading. On a touch screen the server's page has
 * the chapters in another shape and height than the page that runs (stage.tsx): the offset the browser restores
 * lands elsewhere in it.
 */
const AT = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

test.describe("a landscape tablet", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });
  for (const at of AT) {
    test(`a tablet reader ${at * 100}% down the home keeps their lines over a reload`, async ({ page }) => {
      await reloadKeepsLines(page, at);
    });
  }
});

// Where the film pins a chapter and plays it as the page scrolls, the offset is how far the film has played.
for (const at of [0.2, 0.3, 0.5, 0.8]) {
  test(`a reader with a mouse ${at * 100}% down the home keeps their lines and offset over a reload`, async ({ page }) => {
    await reloadKeepsLines(page, at, true);
  });
}
