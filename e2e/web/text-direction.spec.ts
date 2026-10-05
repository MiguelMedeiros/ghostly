import type { Locator, Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, walletCard } from "../support/fixtures";
import { mockEthereum } from "../support/ethereum";
import { mockMainnetMints } from "../support/mint";

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

test("in Arabic the words on a wallet card keep the app's font, so their letters stay joined", { tag: ["@feature:app.i18n", "@feature:wallet.instances.first-run"] }, async ({ peer }) => {
  // A new profile's first-run wallets (as the installed app makes them), with the mints and the Ethereum RPC answered here.
  const { page } = await peer("ar-cards", { mobile: true, beforeOpen: async (context) => {
    await mockMainnetMints(context);
    await mockEthereum(context);
    await context.addInitScript(() => { try { localStorage.setItem("ghostly-test-wallet-setup", "on"); } catch { /* opaque origin */ } });
  } });
  await useLanguage(page, "ar");
  await page.getByTestId("mobile-tab-wallet").click();
  const card = walletCard(page, "cashu-mainnet");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // A monospace font draws Arabic letters apart ("ج ا ه ز ة" for Ready); the amount keeps it.
  for (const part of [".wallet-deck-card-status", ".wallet-deck-card-detail"]) {
    const font = await card.locator(part).evaluate((element) => getComputedStyle(element).fontFamily);
    expect(font, part).not.toMatch(/mono/i);
  }
  expect(await card.locator(".wallet-deck-card-balance").evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(/mono/i);
});
