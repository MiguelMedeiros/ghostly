import { expect, test, type Page } from "@playwright/test";
import { holdScripts } from "./hold-scripts";

/**
 * A phone reader who scrolls into the story before the page runs keeps what they were looking at. The server draws
 * the chapters for a wide window (stage.tsx), the head script folds them into an article before the first paint,
 * and the phone chapters only replace them once React hydrates: a different height above the reader, so the story
 * jumped under them. The page's scripts are held here until the reader has scrolled.
 */

/** What is at the middle of the screen: its chapter, and the part of it (the picture, a step, the eyebrow). */
const middle = (page: Page) =>
  page.evaluate(() => {
    const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    // (Steps take no pointer: over one, the point finds their list.)
    const part = el?.closest(".scene-visual, .scene-static-figure") ? "picture" : el?.closest(".scene-steps, .scene-static-steps") ? "steps" : el?.closest(".eyebrow") ? "eyebrow" : el?.tagName;
    return `${el?.closest("section[id]")?.id ?? "-"} ${part}`;
  });

const CASES = [
  // The reader stops with a chapter's picture in the middle of the screen, or with a chapter's first step there.
  { name: "a picture", at: "#dht .scene-visual", part: "dht picture", title: null },
  { name: "a step", at: "#alive .scene-step h3", part: "alive steps", title: "#alive :is(.scene-step, .scene-static-step) h3" },
];

for (const c of CASES) {
  test(`a reader who scrolled to ${c.name} before hydration sees the same part of the story after it`, async ({ page }) => {
    const release = await holdScripts(page);
    await page.goto("/", { waitUntil: "commit" });
    await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0 && !!document.getElementById("open"));
    await expect(page.locator("#invite.scene--phone")).toHaveCount(0);

    await page.evaluate((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: "instant" });
    }, c.at);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await middle(page)).toBe(c.part);
    const titleTop = () => page.evaluate((sel) => (sel ? Math.round(document.querySelector(sel)!.getBoundingClientRect().top) : 0), c.title);
    const before = await titleTop();

    release();
    await expect(page.locator("#invite.scene--phone")).toHaveCount(1);
    await page.waitForLoadState("load");
    await page.waitForTimeout(1000);

    expect(await middle(page)).toBe(c.part);
    // The step's title the reader was on stays where it was (the phone draws it a little larger).
    expect(Math.abs((await titleTop()) - before)).toBeLessThanOrEqual(24);
  });
}

// The wallet's and the identities' decks: the server draws a place for each (a mouse's stack is shorter than a
// finger's track), and each deck measures its width as it mounts, a render after the chapters change shape.
for (const panel of ["#wallet-panel", "#identity-panel"]) {
  test(`a reader who scrolled to ${panel} before hydration finds it where it was after`, async ({ page }) => {
    const release = await holdScripts(page);
    await page.goto("/", { waitUntil: "commit" });
    await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0 && !!document.getElementById("open"));
    await expect(page.locator(".sp-deck-placeholder")).toHaveCount(2);

    await page.evaluate((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: "instant" });
    }, panel);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const top = () => page.evaluate((sel) => Math.round(document.querySelector(sel)!.getBoundingClientRect().top), panel);
    const before = await top();

    // Every frame from the release on, read once it is painted: where the panel is.
    await page.evaluate((sel) => {
      const w = window as unknown as { tops: number[] };
      w.tops = [];
      const frame = () =>
        setTimeout(() => {
          const el = document.querySelector(sel);
          if (el) w.tops.push(Math.round(el.getBoundingClientRect().top));
          if (w.tops.length < 240) requestAnimationFrame(frame);
        });
      requestAnimationFrame(frame);
    }, panel);
    release();
    await expect(page.locator(".sp-deck .deck")).toHaveCount(2);
    await page.waitForLoadState("load");
    await page.waitForTimeout(1000);

    const tops = await page.evaluate(() => (window as unknown as { tops: number[] }).tops);
    const moved = Math.max(...tops.map((t) => Math.abs(t - before)));
    expect(moved, `panel tops: ${[...new Set(tops)].join(" ")}`).toBeLessThanOrEqual(4);
  });
}
