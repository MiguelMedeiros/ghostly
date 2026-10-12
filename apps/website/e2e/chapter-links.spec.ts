import { expect, test, type Page } from "@playwright/test";

/**
 * A link to a chapter of the home page's story shows the chapter. A pinned chapter fades its picture and copy in
 * over its first pixels (SceneFrame FADE), so a link that lands at its top, or the nav's height before it, shows a
 * screen with no words. Opened fresh, from the nav's "How it works", and from a WISP's "In the app" link: the
 * chapter is pinned, its panel is opaque, and its eyebrow and first step are on screen.
 */

const CHAPTERS = ["invite", "dht", "agree", "alive"];

/** What the reader has of a chapter: is it pinned, how opaque its panel is, which step shows. */
const shown = (page: Page, id: string) =>
  page.evaluate((id) => {
    const scene = document.getElementById(id)!;
    const copy = scene.querySelector<HTMLElement>(".scene-copy")!;
    const top = scene.getBoundingClientRect().top;
    const onScreen = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return !!r && r.height > 2 && r.top >= 0 && r.bottom <= innerHeight;
    };
    return {
      pinned: top <= 0 && top + scene.offsetHeight >= innerHeight,
      opacity: Number(getComputedStyle(copy).opacity),
      eyebrow: onScreen(copy.querySelector(".eyebrow")),
      step: [...copy.querySelectorAll(".scene-step")].findIndex((s) => (s as HTMLElement).dataset.active === "true"),
      title: onScreen(copy.querySelector('.scene-step[data-active="true"] .h-scene')),
    };
  }, id);

/**
 * The page scrolls there smoothly and the story's playhead plays the beats on the way (lib/playhead.ts), so the
 * chapter is given a few seconds to arrive; then it must stay.
 */
async function arrives(page: Page, id: string) {
  const there = { pinned: true, opacity: 1, eyebrow: true, step: 0, title: true };
  await expect(page.locator(`#${id}:not(.scene--static)`)).toHaveCount(1);
  await expect.poll(() => shown(page, id), { timeout: 8000 }).toEqual(there);
  await page.waitForTimeout(1000);
  expect(await shown(page, id)).toEqual(there);
}

for (const id of CHAPTERS) {
  test(`/#${id} opened fresh shows the chapter's first step`, async ({ page }) => {
    await page.goto(`/#${id}`, { waitUntil: "networkidle" });
    await arrives(page, id);
  });
}

test('the nav\'s "How it works" shows the invitation\'s first step', async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator('nav.nav-links a[href="/#story"]').click();
  await arrives(page, "invite");
});

test('a WISP\'s "In the app" link shows the chapter it names', async ({ page }) => {
  await page.goto("/wisps/800-invite-join", { waitUntil: "networkidle" });
  await page.locator('a[href="/#invite"]').first().click();
  await expect(page).toHaveURL(/\/#invite$/);
  await arrives(page, "invite");
});

test("a link to a chapter that does not fade in lands where it did", async ({ page }) => {
  // The architecture chapter keeps its picture and copy from its first pixel (seams off): its link stays at its top.
  await page.goto("/#open", { waitUntil: "networkidle" });
  await expect(page.locator("#open:not(.scene--static)")).toHaveCount(1);
  // The nav's height and 16px above it (scroll-padding-top), to the pixel the browser rounds to.
  await expect.poll(() => page.evaluate(() => Math.abs(document.getElementById("open")!.getBoundingClientRect().top - 80) <= 1.5)).toBe(true);
});
