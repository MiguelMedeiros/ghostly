import type { Locator, Page } from "@playwright/test";
import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * A message's ⋮ menu (Details, Delete message) and its delete confirmation are whole and on top: inside the window
 * and the chat's message list, and the element under every part of them is theirs, not the list's or the sidebar's.
 * Next to a wide bubble of mine the menu opens towards the chat list; the message list used to cut it off there.
 */
const WIDE = { width: 1000, height: 760 }, PHONE = { width: 390, height: 844 };
const LONG = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8";

const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: text }).last();

/**
 * Where the popover is, and whether each part of it is the topmost element there. `elementFromPoint` does not see
 * opacity, so it also waits for the fade-in to finish.
 */
const measure = (menu: Locator) => menu.evaluate((el) => {
  const box = el.getBoundingClientRect(), list = document.querySelector(".chat-wallpaper")!.getBoundingClientRect();
  const width = document.documentElement.clientWidth, height = window.innerHeight;
  const mine = (x: number, y: number) => { const hit = document.elementFromPoint(x, y); return !!hit && el.contains(hit); };
  const middle = box.top + box.height / 2;
  return {
    inWindow: box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height + 0.5,
    inList: box.left >= list.left - 0.5 && box.right <= list.right + 0.5 && box.top >= list.top - 0.5 && box.bottom <= list.bottom + 0.5,
    shown: getComputedStyle(el).opacity === "1",
    onTop: [box.left + 4, box.left + box.width / 2, box.right - 4].every((x) => mine(x, middle)) && mine(box.left + box.width / 2, box.top + 4) && mine(box.left + box.width / 2, box.bottom - 4),
  };
});

/** The popover, once its fade-in is over, is whole and on top: in the message list on a wide screen, a sheet on a phone. */
async function whole(menu: Locator, sheet: boolean, where: string): Promise<void> {
  await expect(menu).toHaveAttribute("data-menu", sheet ? "sheet" : "popover");
  await expect.poll(async () => { const { inList, ...rest } = await measure(menu); return sheet ? rest : { inList, ...rest }; }, { message: where })
    .toEqual(sheet ? { inWindow: true, shown: true, onTop: true } : { inList: true, inWindow: true, shown: true, onTop: true });
}

async function close(page: Page, menu: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

test("a message's menu and its delete confirmation are whole and on top, beside the chat list and on a phone", { tag: ["@feature:chat.paired.message-details", "@feature:chat.paired.delete-message", "@feature:app.menus"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("menu-alice"), peer("menu-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await say(alice, LONG);
  await say(bob, "short from bob");
  await expect(chat(alice).getByText("short from bob")).toBeVisible();
  const { page } = alice;

  for (const viewport of [WIDE, PHONE]) {
    await page.setViewportSize(viewport);
    const sheet = viewport === PHONE, at = `${viewport.width}px`;
    for (const [text, side] of [[LONG, "sent"], ["short from bob", "received"]] as const) {
      const message = row(page, text);
      await message.hover();
      await message.getByTestId("message-options").click();
      const menu = page.getByTestId("message-menu");
      if (!sheet && side === "sent") {
        // The case that was cut off: lined up with the ⋮'s end, the menu would start left of the message list.
        const [options, list, size] = [await message.getByTestId("message-options").boundingBox(), await chat(alice).boundingBox(), await menu.boundingBox()];
        expect(options!.x + options!.width - size!.width, "the menu would reach past the list's left edge").toBeLessThan(list!.x);
      }
      await whole(menu, sheet, `${side} message's menu at ${at}`);
      await page.screenshot({ path: testInfo.outputPath(`${side}-menu-${viewport.width}.png`) });
      await close(page, menu);

      await message.hover();
      await message.getByTestId("message-options").click();
      await page.getByTestId("message-delete").click();
      const confirm = page.getByTestId("message-delete-menu");
      await whole(confirm, sheet, `${side} message's delete confirmation at ${at}`);
      await close(page, confirm);
    }
  }
});

test("in a group too, a message's menu is whole and on top", { tag: ["@feature:chat.paired.message-details", "@feature:app.menus"] }, async ({ peer }) => {
  const alice = await peer("menu-group-alice");
  const { page } = alice;
  await page.setViewportSize(WIDE);
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Menus");
  await page.getByTestId("new-group-kind-mesh").click();
  await page.getByTestId("new-group-create").click();
  await expect(page.getByTestId("group-share-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("group-share-dialog")).toHaveCount(0);
  await say(alice, LONG);

  const message = row(page, LONG);
  await message.hover();
  await message.getByTestId("message-options").click();
  await whole(page.getByTestId("message-menu"), false, "a group message's menu");
});
