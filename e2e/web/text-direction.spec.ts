import type { Locator, Page } from "@playwright/test";
import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * What people write reads in its own direction, whatever the app's language: an English message in the Arabic app
 * reads left to right (its full stop at its end, not before its first word), an Arabic one in the English app right
 * to left, in the bubble and in the chat list's last line. The time stays beside the last line of text.
 */
const PHONE = { width: 390, height: 844 };

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

const direction = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).direction);

test("on a phone: an English message reads left to right in the Arabic app, an Arabic one right to left in the English app", { tag: ["@feature:app.i18n", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { mobile: true, viewport: PHONE }), peer("bob", { mobile: true, viewport: PHONE })]);
  await link(alice, bob);
  await connect(alice, bob);
  await useLanguage(alice.page, "ar");

  // Alice writes Arabic: right to left in Bob's English app, while his own English stays left to right.
  const field = alice.page.locator(".composer-row textarea");
  await field.fill("مرحبا يا صديقي!");
  await field.press("Enter");
  const arabic = chat(bob).getByTestId("message-body").filter({ hasText: "مرحبا يا صديقي!" });
  await expect(arabic).toBeVisible();
  expect(await direction(arabic)).toBe("rtl");
  expect(await direction(chat(bob).getByTestId("message-body").filter({ hasText: `hello from ${bob.name}` }))).toBe("ltr");
  // One line: the time beside the text, not under it.
  expect((await arabic.boundingBox())!.height).toBeLessThan(40);

  // Bob writes English: left to right in Alice's Arabic app.
  await say(bob, "It goes on and on.");
  const english = chat(alice).getByTestId("message-body").filter({ hasText: "It goes on and on." });
  await expect(english).toBeVisible();
  expect(await direction(english)).toBe("ltr");
  expect((await english.boundingBox())!.height).toBeLessThan(40);

  // The chat list's last line too.
  await alice.page.getByTestId("chat-back").click();
  const preview = alice.page.getByTestId("chat-row-preview").filter({ hasText: "It goes on and on." });
  await expect(preview).toBeVisible();
  expect(await direction(preview)).toBe("ltr");
});
