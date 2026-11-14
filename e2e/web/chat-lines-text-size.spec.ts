import type { Locator, Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * Settings → Text size reaches a chat's small lines as it reaches its messages: the "chat created" line, "edited" in a
 * bubble, a reaction's count and a group's event line (as large as a 1:1 chat's system lines) are half again their
 * size at Huge, and none of them goes past a phone's screen.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const PHONE = { width: 390, height: 844 };

const px = (target: Locator) => target.evaluate((element) => Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10);

const row = (page: Page, text: string) => page.locator("[data-message-row]").filter({ hasText: text });

/** The page wider than the screen, or one of `targets` past its edge. */
const cut = (page: Page, targets: Locator[]) => Promise.all(targets.map((target) => target.evaluate((element) => {
  const box = element.getBoundingClientRect();
  return box.left < -0.5 || box.right > window.innerWidth + 0.5 ? `${element.getAttribute("data-testid")} at ${box.left}-${box.right}` : "";
}))).then(async (out) => [...out.filter(Boolean), ...(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth ? [`page ${document.documentElement.scrollWidth}`] : []))]);

async function textSize(page: Page, textSize: string): Promise<void> {
  await page.evaluate((textSize) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), textSize })), textSize);
  await page.reload();
}

async function react(page: Page, target: Locator, emoji: string): Promise<void> {
  await target.hover();
  await target.getByTestId("message-react-action").click();
  const bar = page.getByTestId("reaction-bar");
  await bar.locator(`[data-testid="reaction-quick"][data-emoji="${emoji}"]`).click();
  await expect(bar).toHaveCount(0);
}

async function openChat(peer: Peer): Promise<void> {
  await peer.page.goto("/#/");
  await peer.page.getByTestId("chat-row").first().click();
  await expect(chat(peer)).toBeVisible();
}

test("at Text size Huge on a phone, a chat's lines (created, edited, a reaction's count, a group's events) grow with the messages", { tag: ["@feature:settings.text-size", "@feature:app.mobile-layout", "@feature:chat.reactions", "@feature:groups.create"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("lines-alice"), peer("lines-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const page = alice.page;

  // Bob asks; both react with 👍, so Alice's chip counts 2. Alice answers, then edits her answer.
  await say(bob, "lunch at noon?");
  const his = row(page, "lunch at noon?");
  await expect(his).toBeVisible();
  await react(page, his, "👍");
  await react(bob.page, row(bob.page, "lunch at noon?"), "👍");
  const count = his.getByTestId("reaction-count");
  await expect(count).toHaveText("2", { timeout: 60_000 });
  await say(alice, "yes, at noon");
  const mine = row(page, "yes, at noon");
  await mine.hover();
  await mine.getByTestId("message-options").click();
  await page.getByTestId("message-edit").click();
  await page.getByPlaceholder("Message…").fill("yes, at half past noon");
  await page.getByPlaceholder("Message…").press("Enter");
  const edited = row(page, "half past noon").getByTestId("message-edited");
  await expect(edited).toBeVisible();
  const created = page.getByTestId("chat-created");
  const lines = { created, edited, count };
  const sizes = async () => ({ created: await px(created), edited: await px(edited), count: await px(count) });
  expect(await sizes()).toEqual({ created: 11, edited: 11, count: 11 });

  await textSize(page, "huge");
  await page.setViewportSize(PHONE);
  await openChat(alice);
  await expect(count).toHaveText("2");
  expect(await sizes()).toEqual({ created: 16.5, edited: 16.5, count: 16.5 });
  expect(await cut(page, Object.values(lines))).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("chat-huge.png") });

  // A group of her own: "Group created" as large as a 1:1 chat's system lines, at Normal and at Huge.
  await textSize(page, "default");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/");
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Lunch");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-done").click();
  const event = page.getByTestId("group-event").first().locator("span").first();
  await expect(event).toContainText("Group created");
  expect(await px(event)).toBe(12);
  await textSize(page, "huge");
  await page.setViewportSize(PHONE);
  await expect(event).toContainText("Group created");
  expect(await px(event)).toBe(18);
  expect(await cut(page, [event])).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("group-huge.png") });
});
