import { expect, test } from "../support/fixtures";

/**
 * A group's header on a phone: the line under the name (members, and how the group is reached) is cut short with an
 * ellipsis where the header's buttons begin. It used to run on under the connection icon: its width was 60% of the
 * screen, wider than what the buttons leave on a phone. The narrowest phone (320px), where even "1 member ·
 * connecting…" does not fit; wider ones see it with the longer lines ("your app relays for others").
 */
test("on a phone the group's member line stops before the header's buttons", { tag: ["@feature:app.mobile-layout", "@feature:groups.community.create"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: { width: 320, height: 568 } });
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill("Phone test");
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();

  const line = page.getByTestId("group-members");
  await expect(line).toContainText("1 member");
  const buttons = page.getByTestId("group-connection");
  await expect(buttons).toBeVisible();
  const text = (await line.boundingBox())!;
  const first = (await buttons.boundingBox())!;
  expect(text.x + text.width).toBeLessThanOrEqual(first.x);
});

/**
 * In Arabic (right to left) a group's Latin name that is longer than its place is cut at its end, as in English: its
 * first letter is drawn inside the name's box. It was cut at its start ("…airro Vila Madalena e amigos") in the header,
 * the members dialog's title and the chat list's row, which leaves "Team Alpha" and "Team Beta" reading the same.
 */
test("in Arabic on a phone a group's long Latin name starts with its first letters", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n", "@feature:groups.community.create"] }, async ({ peer }) => {
  const name = "Clube de leitura do bairro Vila Madalena e amigos";
  const { page } = await peer("alice", { mobile: true, viewport: { width: 375, height: 667 } });
  await page.getByTestId("sidebar-new-more").click();
  await page.getByTestId("new-group").click();
  await page.getByTestId("new-group-name").fill(name);
  await page.getByTestId("new-group-create").click();
  await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
  await expect(page.getByTestId("group-name")).toHaveText(name);
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "ar" }));
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // Whether the name's first letter is drawn inside the (clipping) box that holds the name.
  const startsInside = (testId: string) => page.getByTestId(testId).first().evaluate(el => {
    const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const letter = range.getBoundingClientRect(), box = el.getBoundingClientRect();
    return { cut: el.scrollWidth > el.clientWidth, inside: letter.left >= box.left - 1 && letter.right <= box.right + 1 };
  });
  await expect(page.getByTestId("group-name")).toHaveText(name);
  expect(await startsInside("group-name")).toEqual({ cut: true, inside: true });
  await page.getByTestId("group-members").click();
  await expect(page.getByTestId("group-members-name")).toHaveText(name);
  expect(await startsInside("group-members-name")).toEqual({ cut: true, inside: true });
  await page.keyboard.press("Escape");
  await page.getByTestId("chat-back").click();
  await expect(page.getByTestId("chat-row-name").filter({ hasText: name })).toBeVisible();
  expect(await startsInside("chat-row-name")).toEqual({ cut: true, inside: true });
});

for (const phone of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`a new group on a ${phone.width}×${phone.height} phone: "Go to the group" is in view without scrolling`, { tag: ["@feature:app.mobile-layout", "@feature:groups.community.create"] }, async ({ peer }) => {
    // The group's ready dialog (QR, link, Share and Copy, the note, the admin's link controls) ran past the screen,
    // and its only way on sat under the fold: in the iOS Simulator an iPhone 17 had to scroll the dialog to reach it.
    const { page } = await peer("alice", { mobile: true, viewport: phone });
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill("Phone plaza");
    await page.getByTestId("new-group-create").click();
    const dialog = page.getByTestId("group-share-dialog");
    const done = dialog.getByTestId("group-share-done");
    await expect(done).toBeInViewport({ ratio: 1 });
    // Still a QR a phone's camera reads from across a table.
    expect((await dialog.getByTestId("group-link-qr").locator("svg").boundingBox())!.width).toBeGreaterThanOrEqual(140);
    await done.click();
    await expect(dialog).toHaveCount(0);
  });
}
