import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/*
 * Folders in the chat list, by hand (apps/ui/src/hooks/useRowReorder.ts): a chat is put in a folder by dragging its
 * row onto the folder, and taken out by dragging it onto "Other chats", which folds like a folder. Real pointer
 * events here: what is under the pointer is what the browser says.
 */

const folder = (page: Page, name: string) => page.getByTestId("sidebar").getByTestId("chat-folder-section").filter({ has: page.getByTestId("chat-folder-name").getByText(name, { exact: true }) });

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-folder").click();
  await page.getByTestId("folder-name").fill(name);
  await page.getByTestId("folder-name-save").click();
  await expect(folder(page, name)).toBeVisible();
}

/** A mouse takes `row` by its middle and lets it go over the middle of `onto`, in a few steps as a hand does. */
async function drag(page: Page, row: Locator, onto: Locator): Promise<void> {
  const from = (await row.boundingBox())!, to = (await onto.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
}

test("a chat is dragged onto a folder and back out onto Other chats, which folds; a reload keeps it all", { tag: ["@feature:chats.folders"] }, async ({ peer }) => {
  const { page } = await peer("bob", { viewport: { width: 1100, height: 800 } });
  const sidebar = page.getByTestId("sidebar");
  // Two chats, each waiting for its contact: rows enough to move.
  await page.getByTestId("sidebar-new-chat").click();
  await page.getByTestId("sidebar-new-chat").click();
  await expect(sidebar.getByTestId("chat-row")).toHaveCount(2);
  await newFolder(page, "Friends");
  await newFolder(page, "Work");
  const friends = folder(page, "Friends"), work = folder(page, "Work");
  const loose = page.getByTestId("chat-folder-loose");
  await expect(loose.getByTestId("chat-row")).toHaveCount(2);

  // Over the folder the folder is marked; let go, the chat is in it, and no chat was opened by the drop.
  const at = page.url();
  await drag(page, loose.getByTestId("chat-row").first(), friends.getByTestId("chat-folder"));
  await expect(friends).toHaveAttribute("data-drop-over", "true");
  await expect(work).not.toHaveAttribute("data-drop-over", "true");
  await page.mouse.up();
  await expect(friends.getByTestId("chat-row")).toHaveCount(1);
  await expect(loose.getByTestId("chat-row")).toHaveCount(1);
  await expect(friends).not.toHaveAttribute("data-drop-over", "true");
  expect(page.url()).toBe(at);

  // From one folder to another, onto its empty section.
  await drag(page, friends.getByTestId("chat-row"), work.getByTestId("chat-folder-empty"));
  await expect(work).toHaveAttribute("data-drop-over", "true");
  await page.mouse.up();
  await expect(work.getByTestId("chat-row")).toHaveCount(1);
  await expect(friends.getByTestId("chat-folder-empty")).toBeVisible();

  // Out again, onto the heading of the chats in no folder.
  await drag(page, work.getByTestId("chat-row"), page.getByTestId("chat-folder-others"));
  await expect(loose).toHaveAttribute("data-drop-over", "true");
  await page.mouse.up();
  await expect(loose.getByTestId("chat-row")).toHaveCount(2);

  // Escape puts a row in the hand back.
  await drag(page, loose.getByTestId("chat-row").first(), friends.getByTestId("chat-folder"));
  await expect(friends).toHaveAttribute("data-drop-over", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(loose.getByTestId("chat-row")).toHaveCount(2);
  await expect(friends.getByTestId("chat-row")).toHaveCount(0);

  // Other chats folds like a folder, and a reload keeps that with the rest.
  const others = page.getByTestId("chat-folder-others-toggle");
  await expect(others).toHaveAttribute("aria-expanded", "true");
  expect((await page.getByTestId("chat-folder-others").boundingBox())!.height).toBe(44);
  await others.click();
  await expect(others).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByTestId("chat-row")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("chat-folder-others-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByTestId("chat-row")).toHaveCount(0);

  // On a phone's width the headings stay inside the page.
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto("/#/");
  await expect(page.getByTestId("chat-folder-others-toggle")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId("chat-folder-others-toggle").click();
  await expect(page.getByTestId("sidebar").getByTestId("chat-row")).toHaveCount(2);
});

test("pinned chats are put in order by dragging inside a folder and inside Other chats, and a row dropped on another folder still changes folder", { tag: ["@feature:chats.folders", "@feature:chats.list.pin-order"] }, async ({ peer }) => {
  const { page } = await peer("carol", { viewport: { width: 1100, height: 800 } });
  const sidebar = page.getByTestId("sidebar");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const before = page.url();
    await page.getByTestId("sidebar-new-chat").click();
    await expect(page).not.toHaveURL(before);
    ids.push(page.url().split("/chat/")[1]!);
  }
  const row = (chat: string) => sidebar.locator(`[data-testid="chat-row"][data-chat="${chat}"]`);
  const order = (root: Locator) => root.getByTestId("chat-row").evaluateAll(list => list.map(el => (el as HTMLElement).dataset.chat!));
  for (const chat of ids) {
    await row(chat).hover();
    await row(chat).getByTestId("chat-row-pin").click();
    await expect(row(chat).getByTestId("chat-row-pinned")).toHaveCount(1);
  }
  await page.mouse.move(900, 700);
  await newFolder(page, "Friends");
  const friends = folder(page, "Friends"), loose = page.getByTestId("chat-folder-loose");
  const [a, b, c, d] = ids;
  // The newest pin is on top: d, c, b, a. Two go into the folder, two stay out.
  await drag(page, row(d), friends.getByTestId("chat-folder"));
  await page.mouse.up();
  await drag(page, row(c), friends.getByTestId("chat-folder"));
  await page.mouse.up();
  await expect.poll(() => order(friends)).toEqual([d, c]);
  await expect.poll(() => order(loose)).toEqual([b, a]);

  // Inside the folder: the top one under the other. A line shows where it lands, and the folder is not marked.
  await drag(page, row(d), row(c));
  const below = (await row(c).boundingBox())!;
  await page.mouse.move(below.x + below.width / 3, below.y + below.height - 4, { steps: 4 });
  await expect(row(c).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "after");
  await expect(friends).not.toHaveAttribute("data-drop-over", "true");
  await page.mouse.up();
  await expect.poll(() => order(friends)).toEqual([c, d]);
  await expect.poll(() => order(loose)).toEqual([b, a]);

  // Inside Other chats, with a folder in the list.
  await drag(page, row(b), row(a));
  const under = (await row(a).boundingBox())!;
  await page.mouse.move(under.x + under.width / 3, under.y + under.height - 4, { steps: 4 });
  await expect(row(a).getByTestId("chat-row-drop")).toHaveAttribute("data-edge", "after");
  await page.mouse.up();
  await expect.poll(() => order(loose)).toEqual([a, b]);
  await expect.poll(() => order(friends)).toEqual([c, d]);

  // The same drag, let go over the other part of the list, changes folder instead.
  await drag(page, row(a), friends.getByTestId("chat-folder"));
  await expect(friends).toHaveAttribute("data-drop-over", "true");
  await page.mouse.up();
  await expect.poll(() => order(loose)).toEqual([b]);
  await expect(friends.getByTestId("chat-row")).toHaveCount(3);

  await page.reload();
  await expect.poll(() => order(folder(page, "Friends"))).toHaveLength(3);
  expect((await order(folder(page, "Friends"))).filter(id => id !== a)).toEqual([c, d]);
});
