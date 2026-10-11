import { expect, test, type Page } from "@playwright/test";

/**
 * A step button that takes the keyboard's focus is one the reader can see. A pinned chapter fades its picture and
 * copy in over its first pixels and out before the hand-off (SceneFrame FADE), and the browser brings a focused
 * button on screen at the chapter's nearest edge: Tab from a chapter's last step button to the next chapter's first
 * landed on a panel at opacity 0, on the bare backdrop. Focusing a step button brings its chapter to that step.
 */

const CHAPTERS = ["invite", "dht", "agree", "alive"];

/** A focused step button is fully opaque, itself and its ancestors together: a step at rest is outside its chapter's fades. */
const SEEN = 1;

/** The step button that has the focus: its chapter, its place, whether it can be seen, and what its chapter shows. */
const focused = (page: Page) =>
  page.evaluate((seen) => {
    const el = document.activeElement as HTMLElement | null;
    const scene = el?.closest<HTMLElement>(".scene");
    if (!el || !scene || !el.closest(".scene-progress")) return null;
    let opacity = 1;
    for (let a: HTMLElement | null = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    const r = el.getBoundingClientRect();
    const top = scene.getBoundingClientRect().top;
    return {
      chapter: scene.id,
      button: [...el.parentElement!.children].indexOf(el),
      ring: el.matches(":focus-visible"),
      seen: opacity >= seen,
      onScreen: r.top >= 0 && r.bottom <= innerHeight,
      pinned: top <= 0 && top + scene.offsetHeight >= innerHeight,
      step: [...scene.querySelectorAll(".scene-step")].findIndex((s) => (s as HTMLElement).dataset.active === "true"),
    };
  }, SEEN);

/** The page scrolls there smoothly and the playhead plays the beats on the way, so the step is given a few seconds to arrive; then it must stay. */
async function shows(page: Page, chapter: string, button: number) {
  const there = { chapter, button, ring: true, seen: true, onScreen: true, pinned: true, step: button };
  await expect.poll(() => focused(page), { timeout: 8000 }).toEqual(there);
  await page.waitForTimeout(1000);
  expect(await focused(page)).toEqual(there);
}

for (const [k, id] of CHAPTERS.entries()) {
  const next = CHAPTERS[k + 1];
  if (!next) continue;

  test(`Tab from the last step button of #${id} shows the first step of #${next}`, async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator(`#${id}:not(.scene--static)`)).toHaveCount(1);
    const last = (await page.locator(`#${id} .scene-progress button`).count()) - 1;
    await page.locator(`#${id} .scene-progress button`).nth(last).focus();
    await shows(page, id, last);
    await page.keyboard.press("Tab");
    await shows(page, next, 0);
  });

  test(`Shift+Tab from the first step button of #${next} shows the last step of #${id}`, async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator(`#${next}:not(.scene--static)`)).toHaveCount(1);
    const last = (await page.locator(`#${id} .scene-progress button`).count()) - 1;
    await page.locator(`#${next} .scene-progress button`).first().focus();
    await shows(page, next, 0);
    await page.keyboard.press("Shift+Tab");
    await shows(page, id, last);
  });
}

test("Tab along a chapter's step buttons shows each step", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator("#dht:not(.scene--static)")).toHaveCount(1);
  const n = await page.locator("#dht .scene-progress button").count();
  await page.locator("#dht .scene-progress button").first().focus();
  await shows(page, "dht", 0);
  for (let i = 1; i < n; i++) {
    await page.keyboard.press("Tab");
    await shows(page, "dht", i);
  }
});

test("a click on a step button still goes to its step", async ({ page }) => {
  await page.goto("/#invite", { waitUntil: "networkidle" });
  await expect(page.locator("#invite:not(.scene--static)")).toHaveCount(1);
  const active = () => page.locator("#invite .scene-step").evaluateAll((steps) => steps.findIndex((s) => (s as HTMLElement).dataset.active === "true"));
  await expect.poll(active, { timeout: 8000 }).toBe(0);
  await page.locator("#invite .scene-progress button").nth(2).click();
  await expect.poll(active, { timeout: 8000 }).toBe(2);
});

for (const id of CHAPTERS) {
  test(`a click on the last step button of #${id} rests on a fully opaque panel`, async ({ page }) => {
    await page.goto(`/#${id}`, { waitUntil: "networkidle" });
    await expect(page.locator(`#${id}:not(.scene--static)`)).toHaveCount(1);
    const last = (await page.locator(`#${id} .scene-progress button`).count()) - 1;
    await page.locator(`#${id} .scene-progress button`).nth(last).click();
    const rests = () =>
      page.evaluate((id) => {
        const scene = document.getElementById(id)!;
        const opacity = (sel: string) => Number(getComputedStyle(scene.querySelector(sel)!).opacity);
        return {
          step: [...scene.querySelectorAll(".scene-step")].findIndex((s) => (s as HTMLElement).dataset.active === "true"),
          copy: opacity(".scene-copy"),
          picture: opacity(".scene-visual"),
        };
      }, id);
    const there = { step: last, copy: 1, picture: 1 };
    await expect.poll(rests, { timeout: 8000 }).toEqual(there);
    await page.waitForTimeout(1000);
    expect(await rests()).toEqual(there);
  });
}
