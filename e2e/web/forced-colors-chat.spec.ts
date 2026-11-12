import type { Locator } from "@playwright/test";
import { chat, expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Forced colors (Windows Contrast themes) replace a bubble's background with the page's, and that background was all
 * that drew it: the chat's wallpaper pattern ran under the words, and the bubble's tail kept the theme's colour on its
 * own. There a bubble keeps an edge in the theme's text colour, the wallpaper is plain and the tail is not drawn.
 */

/** A bubble's edge and tail, and the wallpaper's picture behind it. */
const drawn = (bubble: Locator) => bubble.evaluate((node) => {
  const style = getComputedStyle(node);
  const tail = node.querySelector(':scope > span:has(> svg path[class*="-bg"])');
  return {
    outline: style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth),
    outlineColor: style.outlineColor,
    tail: !!tail && getComputedStyle(tail).display !== "none",
    wallpaper: getComputedStyle(node.closest(".chat-wallpaper")!).backgroundImage,
  };
});

test("forced colors draw a message's bubble with an edge, on a plain wallpaper and without its tail", { tag: ["@feature:app.accessibility", "@feature:app.theme.bubbles"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("fc-chat-alice"), peer("fc-chat-bob")]);
  await pair(alice, bob);
  await say(bob, "see you at noon");
  await say(alice, "see you there");
  const theirs = chat(alice).locator("[data-message-bubble]").filter({ hasText: "see you at noon" });
  const mine = chat(alice).locator("[data-message-bubble]").filter({ hasText: "see you there" });
  await expect(theirs).toBeVisible();
  await expect(mine).toBeVisible();
  // No animation between two reads: a bubble read while it still grows in is not where it stays.
  await alice.page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  // The first pairing's scene sits above the messages and goes 1.8 s after the chat went live (CELEBRATE_MS). Going
  // between the first box and the last, it moved the bubble up by its height, which is the scene, not forced colors.
  await expect(alice.page.getByTestId("pairing-scene")).toHaveCount(0);

  // Normal colours: the bubble is its background, with its tail, on the patterned wallpaper; no edge.
  const before = await drawn(mine);
  expect(before.outline, "no edge in normal colours").toBe(0);
  expect(before.tail, "the tail in normal colours").toBe(true);
  expect(before.wallpaper).toContain("url(");
  const box = await mine.boundingBox();

  for (const scheme of ["dark", "light"] as const) {
    await alice.page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
    for (const [name, bubble] of [["mine", mine], ["theirs", theirs]] as const) {
      const look = await drawn(bubble);
      expect.soft(look.outline, `${name} (${scheme}): an edge`).toBeGreaterThanOrEqual(1);
      expect.soft(look.outlineColor, `${name} (${scheme}): an edge that shows`).not.toBe("rgba(0, 0, 0, 0)");
      expect.soft(look.tail, `${name} (${scheme}): no tail`).toBe(false);
      expect.soft(look.wallpaper, `${name} (${scheme}): a plain wallpaper`).toBe("none");
    }
    // Nothing moves.
    expect(await mine.boundingBox()).toEqual(box);
  }
});
