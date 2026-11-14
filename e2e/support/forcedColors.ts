import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

/** An element's border width and colour, and the colour of what it sits on. */
const edge = (el: Locator) => el.evaluate((node) => {
  const seen = (from: Element | null): string => {
    for (let n = from; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!/rgba\(.*, 0\)$/.test(c) && c !== "transparent") return c;
    }
    return "rgb(255, 255, 255)";
  };
  const style = getComputedStyle(node);
  return { border: parseFloat(style.borderTopWidth), borderColor: style.borderTopColor, around: seen(node.parentElement) };
});

/**
 * A button drawn by its fill alone reads as bare text in forced colors (Windows Contrast themes), where every
 * background is the page's: it keeps an edge there, against what it sits on, and shows none in normal colours.
 */
export async function keepsAnEdge(page: Page, button: Locator, name: string): Promise<void> {
  await expect(button).toBeVisible();
  await page.emulateMedia({ forcedColors: "none" });
  expect((await edge(button)).border, `${name} in normal colours`).toBe(0);
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await edge(button);
  expect.soft(forced.border, `${name}: border in forced colors`).toBeGreaterThanOrEqual(1);
  expect.soft(forced.borderColor, `${name}: border against what it sits on`).not.toBe(forced.around);
  await page.emulateMedia({ forcedColors: "none" });
}
