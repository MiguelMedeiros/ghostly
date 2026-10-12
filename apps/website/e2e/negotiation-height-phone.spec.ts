import { expect, test } from "@playwright/test";

/**
 * The negotiation loop on /developers (components/dev/Negotiation.tsx) plays four scenarios by itself. On a phone the
 * tiles stack, and each scenario and each of its phases had a height of its own (795 to 1148 px at 375 px wide), so
 * the page below the loop jumped every two seconds under a reader who was not touching it. A link to a section below
 * it landed past its heading too: the smooth scroll to the anchor crosses the loop, which starts playing and shrinks
 * under it.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
});

test("the negotiation loop keeps one height through its four scenarios", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/developers");
  const ng = page.locator(".ng");
  await ng.evaluate((el) => {
    document.documentElement.style.scrollBehavior = "auto";
    el.scrollIntoView({ block: "start" });
  });
  // The loop starts from the first scenario once it is on screen.
  await expect(ng.locator(".ng-tab").first()).toHaveAttribute("aria-pressed", "true");

  // One full loop (4 x 7.6 s) and a little more, read at every frame: the loop's height, where the next section
  // starts under it, and which scenario plays.
  const seen = await page.evaluate(
    () =>
      new Promise<{ heights: number[]; below: number[]; scenarios: number[] }>((resolve) => {
        const el = document.querySelector(".ng")!;
        const next = document.querySelector("#path")!;
        const tabs = [...el.querySelectorAll(".ng-tab")];
        const heights = new Set<number>();
        const below = new Set<number>();
        const scenarios = new Set<number>();
        const end = performance.now() + 32_000;
        const frame = () => {
          const box = el.getBoundingClientRect();
          heights.add(Math.round(box.height));
          below.add(Math.round(next.getBoundingClientRect().top - box.top));
          scenarios.add(tabs.findIndex((tab) => tab.getAttribute("aria-pressed") === "true"));
          if (performance.now() < end) requestAnimationFrame(frame);
          else resolve({ heights: [...heights], below: [...below], scenarios: [...scenarios].sort() });
        };
        frame();
      }),
  );
  expect(seen.scenarios).toEqual([0, 1, 2, 3]);
  expect(seen.heights).toHaveLength(1);
  expect(seen.below).toHaveLength(1);
});

test("a link to the section after the loop lands on its heading", async ({ page }) => {
  await page.goto("/developers", { waitUntil: "networkidle" });
  // From the top of the page, as a link to the anchor does: the smooth scroll passes over the loop.
  await page.evaluate(() => {
    location.hash = "path";
  });
  const top = () => page.locator("#path").evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // The scroll has come to rest: the same place twice, half a second apart, away from where it began.
  let last = await top();
  await expect
    .poll(async () => {
      const now = await top();
      const rested = now === last && now < 812;
      last = now;
      return rested;
    }, { intervals: [500] })
    .toBe(true);
  // Under the 64 px nav, not above the screen's top.
  expect(last).toBeGreaterThanOrEqual(64);
  expect(last).toBeLessThan(200);
});
