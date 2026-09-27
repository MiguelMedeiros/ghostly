import type { Page } from "@playwright/test";
import { chat, connect, expect, link, test } from "../support/fixtures";

/** A 1×1 PNG, as a screenshot would put one on the clipboard. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Carried = { name: string; type: string; base64?: string; text?: string };

/**
 * A paste on `selector` of what a clipboard holds (files and/or text), as the browser hands it to the page.
 * True when the page left it to the field (nothing intercepted).
 */
function paste(page: Page, selector: string, files: Carried[], text = ""): Promise<boolean> {
  return page.evaluate(({ selector, files, text }) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : f.text ?? ""], f.name, { type: f.type }));
    if (text) data.setData("text/plain", text);
    const target = document.querySelector(selector)!;
    return target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { selector, files, text });
}

/** Files dragged in from outside the page and dropped on `selector`. */
function drop(page: Page, selector: string, files: Carried[]): Promise<void> {
  return page.evaluate(({ selector, files }) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([f.text ?? ""], f.name, { type: f.type }));
    const target = document.querySelector(selector)!;
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { selector, files });
}

test("a pasted screenshot and a dropped file reach the contact", { tag: ["@feature:app.composer.paste-files"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Text pastes as it always did: the page leaves it to the field.
  expect(await paste(alice.page, "textarea", [], "just words")).toBe(true);
  await expect(alice.page.getByTestId("attachment-sheet")).toHaveCount(0);

  // A screenshot: the sheet shows it, with a caption.
  expect(await paste(alice.page, "textarea", [{ name: "image.png", type: "image/png", base64: PNG }])).toBe(false);
  const sheet = alice.page.getByTestId("attachment-sheet");
  await expect(sheet.getByTestId("attachment-image")).toBeVisible();
  await expect(sheet.getByTestId("attachment-name")).toHaveText(/^Pasted image \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png · /);
  await sheet.getByTestId("attachment-caption").fill("boo from the clipboard");
  await sheet.getByTestId("attachment-send").click();
  await expect(sheet).toHaveCount(0);

  const picture = chat(bob).getByTestId("file-bubble").filter({ hasText: /Pasted image .*\.png/ });
  await expect(picture.getByRole("img", { name: /^Pasted image .*\.png$/ })).toBeVisible();
  await expect(chat(bob).getByText("boo from the clipboard")).toBeVisible();

  // Files dropped on the chat: two attachments.
  await drop(alice.page, "[data-message-list]", [
    { name: "ghost notes.txt", type: "text/plain", text: "the attic, at midnight" },
    { name: "route.csv", type: "text/csv", text: "attic,cellar\n" },
  ]);
  await expect(sheet.getByTestId("attachment-item")).toHaveCount(2);
  await sheet.getByTestId("attachment-send").click();
  for (const name of ["ghost notes.txt", "route.csv"]) await expect(chat(bob).getByTestId("file-bubble").filter({ hasText: name })).toBeVisible();
});
