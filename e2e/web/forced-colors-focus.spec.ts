import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * Every Tab stop shows where the keyboard focus is, in forced colors too (Windows Contrast themes, Edge and Chrome's
 * forced colors). There the system palette replaces the page's colours and drops every `box-shadow`, so a focus mark
 * made of a Tailwind ring alone (`focus-visible:outline-none focus-visible:ring-2`) vanished: 18 of 25 stops on the
 * first-run home and 18 of 30 in Settings showed nothing. A real outline is what forced colors keeps.
 */

interface Stop { name: string; marked: boolean; style: string }

/**
 * Tabs through the page once round (until a stop comes back, at most `max` presses) and says, per stop, whether it
 * shows a focus mark: an outline of 1 px or more, a box-shadow, or an outline on the field's own frame (the chat
 * list's search draws its ring on the shape around the field, `has-[input:focus-visible]`).
 */
async function tabWalk(page: Page, max = 80): Promise<Stop[]> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); (window as unknown as { __stops?: WeakSet<Element> }).__stops = new WeakSet(); });
  const stops: Stop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const seen = (window as unknown as { __stops: WeakSet<Element> }).__stops;
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (seen.has(el)) return "again" as const;
      seen.add(el);
      const outlined = (s: CSSStyleDeclaration) => s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1;
      const own = getComputedStyle(el);
      const frame = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const marked = outlined(own) || own.boxShadow !== "none" || (!!frame && outlined(frame));
      const label = el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? (el.textContent ?? "").trim().slice(0, 30);
      return { name: `${el.tagName.toLowerCase()} "${label}"`, marked, style: `outline ${own.outlineStyle} ${own.outlineWidth}, box-shadow ${own.boxShadow}` };
    });
    if (stop === "again") break;
    if (stop) stops.push(stop);
  }
  return stops;
}

const unmarked = (stops: Stop[]) => stops.filter(s => !s.marked).map(s => `${s.name} (${s.style})`);

test("every Tab stop on the first-run home and in Settings shows the focus, in forced colors and in normal colours", { tag: ["@feature:app.keyboard", "@feature:app.theme"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const { page } = await peer("forced-focus", { viewport: { width: 1280, height: 900 } });

  // Normal colours: the first-run home, the chat list's search included (its ring is on the shape around it).
  await page.emulateMedia({ colorScheme: "dark" });
  const normal = await tabWalk(page);
  expect(normal.some(s => s.name.includes("Search chats"))).toBe(true);
  expect(unmarked(normal), `first-run home, normal colours (${normal.length} stops)`).toEqual([]);

  // Forced colors (dark, as Windows' Night sky): the system palette, no box-shadow.
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  const home = await tabWalk(page);
  expect(home.length).toBeGreaterThan(10);
  expect.soft(unmarked(home), `first-run home, forced colors (${home.length} stops)`).toEqual([]);

  // The chat list's search shows one mark in forced colors, its frame's: no second outline on the field inside.
  const search = page.getByPlaceholder("Search chats");
  await search.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const marks = await search.evaluate(el => {
    const own = getComputedStyle(el), frame = getComputedStyle(el.parentElement!);
    return { own: own.outlineStyle, frame: frame.outlineStyle, frameWidth: parseFloat(frame.outlineWidth) };
  });
  expect(marks).toEqual({ own: "none", frame: "solid", frameWidth: 2 });

  await page.goto("/#/settings");
  await expect(page.getByTestId("settings-reduce-motion")).toBeVisible();
  const settings = await tabWalk(page);
  expect(settings.length).toBeGreaterThan(10);
  expect.soft(unmarked(settings), `Settings, forced colors (${settings.length} stops)`).toEqual([]);
});

test("the option the arrow keys are on in a list of choices shows, in forced colors", { tag: ["@feature:app.keyboard", "@feature:app.theme"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  const language = page.getByTestId("settings-language");
  await language.focus();
  await page.keyboard.press("ArrowDown");
  const list = page.getByTestId("settings-language-list");
  await expect(list).toBeVisible();
  await page.keyboard.press("ArrowDown");
  // Which option the keys are on, and whether each option draws a mark of its own: an outline, or a fill unlike the list's.
  const options = await list.getByRole("option").evaluateAll((all) => all.map((el) => {
    const own = getComputedStyle(el);
    const list = getComputedStyle(el.parentElement!);
    return {
      name: el.textContent?.trim().slice(0, 20),
      active: el.hasAttribute("data-active"),
      marked: (own.outlineStyle !== "none" && parseFloat(own.outlineWidth) >= 1) || own.backgroundColor !== list.backgroundColor && own.backgroundColor !== "rgba(0, 0, 0, 0)",
    };
  }));
  const active = options.filter((o) => o.active);
  expect(active, "one option under the keys").toHaveLength(1);
  expect(active[0].marked, `${active[0].name}: marked under the keys`).toBe(true);
  expect(options.filter((o) => !o.active && o.marked), "no other option marked").toEqual([]);
  await page.keyboard.press("Escape");
});
