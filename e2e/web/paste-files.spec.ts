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

/**
 * Whether the picture's URL still serves its bytes. Chromium keeps drawing an image whose object URL was revoked after
 * it loaded; WebKit loads it again and shows its broken "?", which is what Miguel saw.
 */
const liveSource = (img: ReturnType<Page["getByRole"]>) => img.evaluate(async (el: HTMLImageElement) => {
  try { return (await (await fetch(el.src)).blob()).size > 0; } catch { return false; }
}).catch(() => false);

/** A picture's decoded width, or 0 while it is not loaded (a broken image stays at 0). */
const loadedWidth = (img: ReturnType<Page["getByRole"]>) => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)).catch(() => 0);

test("the sender's own pasted picture shows at once, stays through the transfer, and after a reload", { tag: ["@feature:app.composer.paste-files", "@feature:files.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Bob's app stops mid-session: the transfer is under way, and stays so, while Alice looks at her picture.
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");

  expect(await paste(alice.page, "textarea", [{ name: "image.png", type: "image/png", base64: PNG }])).toBe(false);
  await alice.page.getByTestId("attachment-send").click();
  const mine = chat(alice).getByTestId("file-bubble").filter({ hasText: /Pasted image .*\.png/ });
  const picture = mine.getByRole("img", { name: /^Pasted image .*\.png$/ });
  // The bytes are on this device already: the picture does not wait for the contact, nor for the transfer.
  await expect(mine).toBeVisible();
  await expect.poll(() => loadedWidth(picture), { timeout: 500, intervals: [25] }).toBeGreaterThan(0);
  await expect(mine).toHaveAttribute("data-stage", /transferring|waiting|queued|asking/);
  // Still there a while later, the transfer still going (a revoked URL under it showed WebKit's broken "?").
  await alice.page.waitForTimeout(1500);
  expect(await loadedWidth(picture)).toBeGreaterThan(0);
  expect(await liveSource(picture), "its URL still serves the picture").toBe(true);

  await cdp.send("Debugger.resume");
  await expect(chat(bob).getByTestId("file-bubble").filter({ hasText: /Pasted image .*\.png/ }).getByRole("img")).toBeVisible({ timeout: 60_000 });
  expect(await loadedWidth(picture), "still loaded once the transfer ended").toBeGreaterThan(0);
  await expect.poll(() => liveSource(picture), { timeout: 5_000 }).toBe(true);

  await alice.page.reload();
  await expect.poll(() => loadedWidth(picture), { timeout: 30_000 }).toBeGreaterThan(0);
});
