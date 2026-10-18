import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * A group's name field keeps a name to what a group takes (64 characters) by itself, not with `maxLength`
 * (useGroupNameField). In a real Chromium, as a field with `maxLength` would: a keystroke into a full name is refused
 * without emptying the browser's undo history, and a word composed with an IME goes in whole or not at all.
 */
const FULL = 64;

async function newGroupName(page: Page) {
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  const input = page.getByTestId("new-group-name");
  await expect(input).toBeFocused();
  return input;
}

test("Ctrl+Z after a keystroke a full group name refused undoes the last edit that went in", { tag: ["@feature:groups.create"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  const input = await newGroupName(page);
  // The control: a plain field with maxLength, in the same dialog, given the same keys.
  await page.getByTestId("new-group-dialog").evaluate((dialog, full) => {
    const control = document.createElement("input");
    control.maxLength = full; control.dataset.testid = "control";
    dialog.append(control);
  }, FULL);
  const control = page.getByTestId("control");
  const caret = (at: "end" | number) => page.evaluate(at => {
    const el = document.activeElement as HTMLInputElement, to = at === "end" ? el.value.length : at;
    el.setSelectionRange(to, to);
  }, at);
  const undone: string[] = [];
  for (const field of [control, input]) {
    await field.fill("x".repeat(FULL - 1));
    await caret("end");
    await page.keyboard.type("A");
    await expect(field).toHaveValue(`${"x".repeat(FULL - 1)}A`);
    // Into the middle, then at the end: both refused, the name full.
    await caret(10);
    await page.keyboard.type("B");
    await caret("end");
    await page.keyboard.type("C");
    await expect(field).toHaveValue(`${"x".repeat(FULL - 1)}A`);
    await page.keyboard.press("ControlOrMeta+z");
    undone.push(await field.inputValue());
  }
  // The A went out of the control, as it goes out of the name.
  expect(undone[0]).not.toBe(`${"x".repeat(FULL - 1)}A`);
  expect(undone[1]).toBe(undone[0]);
});

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
