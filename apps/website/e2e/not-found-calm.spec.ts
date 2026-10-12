import { expect, test, type Page } from "@playwright/test";

/**
 * Reduced motion on the "page not found" page: a still, like every other page of the site. With
 * `prefers-reduced-motion: reduce` the ghost, the 404, the words and the two links are there and nothing keeps
 * moving once the page has settled: no animation running longer than a frame, and no element of the scene (the
 * ghost a timer used to move, the floating ghosts a script used to loop) in another place or at another opacity a
 * second later. Without reduced motion the scene still plays.
 */

const MISSING = "/no-such-page";

/** The names of the animations and transitions still running, as `motion-calm.spec.ts` reads them. */
function running(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => {
        if (a.playState !== "running") return false;
        const t = a.effect?.getTiming();
        return (typeof t?.duration === "number" ? t.duration : 0) > 16;
      })
      .map((a) => `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id}`),
  );
}

/** Where every element of the scene is drawn and how: one line each. */
function frame(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("main, main *")].map((el, i) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const name = `${i} <${el.tagName.toLowerCase()}> ${(el.getAttribute("class") ?? "").slice(0, 40)}`;
      return `${name}: ${s.transform} ${s.opacity} ${r.x.toFixed(2)},${r.y.toFixed(2)}`;
    }),
  );
}

test.describe(() => {
  test.use({ reducedMotion: "reduce" });
  test("reduced motion renders the 404 page as a still", async ({ page }) => {
    await page.goto(MISSING, { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveClass(/calm/);

    // The still: the ghost, the 404, the words and the two links.
    await expect(page.locator('main svg path[filter="url(#ghost-glow-404)"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go Home" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Read the WISPs" })).toBeVisible();

    await page.waitForTimeout(800);
    expect.soft(await running(page), "animations still running under reduced motion").toEqual([]);
    const before = await frame(page);
    await page.waitForTimeout(1000);
    const after = await frame(page);
    expect(after.filter((line, i) => line !== before[i]), "elements that moved within a second under reduced motion").toEqual([]);
  });
});

test.describe(() => {
  test.use({ reducedMotion: "no-preference" });
  test("the 404 page still plays without reduced motion", async ({ page }) => {
    await page.goto(MISSING, { waitUntil: "networkidle" });
    await expect(page.locator("html")).not.toHaveClass(/calm/);
    await page.waitForTimeout(800);
    for (const loop of ["searchBeam", "spin-slow", "blink", "bounce", "pulse"]) expect(await running(page), loop).toContain(loop);
    const before = await frame(page);
    await page.waitForTimeout(1000);
    const after = await frame(page);
    expect(after.filter((line, i) => line !== before[i]).length, "elements that moved within a second").toBeGreaterThan(0);
  });
});
