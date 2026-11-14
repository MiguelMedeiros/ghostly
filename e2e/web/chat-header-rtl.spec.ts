import { connect, expect, link, test } from "../support/fixtures";

/**
 * In Arabic (right to left) a contact's Latin name that is longer than its place in a chat's header is cut at its end,
 * as in English: its first letter is drawn inside the name's box. It was cut at its start ("…a Maria Fernanda de
 * Souza"): the header's button cut it in the page's direction, with the name in a <bdi> inside it. Two contacts whose
 * names end alike read the same that way.
 */
test("in Arabic on a phone a contact's long Latin name in the chat header starts with its first letters", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }) => {
  const long = "Ana Maria Fernanda de Souza";
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: { width: 375, height: 667 } });
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page, name = page.getByTestId("chat-name");
  await page.getByTitle("Click to set a name").click();
  await page.getByPlaceholder("Set a name...").fill(long);
  await page.getByPlaceholder("Set a name...").press("Enter");
  await expect(name).toHaveText(long);
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "ar" }));
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(name).toHaveText(long);

  // Whether the name's first letter is drawn inside the (clipping) box that cuts it.
  const start = await name.evaluate((el) => {
    let box: Element = el;
    while (box.scrollWidth <= box.clientWidth && box.parentElement && box.tagName !== "H1") box = box.parentElement;
    const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const letter = range.getBoundingClientRect(), cut = box.getBoundingClientRect();
    return { cut: box.scrollWidth > box.clientWidth, inside: letter.left >= cut.left - 1 && letter.right <= cut.right + 1 };
  });
  expect(start).toEqual({ cut: true, inside: true });
});
