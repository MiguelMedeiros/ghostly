import { expect, test, type Page } from "@playwright/test";

/**
 * A reader in the story whose window changes size (a download bar, devtools, a window snapped, a tablet turned) is
 * still in the same part of it: the chapters are sized in viewport heights and the scroll in pixels, and the
 * browser's scroll anchoring does not act inside them, so the page holds the place itself (KeepPlace).
 */

const CHAPTERS = ["invite", "dht", "agree", "alive", "open"] as const;

/** The chapter at the middle of the screen, and how far through its scroll the reader is (0…1). */
function place(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ id: string; at: number }>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const section = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("section[id]");
            if (!section) return done({ id: "-", at: NaN });
            const top = section.getBoundingClientRect().top + scrollY;
            const travel = Math.max(1, (section as HTMLElement).offsetHeight - innerHeight);
            done({ id: section.id, at: (scrollY - top) / travel });
          }),
        ),
      ),
  );
}

/** Scrolls the middle of the screen to `at` of the chapter's height (for a film chapter, `at` of its scroll too). */
async function into(page: Page, id: string, at: number) {
  await page.evaluate(
    ([id, at]) => {
      const el = document.getElementById(id as string)!;
      const top = el.getBoundingClientRect().top + scrollY;
      scrollTo({ top: top + (at as number) * el.offsetHeight - innerHeight / 2, behavior: "instant" });
    },
    [id, at] as const,
  );
}

/** A new window size, once the page has had its resize event (a scroll before it would be taken back). */
async function size(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function open(page: Page, width: number, height: number) {
  await size(page, width, height);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
}

test.describe("a window that changes size", () => {
  for (const [from, to] of [
    [[1280, 900], [1280, 800]],
    [[1280, 900], [900, 1280]],
  ] as const) {
    test(`${from.join("x")} → ${to.join("x")}: the reader stays at the same point of the same chapter`, async ({ page }) => {
      await open(page, ...from);
      for (const id of CHAPTERS) {
        await size(page, ...from);
        await into(page, id, 0.5);
        const before = await place(page);
        expect(before.id).toBe(id);
        await size(page, ...to);
        const after = await place(page);
        expect(after.id, `${id} after the resize`).toBe(id);
        expect(Math.abs(after.at - before.at), `${id}: ${before.at.toFixed(3)} → ${after.at.toFixed(3)}`).toBeLessThan(0.02);
      }
    });
  }

  test("1024x768 → 768x1024 (the chapters become cards): the reader stays in the same chapter", async ({ page }) => {
    for (const id of CHAPTERS) {
      await open(page, 1024, 768);
      await into(page, id, 0.5);
      expect((await place(page)).id).toBe(id);
      await size(page, 768, 1024);
      await page.waitForTimeout(300);
      expect((await place(page)).id, `${id} after the resize`).toBe(id);
    }
  });
});

test.describe("a touch tablet turned", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("1024x768 → 768x1024: the reader stays in the same chapter", async ({ page }) => {
    for (const id of CHAPTERS) {
      await open(page, 1024, 768);
      await into(page, id, 0.5);
      expect((await place(page)).id).toBe(id);
      await size(page, 768, 1024);
      await page.waitForTimeout(300);
      expect((await place(page)).id, `${id} after the turn`).toBe(id);
    }
  });
});
