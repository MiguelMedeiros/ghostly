import { expect, test, type Locator } from "@playwright/test";

/**
 * The keyboard's focus ring (app/site.css: 2px of cyan) is drawn at full strength on the two controls that dimmed it:
 * an end button of the protocol steps (aria-disabled, faded but still focusable) and an item of the nav's Ways to open
 * Ghostly menu. Faded with its button, the ring was about 2.5:1 against the page; the menu items drew none, only a cyan
 * title (1.56:1 against the white one).
 */

/** The ring as drawn: its style, and the opacity everything on its way to the page multiplies it by. */
function ring(el: Locator) {
  return el.evaluate((node) => {
    const s = getComputedStyle(node);
    let opacity = 1;
    for (let e: Element | null = node; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    return { focusVisible: node.matches(":focus-visible"), style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, opacity };
  });
}

test("Previous on the first step keeps a full ring and still looks unavailable", async ({ page }) => {
  await page.goto("/developers");
  const prev = page.locator(".psx-btn[data-action=prev]").first();
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Tab");
  await prev.focus();
  expect(await ring(prev)).toEqual({ focusVisible: true, style: "solid", width: 2, color: "rgb(34, 211, 238)", opacity: 1 });
  // Its arrow and word stay faded, as they are before the focus.
  for (const opacity of await prev.locator(":scope > *").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity))) expect(opacity).toBe("0.4");
});

test("Next on the last step keeps a full ring", async ({ page }) => {
  await page.goto("/developers");
  const next = page.locator(".psx-btn[data-action=next]").first();
  await expect(next).toBeEnabled();
  for (let i = 0; i < 20 && (await next.getAttribute("aria-disabled")) !== "true"; i++) await next.click();
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Tab");
  await next.focus();
  expect(await ring(next)).toEqual({ focusVisible: true, style: "solid", width: 2, color: "rgb(34, 211, 238)", opacity: 1 });
});

test("an item of the Ways to open Ghostly menu shows the ring inside the menu", async ({ page }) => {
  await page.goto("/developers");
  const more = page.getByRole("button", { name: "Ways to open Ghostly" });
  await expect(more).toBeEnabled();
  await more.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Ways to open Ghostly" });
  const items = menu.getByRole("menuitem");
  for (const i of [0, 1]) {
    const item = items.nth(i);
    await expect(item).toBeFocused();
    expect(await ring(item)).toEqual({ focusVisible: true, style: "solid", width: 2, color: "rgb(34, 211, 238)", opacity: 1 });
    // Drawn inside the item: the menu's 6px padding and the 2px between items hold it, it covers neither edge nor neighbour.
    expect(await item.evaluate((node) => parseFloat(getComputedStyle(node).outlineOffset))).toBeLessThanOrEqual(-2);
    await page.keyboard.press("ArrowDown");
  }
});
