import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * A file copied in the iPhone's Files app (a PDF) and pasted into a chat of the web app. Safari never hands such a file
 * to a page: WebKit reads only pictures off the iPhone's clipboard (PasteboardCocoa.mm's file reader), so the paste
 * says "Files" and carries no file, no text, at most a web link. The paste did nothing and said nothing; now the
 * composer says so, with the file picker one tap away. It runs in WebKit too (playwright.webkit.config.ts).
 */

/** A paste on the message field as iOS Safari hands one over for a PDF copied in Files. */
function pasteFromFiles(page: Page, types: string[]): Promise<boolean> {
  return page.evaluate((types) => {
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // A page cannot build that transfer (a DataTransfer that says "Files" has files): the event carries its shape.
    const kept = { types, files: [], items: [], getData: (type: string) => type === "text/uri-list" && types.includes(type) ? "https://example.com/" : "" };
    Object.defineProperty(event, "clipboardData", { value: kept });
    return document.querySelector("textarea")!.dispatchEvent(event);
  }, types);
}

test("an iPhone: a file Safari keeps from a paste is said, and the file picker opens from there", { tag: ["@feature:app.composer.paste-files", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("paste-kept-files", { mobile: true, viewport: { width: 390, height: 844 } });
  await page.getByTestId("sidebar-new-chat").filter({ visible: true }).first().click();
  const field = page.locator("textarea");
  await expect(field).toBeVisible();
  await field.fill("draft stays");

  for (const types of [["Files"], ["Files", "text/uri-list"]]) {
    // Taken by the page (the default prevented), so nothing lands in the draft.
    expect(await pasteFromFiles(page, types)).toBe(false);
    await expect(page.getByRole("alert")).toContainText("The browser did not hand over the file you copied. Choose it from your files.");
    await expect(page.getByTestId("attachment-sheet")).toHaveCount(0);
    await expect(field).toHaveValue("draft stays");
  }

  // The line's button opens the same picker as + → Document, for any kind of file and several at once.
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("composer-toast-action").click();
  expect((await chooser).isMultiple()).toBe(true);
  await expect(page.getByTestId("composer-toast-action")).toHaveCount(0);
});
