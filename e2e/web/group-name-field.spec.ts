import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * A group's name field keeps a name to what a group takes (64 characters) by itself, not with `maxLength`
 * (useGroupNameField). In a real Chromium, as a field with `maxLength` would: a word composed with an IME goes in
 * whole or not at all.
 */
const FULL = 64;

async function newGroupName(page: Page) {
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  const input = page.getByTestId("new-group-name");
  await expect(input).toBeFocused();
  return input;
}

test("a word composed with an IME at the end of a group name goes in whole if it fits, else not at all", { tag: ["@feature:groups.create"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  const input = await newGroupName(page);
  const cdp = await page.context().newCDPSession(page);
  const compose = async () => {
    const seen: string[] = [];
    for (const text of ["に", "にほ", "日本"]) {
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      seen.push(await input.inputValue());
    }
    await cdp.send("Input.insertText", { text: "日本" });
    return seen;
  };
  // One character left: shown whole while composed, then left out.
  await input.fill("x".repeat(FULL - 1));
  expect((await compose()).map(v => v.slice(FULL - 1))).toEqual(["に", "にほ", "日本"]);
  await expect(input).toHaveValue("x".repeat(FULL - 1));
  // Two left: it goes in.
  await page.keyboard.press("Backspace");
  await compose();
  await expect(input).toHaveValue(`${"x".repeat(FULL - 2)}日本`);
});
