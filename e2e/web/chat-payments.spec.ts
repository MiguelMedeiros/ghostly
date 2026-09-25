import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { chatPayments, closePayments, openPayments } from "../support/payments";

// Each chat chooses its own ways of paying, on the composer's cards: + → Payment → Accept. A way works only when
// both sides have it on, and a connected contact learns the choice at once.

const ALL = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"];
const card = (p: Peer, id: string) => p.page.getByTestId(`payment-card-${id}`);
const accept = (p: Peer, id: string) => p.page.getByTestId(`payment-accept-${id}`);

test("each chat accepts its own ways of paying, chosen on the composer's cards", { tag: ["@feature:payments.chat.methods"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const button = (p: Peer) => composerRow(p.page, "payment-button");
  for (const p of [alice, bob]) {
    await expect(await button(p)).toBeEnabled({ timeout: 60000 });
    await p.page.keyboard.press("Escape");
  }

  // Alice does not take Cashu or USDT from Bob; Lightning and Ark stay.
  await chatPayments(alice.page, { cashu: false, usdt: false });
  await openPayments(bob.page);
  await expect(card(bob, "cashu")).toBeDisabled({ timeout: 90000 });
  await expect(card(bob, "cashu")).toHaveAttribute("title", /does not accept Cashu/);
  await expect(card(bob, "usdt")).toBeDisabled();
  await expect(card(bob, "lightning")).toBeEnabled();
  await expect(card(bob, "arkade")).toBeEnabled({ timeout: 60000 });
  await closePayments(bob.page);

  // Alice's Pay no longer shows them; her Accept keeps them, off, to turn on again.
  await openPayments(alice.page);
  await expect(card(alice, "cashu")).toHaveCount(0);
  await expect(card(alice, "lightning")).toBeVisible();
  await openPayments(alice.page, "accept");
  await expect(accept(alice, "cashu")).toHaveAttribute("aria-checked", "false");
  await expect(accept(alice, "usdt")).toHaveAttribute("aria-checked", "false");
  await expect(accept(alice, "lightning")).toHaveAttribute("aria-checked", "true");
  await closePayments(alice.page);

  // Bob's Accept says what Alice has off.
  await openPayments(bob.page, "accept");
  await expect(accept(bob, "cashu")).toContainText("Contact: has it off");
  await expect(accept(bob, "lightning")).toContainText("Contact: accepts it");
  await closePayments(bob.page);

  // Everything off for this chat: + → Payment still opens, on Accept, and says why; the chat keeps working.
  await chatPayments(alice.page, { lightning: false, arkade: false, bark: false, spark: false, bitcoin: false, fedimint: false });
  const aliceRow = await button(alice);
  await expect(aliceRow).toBeEnabled();
  await expect(aliceRow).toContainText("Off in this chat");
  await aliceRow.click();
  await expect(alice.page.getByTestId("payment-composer")).toHaveAttribute("data-mode", "accept");
  await closePayments(alice.page);
  await expect(await button(bob)).toContainText("Your contact has payments off", { timeout: 90000 });
  await bob.page.keyboard.press("Escape");
  await say(bob, "still talking");
  await expect(chat(alice).getByText("still talking")).toBeVisible({ timeout: 60000 });

  // Alice turns them all on again, from the same place.
  await chatPayments(alice.page, Object.fromEntries(ALL.map((id) => [id, true])));
  await openPayments(bob.page);
  await expect(card(bob, "cashu")).toBeEnabled({ timeout: 90000 });
  await closePayments(bob.page);

  // Choosing never paid or asked for anything, on either side.
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble")).toHaveCount(0);
});

test("a chat's ways of paying, and the card it starts on, are its own", { tag: ["@feature:payments.chat.methods", "@feature:payments.chat.cards"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await link(alice, bob);
  const withBob = new URL(alice.page.url()).hash;
  await link(alice, carol);
  const withCarol = new URL(alice.page.url()).hash;
  const go = async (page: Page, hash: string) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await expect(page.getByPlaceholder("Message…")).toBeVisible();
  };

  // With Bob: Cashu off, and the Lightning card turned over once (the card Pay starts on next time).
  await go(alice.page, withBob);
  await chatPayments(alice.page, { cashu: false });
  await openPayments(alice.page);
  await card(alice, "lightning").click();
  await expect(alice.page.getByTestId("payment-amount")).toBeVisible();
  await alice.page.getByTestId("payment-amount").press("Escape");
  await expect(alice.page.getByTestId("payment-composer")).toHaveCount(0);

  // With Carol nothing changed: every way on, and Pay starts on the first card, Cashu.
  await go(alice.page, withCarol);
  await openPayments(alice.page, "accept");
  for (const id of ALL) await expect(accept(alice, id)).toHaveAttribute("aria-checked", "true");
  await openPayments(alice.page, "pay");
  await expect(card(alice, "cashu")).toHaveAttribute("aria-checked", "true");
  await closePayments(alice.page);

  // Back with Bob: still his own.
  await go(alice.page, withBob);
  await openPayments(alice.page);
  await expect(card(alice, "cashu")).toHaveCount(0);
  await expect(card(alice, "lightning")).toHaveAttribute("aria-checked", "true");
  await closePayments(alice.page);
});
