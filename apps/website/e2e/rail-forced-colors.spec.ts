import { expect, test, type Locator } from "@playwright/test";

/**
 * Forced colors (Windows high contrast) replace every background with the page's, keeping its alpha. The story rail's
 * line, its fill and its dots are backgrounds alone, and a focused dot's ring is a box-shadow, which forced colors drop:
 * the whole rail vanished there, focus on a dot included. They must stay drawn, the current dot unlike the others.
 */

type Look = { bg: string; around: string; outline: number; outlineColor: string };

/** An element's background laid over everything behind it, and what it sits on, as seen. */
const look = (el: Locator): Promise<Look> => el.evaluate((node) => {
  type RGBA = [number, number, number, number];
  const rgba = (c: string): RGBA => { const n = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (!a) return [0, 0, 0, 0];
    const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const seen = (from: Element | null): RGBA => {
    let c: RGBA = [0, 0, 0, 0];
    for (let n = from; n && c[3] < 1; n = n.parentElement) c = over(c, rgba(getComputedStyle(n).backgroundColor));
    return c[3] < 1 ? over(c, rgba(getComputedStyle(document.body).backgroundColor)) : c;
  };
  const text = (c: RGBA) => `rgb(${c.slice(0, 3).map(Math.round).join(", ")})`;
  const style = getComputedStyle(node);
  const around = seen(node.parentElement?.closest(".rail") ?? null);
  const outline = style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth);
  return { bg: text(seen(node)), around: text(around), outline, outlineColor: text(over(rgba(style.outlineColor), around)) };
});

test("forced colors keep the story rail's line, dots and a focused dot's ring drawn", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  await page.goto("/");
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  const marks = page.locator(".rail-mark");
  await expect(marks).toHaveCount(9);

  const track = await look(page.locator(".rail-track"));
  expect(track.bg, "the line against the page").not.toBe(track.around);

  // Focus a dot: the rail comes in and the dot is marked by more than its colour.
  const focused = marks.nth(2);
  await focused.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(focused).toBeFocused();
  const ring = await look(focused);
  expect(ring.outline, "a focused dot's outline").toBeGreaterThanOrEqual(1);
  expect(ring.outlineColor, "a focused dot's outline against the page").not.toBe(ring.around);
  expect(await focused.evaluate((n) => getComputedStyle(n, "::before").boxShadow), "no cyan ring left in forced colors").toBe("none");

  // Every dot shows, and the chapter you are in looks unlike the ones around it.
  await page.locator("body").focus();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const looks = await Promise.all((await marks.all()).map(async (m) => ({ current: await m.getAttribute("aria-current") === "true", ...await look(m) })));
  for (const [i, l] of looks.entries()) expect.soft(l.bg, `dot ${i} against the page`).not.toBe(l.around);
  const current = looks.filter((l) => l.current);
  expect(current).toHaveLength(1);
  for (const other of looks.filter((l) => !l.current)) expect.soft(other.bg, "the current dot against another").not.toBe(current[0].bg);
});

test("in normal colours the story rail's dots keep their size and a focused dot no outline", async ({ page }) => {
  await page.goto("/");
  const mark = page.locator(".rail-mark").nth(2);
  await expect(mark).toHaveCount(1);
  await mark.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(mark).toBeFocused();
  expect((await look(mark)).outline).toBe(0);
  expect(await mark.evaluate((n) => [n.offsetWidth, n.offsetHeight])).toEqual([5, 5]);
});
