import { strangerInvoice } from "../support/bolt11";
import { chat, expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Copy on money in a message, when the browser refuses the copy (no clipboard permission, or the page lost the
 * focus). What is copied is pasted into another wallet, so the card never says Copied then: it says it could not copy
 * and shows the invoice itself to select, which on a phone has to fit the bubble (the card shows only a QR code).
 */
test("a refused copy of an invoice in a message says so and shows the invoice to select, on a phone", { tag: ["@feature:payments.lightning.invoice-card", "@feature:app.mobile-layout"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("copy-alice"), peer("copy-bob")]);
  await pair(alice, bob);
  const invoice = strangerInvoice(2100, "copy refused");
  await say(bob, `pay me ${invoice}`);
  await alice.page.setViewportSize({ width: 375, height: 800 });
  const card = chat(alice).getByTestId("invoice-bubble");
  await expect(card).toBeVisible();

  // The browser refuses the copy, by the Clipboard API and by the older route.
  await alice.page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    document.execCommand = () => false;
  });
  await card.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(card.getByTestId("money-copy-error")).toContainText("Could not copy. Select the text and copy it yourself.");
  await expect(card.getByRole("button", { name: "Copied" })).toHaveCount(0);
  const text = card.getByTestId("money-copy-text");
  await expect(text).toHaveText(invoice);

  // The invoice stays inside its card, and the page gets no sideways scroll.
  const fits = await card.evaluate((el) => {
    const box = el.getBoundingClientRect(), shown = el.querySelector("[data-testid=money-copy-text]")!.getBoundingClientRect();
    return { inCard: shown.left >= box.left - 0.5 && shown.right <= box.right + 0.5, page: document.documentElement.scrollWidth <= window.innerWidth };
  });
  expect(fits).toEqual({ inCard: true, page: true });
  await text.scrollIntoViewIfNeeded();
  const path = testInfo.outputPath("invoice-copy-refused-375.png");
  await alice.page.screenshot({ path });
  await testInfo.attach("invoice copy refused at 375 px", { path, contentType: "image/png" });
});
