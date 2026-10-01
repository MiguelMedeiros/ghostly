import { expect, test, type Page } from "@playwright/test";

/**
 * The home on a phone (the `phone` project, a Pixel 7): one calm column. The page never scrolls sideways; both ways
 * in are full-width buttons at least 44px tall; each story chapter is one open picture (no frame) with its steps as
 * captions that take turns in one place, the next one coming by itself while the picture is on screen, and a tap on
 * a step's bar showing that step.
 */

const CHAPTERS = ["invite", "dht", "agree", "alive", "open"] as const;

async function walk(page: Page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 600) {
    await page.evaluate((y) => {
      scrollTo({ top: y, behavior: "instant" });
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, y);
  }
}

for (const width of [360, 390, 430]) {
  test(`${width}px: nothing is wider than the phone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });
    await walk(page);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide).toBeLessThanOrEqual(width);
    // The page clips sideways overflow, so also look for words and buttons cut by the edge (the wallet deck's track
    // shows the next card on purpose, and the terminal scrolls in its own box).
    const cut = await page.evaluate((width) => {
      const skip = ".sp-deck-zone, .nx-term, .rail, .sr-only, .particles";
      return [...document.querySelectorAll("main :is(h1, h2, h3, p, a.btn, li)")]
        .filter((e) => !e.closest(skip))
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && (r.left < -1 || r.right > width + 1);
        })
        .map((e) => `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 40)}"`);
    }, width);
    expect(cut, cut.join("\n")).toEqual([]);
  });
}

test("the hero's two ways in fill the column, each an easy tap", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  // Measured once the hero's opening has risen: while `.hero-actions` is still at opacity 0 a button has no box.
  const actions = page.locator(".hero-actions");
  await actions.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const column = (await page.locator(".hero-inner").boundingBox())!;
  const buttons = actions.locator(".btn");
  await expect(buttons).toHaveCount(2);
  for (const b of await buttons.all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(box.width - column.width)).toBeLessThanOrEqual(1);
  }
});

test("every chapter is one open picture with its steps taking turns", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  for (const id of CHAPTERS) {
    const section = page.locator(`#${id}.scene--phone`);
    await expect(section, `${id} is not a phone chapter`).toHaveCount(1);
    const figure = section.locator(".scene-static-figure");
    await expect(figure).toHaveCount(1);
    expect(await figure.evaluate((f) => getComputedStyle(f).borderTopWidth), `${id}: a framed picture`).toBe("0px");
    const steps = await section.locator(".scene-static-step").count();
    await expect(section.locator(".scene-progress button")).toHaveCount(steps);
    for (const bar of await section.locator(".scene-progress button").all()) expect((await bar.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // One caption shows at a time, in one place.
    const tops = await section.locator(".scene-static-step").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetTop));
    expect(new Set(tops).size, `${id}: captions stacked`).toBe(1);
  }
});

test("a chapter's next step comes by itself, and a tap on a bar shows that step", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const section = page.locator("#agree");
  // The turns run while the picture is at least half on screen. On a slow CPU the page above still grows after the
  // first scroll (the chapter ended up 475px lower, its picture 16% seen), so scroll again until it is.
  await expect(async () => {
    await section.evaluate((e) => e.scrollIntoView({ block: "start", behavior: "instant" }));
    await expect(section.locator(".scene-static-figure")).toBeInViewport({ ratio: 0.5, timeout: 1000 });
  }).toPass();
  const active = section.locator('.scene-static-step[data-active="true"]');
  await expect(active).toHaveCount(1);
  await expect(active.locator(".h-scene")).toHaveText(/Each side says/);
  await expect(active.locator(".h-scene")).toHaveText(/They keep what/, { timeout: 15_000 });
  await section.locator(".scene-progress button").nth(2).tap();
  await expect(active.locator(".h-scene")).toHaveText(/A plan both agreed/);
  await expect(section.locator('.scene-progress button[aria-current="step"]')).toHaveCount(1);
  await expect.poll(() => active.evaluate((e) => Number(getComputedStyle(e).opacity))).toBe(1);
  // Picked by the reader, a step stays: the turns stop.
  await section.locator(".scene-progress button").nth(0).tap();
  await expect(active.locator(".h-scene")).toHaveText(/Each side says/);
  await page.waitForTimeout(9_000);
  await expect(active.locator(".h-scene")).toHaveText(/Each side says/);
});
