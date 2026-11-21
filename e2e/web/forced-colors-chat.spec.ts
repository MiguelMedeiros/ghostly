import { writeFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { chat, connect, expect, link, say, test } from "../support/fixtures";
import { keepsAnEdge } from "../support/forcedColors";
import { pair } from "../support/paired";

/**
 * Forced colors (Windows Contrast themes) replace a bubble's background with the page's, and that background was all
 * that drew it: the chat's wallpaper pattern ran under the words, and the bubble's tail kept the theme's colour on its
 * own. There a bubble keeps an edge in the theme's text colour, the wallpaper is plain and the tail is not drawn. Settings'
 * Text size preview draws its two messages the same way.
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

test("forced colors keep an edge on a large file offer's Accept and Decline", { tag: ["@feature:app.accessibility", "@feature:files.large.offer"] }, async ({ peer }, testInfo) => {
  test.setTimeout(150_000);
  const [alice, bob] = await Promise.all([peer("fc-offer-alice"), peer("fc-offer-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Over the 25 MiB a receiver takes without asking, so Bob is asked. Each answer was drawn by its fill alone.
  const path = testInfo.outputPath("photos.zip");
  writeFileSync(path, Buffer.alloc(30 * 1024 * 1024, 7));
  await alice.page.getByTestId("file-input").setInputFiles(path);
  const offer = bob.page.getByTestId("file-offer");
  await expect(offer.getByTestId("file-accept")).toBeVisible({ timeout: 60_000 });
  await bob.page.emulateMedia({ colorScheme: "dark" });
  await keepsAnEdge(bob.page, offer.getByTestId("file-accept"), "the offer's Accept");
  await keepsAnEdge(bob.page, offer.getByTestId("file-decline"), "the offer's Decline");
  await bob.page.emulateMedia({ forcedColors: "active" });
  await offer.screenshot({ path: testInfo.outputPath("forced-file-offer.png") });
});

test("forced colors draw Settings' Text size preview's messages as bubbles with an edge", { tag: ["@feature:app.accessibility", "@feature:settings.text-size"] }, async ({ peer }) => {
  const { page } = await peer("fc-preview", { mobile: true, viewport: { width: 375, height: 812 } });
  await page.getByTestId("mobile-tab-settings").click();
  await page.getByTestId("settings-open-appearance").click();
  const preview = page.getByTestId("settings-text-size-preview");
  await preview.scrollIntoViewIfNeeded();
  const bubbles = preview.locator("p");
  await expect(bubbles).toHaveCount(2);
  const edges = () => bubbles.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return { outline: style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth), color: style.outlineColor };
  }));
  expect((await edges()).map((edge) => edge.outline), "no edge in normal colours").toEqual([0, 0]);
  const box = await bubbles.first().boundingBox();

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
    for (const edge of await edges()) {
      expect.soft(edge.outline, `${scheme}: an edge`).toBeGreaterThanOrEqual(1);
      expect.soft(edge.color, `${scheme}: an edge that shows`).not.toBe("rgba(0, 0, 0, 0)");
    }
    await preview.screenshot({ path: test.info().outputPath(`preview-forced-${scheme}.png`) });
    expect(await bubbles.first().boundingBox()).toEqual(box);
  }
});
