import { expect, test } from "../support/fixtures";
import { iosKeyboard, keyboard } from "../support/keyboard";

/**
 * The reaction picker's search on a phone (e2e/support/keyboard.ts plays the iPhone's keyboard: the page keeps its
 * height). The picker is a sheet at the bottom of the screen, and a tap in its search brought the keyboard up over
 * it: the field and every emoji found were under the keyboard. The sheet stands on the keyboard while its field has
 * the focus, as the composer's emoji panel does.
 */
for (const phone of [{ width: 390, height: 844, keyboard: 336 }, { width: 375, height: 667, keyboard: 300 }]) {
  test(`on a phone ${phone.width}×${phone.height}: the reaction picker's search and what it found stand above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:chat.reactions", "@feature:app.emoji-picker"] }, async ({ peer }) => {
    const { page } = await peer(`react-search-${phone.width}`, { mobile: true, viewport: { width: phone.width, height: phone.height } });
    await iosKeyboard(page);
    await page.getByTitle("New Chat").first().click();
    const input = page.getByPlaceholder("Message…");
    await input.fill("react to me");
    await input.press("Enter");
    const row = page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: "react to me" }).last();
    await expect(row.getByTestId("message-react-action")).toBeAttached();
    await input.blur();

    await row.getByTestId("message-options").click();
    await page.getByTestId("message-react").click();
    await page.getByTestId("reaction-more").click();
    const picker = page.getByTestId("reaction-picker");
    await expect(picker).toHaveAttribute("data-menu", "sheet");
    const search = picker.getByTestId("expression-search");
    await search.focus();
    await keyboard(page, phone.keyboard);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
    await search.fill("heart");

    const visible = phone.height - phone.keyboard;
    // The sheet ends where the keyboard starts, below the top of the screen.
    await expect.poll(async () => { const box = (await picker.boundingBox())!; return Math.round(box.y + box.height); }).toBeLessThanOrEqual(visible + 1);
    expect((await picker.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    // The field, and two rows of what it found at least, between the two; an emoji there takes the tap.
    const field = (await search.boundingBox())!;
    expect(field.y).toBeGreaterThanOrEqual(0);
    expect(field.y + field.height).toBeLessThanOrEqual(visible);
    const found = picker.getByTestId("emoji-section-search").getByRole("button");
    const first = (await found.first().boundingBox())!;
    expect(first.y + first.height * 2, "two rows of results above the keyboard").toBeLessThanOrEqual(visible + 1);
    await test.info().attach("search with the keyboard up", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
    await found.first().click();
    await expect(picker).toHaveCount(0);
    await expect(row.getByTestId("reaction-chip")).toHaveCount(1);

    // With no field in use the sheet is at the bottom of the screen, as before.
    await keyboard(page, 0);
    await row.getByTestId("message-options").click();
    await page.getByTestId("message-react").click();
    await page.getByTestId("reaction-more").click();
    await expect.poll(async () => { const box = (await picker.boundingBox())!; return Math.round(box.y + box.height); }).toBe(phone.height);
  });
}

/**
 * On its side: two panes 874 px wide, where the picker is a popover kept inside the message list, which the keyboard
 * leaves a few px of; and 667 px, a sheet. With the search in use the picker stands in what is left above the
 * keyboard, its field and a whole row of what it found in view, and goes back inside the list once the keyboard is down.
 */
for (const phone of [{ width: 874, height: 402, keyboard: 200, menu: "popover" }, { width: 667, height: 375, keyboard: 190, menu: "sheet" }]) {
  test(`on a phone on its side ${phone.width}×${phone.height}: the reaction picker's search and a row it found stand above the keyboard`, { tag: ["@feature:app.mobile-layout", "@feature:chat.reactions", "@feature:app.emoji-picker"] }, async ({ peer }) => {
    const { page } = await peer(`react-side-${phone.width}`, { mobile: true, viewport: { width: phone.width, height: phone.height } });
    await iosKeyboard(page);
    await page.getByTitle("New Chat").first().click();
    const input = page.getByPlaceholder("Message…");
    await input.fill("react to me");
    await input.press("Enter");
    const row = page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: "react to me" }).last();
    await expect(row.getByTestId("message-react-action")).toBeAttached();
    await input.blur();

    await row.getByTestId("message-options").click();
    await page.getByTestId("message-react").click();
    await page.getByTestId("reaction-more").click();
    const picker = page.getByTestId("reaction-picker");
    await expect(picker).toHaveAttribute("data-menu", phone.menu);
    const search = picker.getByTestId("expression-search");
    await search.focus();
    await keyboard(page, phone.keyboard);
    await search.fill("heart");

    const visible = phone.height - phone.keyboard;
    const found = picker.getByTestId("emoji-section-search").getByRole("button");
    // The picker ends above the keyboard, and the field and a whole row of results are inside it and above the keyboard.
    await expect.poll(async () => {
      const box = (await picker.boundingBox())!, field = (await search.boundingBox())!, first = (await found.first().boundingBox())!;
      return box.y >= 0 && box.y + box.height <= visible + 1 && field.y >= box.y && first.y >= field.y + field.height
        && first.y + first.height <= Math.min(visible, box.y + box.height) + 1;
    }).toBe(true);
    await expect(search).toBeFocused();
    await test.info().attach("search on its side with the keyboard up", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });

    // The keyboard down (the field let go): a popover goes back inside the message list, under or over its message.
    if (phone.menu === "popover") {
      await search.blur();
      await keyboard(page, 0);
      const list = (await page.locator("[data-message-list]").boundingBox())!;
      await expect.poll(async () => { const box = (await picker.boundingBox())!; return box.y >= list.y - 1 && box.y + box.height <= list.y + list.height + 1; }).toBe(true);
    }
    await found.first().click();
    await expect(picker).toHaveCount(0);
    await expect(row.getByTestId("reaction-chip")).toHaveCount(1);
  });
}
