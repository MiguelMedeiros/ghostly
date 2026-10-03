import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The pinned chats in the order their owner puts them: from the chat's ⋮ (Move up, Move down), by dragging a row with
 * the mouse, and on a phone by holding a row and dragging it. The other chats stay under them, the latest first, and
 * are neither dragged nor dropped on. The order is kept across a reload.
 */

const rows = (page: Page) => page.getByTestId("sidebar").getByTestId("chat-row");
const row = (page: Page, chat: string) => page.getByTestId("sidebar").locator(`[data-testid="chat-row"][data-chat="${chat}"]`);
const order = (page: Page) => rows(page).evaluateAll(list => list.map(el => (el as HTMLElement).dataset.chat!));
const middle = async (locator: Locator) => { const box = (await locator.boundingBox())!; return { x: box.x + box.width / 3, y: box.y + box.height / 2 }; };

/** A new chat (alone in it: nobody has to answer), and its id. */
async function newChat(page: Page): Promise<string> {
  const before = page.url();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page).toHaveURL(/#\/chat\/\w+$/);
  return page.url().split("/chat/")[1];
}

/** The open chat's ⋮, and one of its rows. */
async function options(page: Page, item: string): Promise<Locator> {
  await page.getByTestId("chat-options").click();
  return page.getByTestId("chat-options-menu").getByTestId(item);
}

test("pinned chats are put in order from the chat's menu and by dragging, and a reload keeps the order", { tag: ["@feature:chats.list.pin-order", "@feature:chats.list.pin"] }, async ({ peer }) => {
  const { page } = await peer("pin-order");
  const a = await newChat(page), b = await newChat(page), c = await newChat(page), loose = await newChat(page);
  await expect(rows(page)).toHaveCount(4);

  // Each newly pinned chat goes to the top of the pinned ones.
  for (const chat of [a, b, c]) {
    await row(page, chat).hover();
    await row(page, chat).getByTestId("chat-row-pin").click();
    await expect(row(page, chat).getByTestId("chat-row-pinned")).toHaveCount(1);
  }
  await expect.poll(() => order(page)).toEqual([c, b, a, loose]);

  // From the ⋮ of the chat at the bottom of the pinned ones: up one place, then to the top, where Move up stops.
  await page.mouse.move(900, 700);
  await row(page, a).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${a}$`));
  await expect(await options(page, "chat-pin-down")).toBeDisabled();
  await page.getByTestId("chat-options-menu").getByTestId("chat-pin-up").click();
  await expect(page.getByTestId("chat-options-menu")).toHaveCount(0);
  await expect(page.getByTestId("chat-pin-announcement")).toHaveText("Moved to place 2 of 3 pinned chats");
  await expect.poll(() => order(page)).toEqual([c, a, b, loose]);
  await (await options(page, "chat-pin-up")).click();
  await expect.poll(() => order(page)).toEqual([a, c, b, loose]);
  const up = await options(page, "chat-pin-up");
  await expect(up).toBeDisabled();
  await expect(up).toHaveAttribute("title", "Already first");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-options-menu")).toHaveCount(0);

  // With the mouse: the top chat is dragged under the last pinned one. A line shows where it would land, and the
  // row goes no further than the pinned chats however far the pointer does.
  const from = await middle(row(page, a)), last = await middle(row(page, b)), below = await middle(row(page, loose));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, last.y, { steps: 8 });
  await expect(row(page, a)).toHaveAttribute("data-dragging", "true");
  await expect(row(page, b).getByTestId("chat-row-drop")).toBeVisible();
  await expect(row(page, b).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "after");
  await page.mouse.move(from.x, below.y + 40, { steps: 4 });
  await expect(row(page, loose).getByTestId("chat-row-drop")).toHaveCount(0);
  const held = (await row(page, a).boundingBox())!, end = (await row(page, b).boundingBox())!;
  expect(Math.abs(held.y - end.y), "the dragged row stops at the last pinned chat").toBeLessThan(2);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([c, b, a, loose]);
  await expect(page.getByTestId("chat-row-drop")).toHaveCount(0);
  await expect(row(page, a)).not.toHaveAttribute("data-dragging", "true");
  // The drop opened no chat: the one that was open still is.
  await expect(page).toHaveURL(new RegExp(`#/chat/${a}$`));

  // Up, too: the middle one to the top.
  const mid = await middle(row(page, b)), top = await middle(row(page, c));
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, top.y - 10, { steps: 8 });
  await expect(row(page, c).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "before");
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([b, c, a, loose]);

  // A chat that is not pinned is not dragged, and a plain click on a pinned row still opens it.
  const free = await middle(row(page, loose));
  await page.mouse.move(free.x, free.y);
  await page.mouse.down();
  await page.mouse.move(free.x, top.y, { steps: 8 });
  await expect(row(page, loose)).not.toHaveAttribute("data-dragging", "true");
  await page.mouse.up();
  await page.mouse.move(900, 700);
  await expect.poll(() => order(page)).toEqual([b, c, a, loose]);
  await row(page, c).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${c}$`));

  await page.reload();
  await expect.poll(() => order(page)).toEqual([b, c, a, loose]);
  await expect(page.getByTestId("chat-row-pinned")).toHaveCount(3);

  // Unpinned, a chat is back among the others by its time; pinned again, at the top.
  await (await options(page, "chat-pin-up")).click();
  await expect.poll(() => order(page)).toEqual([c, b, a, loose]);
  await row(page, b).hover();
  await row(page, b).getByTestId("chat-row-pin").click();
  await expect(row(page, b).getByTestId("chat-row-pinned")).toHaveCount(0);
  await expect.poll(async () => (await order(page)).slice(0, 2)).toEqual([c, a]);
  await row(page, b).hover();
  await row(page, b).getByTestId("chat-row-pin").click();
  await expect.poll(() => order(page)).toEqual([b, c, a, loose]);
});

/** A finger put down on `from`, held `holdMs`, dragged to `to` in steps, held a moment, and lifted. */
async function touchDrag(context: BrowserContext, page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
  await touch("touchStart", from);
  if (holdMs) await page.waitForTimeout(holdMs);
  for (let step = 1; step <= 10; step++) await touch("touchMove", { x: from.x, y: from.y + ((to.y - from.y) * step) / 10 });
  await page.waitForTimeout(80);
  await touch("touchMove", to);
  await touch("touchEnd");
  await cdp.detach();
}

test("on a phone a pinned chat is held, then dragged; a swipe still scrolls and a tap still opens", { tag: ["@feature:chats.list.pin-order", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page, context } = await peer("pin-order-phone", { mobile: true, viewport: { width: 390, height: 560 } });
  const chats: string[] = [];
  // A phone pins from the chat's ⋮; enough chats that the list scrolls.
  for (let i = 0; i < 9; i++) {
    chats.push(await newChat(page));
    if (i < 3) {
      await (await options(page, "chat-pin-toggle")).click();
      await expect(page.getByTestId("chat-options-menu")).toHaveCount(0);
    }
    await page.goto("/#/");
    await expect(rows(page)).toHaveCount(i + 1);
  }
  const [a, b, c] = chats;
  const pinned = async () => (await order(page)).slice(0, 3);
  await expect.poll(pinned).toEqual([c, b, a]);
  const list = rows(page).first().locator("xpath=..");
  const scrolled = () => list.evaluate(el => el.scrollTop);

  // A swipe that starts on a pinned row scrolls the list, and moves no chat.
  await touchDrag(context, page, await middle(row(page, a)), await middle(row(page, c)), 0);
  await expect.poll(scrolled).toBeGreaterThan(20);
  expect(await pinned()).toEqual([c, b, a]);
  await list.evaluate(el => { el.scrollTop = 0; });

  // Held, then dragged: the top chat goes to the bottom of the pinned ones, and the list stays where it is.
  await touchDrag(context, page, await middle(row(page, c)), await middle(row(page, a)), 600);
  await expect.poll(pinned).toEqual([b, a, c]);
  expect(await scrolled()).toBe(0);
  // Neither the hold nor the drop opened a chat.
  await expect(page).toHaveURL(/#\/$/);

  await page.reload();
  await expect.poll(pinned).toEqual([b, a, c]);

  // From the ⋮, in the sheet a phone shows.
  await row(page, c).tap();
  await expect(page).toHaveURL(new RegExp(`#/chat/${c}$`));
  await (await options(page, "chat-pin-up")).click();
  await page.goto("/#/");
  await expect.poll(pinned).toEqual([b, c, a]);
});
