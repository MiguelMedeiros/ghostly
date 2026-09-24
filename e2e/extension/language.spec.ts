import { expect, test } from "../support/extension";

/** The extension's pages carry the interface's language too: `<html lang>` and, for Arabic, `<html dir="rtl">`. */
test("<html lang> and <html dir> follow the language in the extension", { tag: ["@feature:app.i18n"] }, async ({ extensionPeer }) => {
  const { page } = await extensionPeer("alice");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(html).toHaveAttribute("dir", "ltr");

  await page.getByTitle("Settings").click();
  await page.locator("select").first().selectOption("ar");
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");

  await page.reload();
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");
  await page.locator("select").first().selectOption("ja");
  await expect(html).toHaveAttribute("lang", "ja");
  await expect(html).toHaveAttribute("dir", "ltr");
});
