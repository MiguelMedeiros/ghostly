import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * Settings → Text size on an iPhone: at Huge the chat's words are half again as large (the messages, the message field,
 * the chat list's names), the header keeps its size, the bubbles grow with their text and wrap a long word, nothing goes
 * past the screen's edge, and the last message shows whole above the message field. The field stays 16px or more at
 * every size, or iOS zooms into it.
 */
test.describe.configure({ timeout: 4 * 60_000 });

const IPHONE = { width: 390, height: 844 };
const LONG_WORD = "Pneumonoultramicroscopicsilicovolcanoconiosis";

const px = (page: Page, selector: string) =>
  page.locator(selector).last().evaluate((element) => Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10);

/** What is cut or pushed out: the page wider than the screen, a bubble past its edge, a message's text wider than its box. */
const overflow = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
  for (const text of document.querySelectorAll<HTMLElement>('[data-testid="message-text"]')) {
    const box = text.getBoundingClientRect();
    if (box.right > window.innerWidth + 0.5 || box.left < -0.5) out.push(`"${text.textContent?.slice(0, 20)}" at ${box.left}-${box.right}`);
    if (text.scrollWidth > text.clientWidth + 1) out.push(`"${text.textContent?.slice(0, 20)}" ${text.scrollWidth} wide in ${text.clientWidth}`);
  }
  return out;
});

/** The last message's bubble is whole between the chat's header and the message field. */
const lastWhole = (page: Page) => page.evaluate(() => {
  const rows = document.querySelectorAll('[data-message-row]');
  const last = rows[rows.length - 1]?.querySelector('[data-testid="message-text"]')?.getBoundingClientRect();
  const list = document.querySelector("[data-message-list]")?.getBoundingClientRect();
  const field = document.querySelector(".composer-field")?.getBoundingClientRect();
  if (!last || !list || !field) return "missing";
  return last.top >= list.top - 0.5 && last.bottom <= Math.min(list.bottom, field.top) + 0.5 ? "whole" : `${last.top}-${last.bottom} in ${list.top}-${Math.min(list.bottom, field.top)}`;
});

test("at Huge on an iPhone the chat's words are larger, the header is not, and every message shows whole", { tag: ["@feature:settings.text-size", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: IPHONE });
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page;
  await say(alice, `A word longer than the screen at Huge: ${LONG_WORD}${LONG_WORD}`);
  await say(alice, "Can you read this now? It should be large enough to read without glasses.");
  await expect(chat(bob).getByText(/without glasses/)).toBeVisible();

  // Default: the sizes they always had.
  expect(await px(page, '[data-testid="message-text"]')).toBe(14.2);
  expect(await px(page, ".composer-textarea")).toBe(16);
  const header = await px(page, '[data-testid="chat-name"]');
  await page.screenshot({ path: test.info().outputPath("1-chat-default.png") });

  // Settings → Appearance → Text size: Huge, with its preview.
  await page.getByTestId("chat-back").click();
  await page.getByTestId("mobile-tab-settings").click();
  await page.getByTestId("settings-open-appearance").click();
  const slider = page.getByTestId("settings-text-size");
  await slider.scrollIntoViewIfNeeded();
  await slider.fill("4");
  await expect(page.getByTestId("settings-text-size-value")).toHaveText("Huge");
  await expect(slider).toHaveAttribute("aria-valuetext", "Huge");
  expect(await px(page, '[data-testid="settings-text-size-preview"] p')).toBe(21.3);
  await page.getByTestId("settings-text-size-row").screenshot({ path: test.info().outputPath("2-setting-huge.png") });

  // The chat list's names and last messages.
  await page.getByTestId("mobile-tab-chats").click();
  await expect(page.getByTestId("chat-row-name").first()).toBeVisible();
  expect(await px(page, '[data-testid="chat-row-name"]')).toBe(22.5);
  expect(await px(page, '[data-testid="chat-row-preview"]')).toBe(19.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath("3-chats-huge.png") });

  // The chat: larger words, the header as it was, nothing cut, the last message whole above the field.
  await page.getByTestId("chat-row").first().click();
  await expect(chat(bob).getByText(/without glasses/)).toBeVisible();
  expect(await px(page, '[data-testid="message-text"]')).toBe(21.3);
  expect(await px(page, ".composer-textarea")).toBe(22.5);
  // A long word shown as a token, and the chat's lines (joined, connected over…), larger too.
  expect(await px(page, ".rich-blob-text")).toBe(18.8);
  expect(await px(page, '[data-testid="transport-line"] button')).toBe(18);
  expect(await px(page, '[data-testid="chat-name"]')).toBe(header);
  expect(await overflow(page)).toEqual([]);
  await expect.poll(() => lastWhole(page)).toBe("whole");
  // One that arrives now, long enough to wrap over several lines, shows whole too.
  await say(alice, "And a longer one that arrives while the chat is open at Huge, so it wraps over several lines of the bubble.");
  await expect(chat(bob).getByText(/several lines of the bubble/)).toBeVisible();
  await expect.poll(() => lastWhole(page)).toBe("whole");
  expect(await overflow(page)).toEqual([]);
  // A draft of two lines in the field: its words at Huge, the field inside the screen.
  await page.getByPlaceholder("Message…").fill("Typing at Huge,\nover two lines");
  const field = (await page.locator(".composer-field").boundingBox())!;
  expect(field.x + field.width).toBeLessThanOrEqual(IPHONE.width);
  await page.screenshot({ path: test.info().outputPath("4-chat-huge.png") });

  // Kept across a reload.
  await page.reload();
  await expect(chat(bob).getByText(/without glasses/)).toBeVisible();
  expect(await px(page, '[data-testid="message-text"]')).toBe(21.3);

  // Small: the message field stays at 16px, so Safari does not zoom into it.
  await page.getByTestId("chat-back").click();
  await page.getByTestId("mobile-tab-settings").click();
  await page.getByTestId("settings-open-appearance").click();
  await page.getByTestId("settings-text-size").fill("0");
  await expect(page.getByTestId("settings-text-size-value")).toHaveText("Small");
  await page.getByTestId("mobile-tab-chats").click();
  await page.getByTestId("chat-row").first().click();
  expect(await px(page, '[data-testid="message-text"]')).toBe(12.8);
  expect(await px(page, ".composer-textarea")).toBe(16);
});
