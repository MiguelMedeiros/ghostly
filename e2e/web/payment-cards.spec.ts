import { chat, connect, createWallet, expect, getTestCoins, link, openChat, test, useFakeProviders, useTestnet, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { pointAt, stillness } from "../support/still";
import { closePayments, openPayments } from "../support/payments";

/**
 * Paying in a chat starts from the wallet's cards: a stack in the composer, where the card the pointer rests on
 * comes up and says what it would do. The card clicked turns over, and its back is where the amount and what it
 * is for are written. A card that cannot be used here comes up to say why, and does not turn over. The cards are
 * the wallets Alice made (a new profile has none): Testnet Cashu, the Lightning that comes with it, and a fake
 * Testnet Bitcoin wallet (in memory, no chain) that Bob has no counterpart of.
 */

/** Testnet Cashu and its Lightning card and, with `bitcoin`, a fake Testnet Bitcoin wallet: made before the chat. */
async function wallets(p: Peer, { bitcoin = false } = {}): Promise<void> {
  if (bitcoin) await useFakeProviders(p);
  // The Wallets page by its address: a phone has no wallet chip, it is a tab there.
  await p.page.goto("/#/wallet");
  await useTestnet(p);
  if (bitcoin) await createWallet(p, "bitcoin", "testnet", { provider: "fake-onchain", fill: async (form) => {
    await form.getByLabel("Access token").fill("token");
    await form.getByTestId("provider-save").click();
  } });
  // Back to the chat list, where a chat starts (on a phone the wallet page covers it).
  await p.page.goBack();
  await expect(p.page.getByTitle("New Chat")).toBeVisible();
}

test("the chat's payment cards: flip through them, turn one over, and back to the cards", { tag: ["@feature:payments.chat.cards"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { viewport: { width: 1280, height: 900 } }), peer("bob")]);
  await wallets(alice, { bitcoin: true });
  await wallets(bob);
  await link(alice, bob);
  await connect(alice, bob);
  const { page } = alice;
  const card = (id: string) => page.getByTestId(`payment-card-${id}-testnet`);
  const composer = page.getByTestId("payment-composer");
  await expect(await composerRow(page, "payment-button")).toBeEnabled({ timeout: 60_000 });
  await (await composerRow(page, "payment-button")).click();

  // The cards first, as a choice of how to pay, the remembered one chosen and focused.
  const cards = composer.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio");
  await expect(cards).toHaveCount(3);
  await expect(card("cashu")).toHaveAttribute("aria-checked", "true");
  await expect(card("cashu")).toBeFocused();
  await expect(composer).toHaveAttribute("data-side", "cards");
  await expect(page.getByTestId("payment-amount")).toHaveCount(0);

  // The pointer passing over the cards brings each one up, and that is all: nothing scrolls, nothing turns over, and
  // the focus stays on the card it was on.
  const still = await stillness(page);
  for (const id of ["lightning", "bitcoin", "cashu"]) {
    await pointAt(card(id));
    await expect(card(id)).toHaveAttribute("aria-checked", "true");
    expect(await stillness(page), `over ${id}`).toEqual(still);
  }
  await expect(composer).toHaveAttribute("data-side", "cards");

  // Resting on a card brings it up and says what Send and Request do with it; nothing turns over yet.
  await card("lightning").hover();
  await expect(card("lightning")).toHaveAttribute("aria-checked", "true");
  await expect(card("cashu")).toHaveAttribute("aria-checked", "false");
  await expect(composer).toContainText("Request with a Lightning invoice");
  await expect(page.getByTestId("payment-use")).toHaveText(/Use Lightning/);
  await expect(composer).toHaveAttribute("data-side", "cards");

  // A card that cannot be used here comes up greyed, says why, and cannot be turned over: Bob has no Testnet Bitcoin wallet.
  await card("bitcoin").hover();
  await expect(card("bitcoin")).toHaveAttribute("aria-checked", "true");
  await expect(card("bitcoin")).toBeDisabled();
  await expect(card("bitcoin")).toHaveAttribute("title", /Your contact has no Testnet Bitcoin wallet/);
  await expect(page.getByTestId("payment-use")).toBeDisabled();
  await card("bitcoin").click({ force: true });
  await expect(composer).toHaveAttribute("data-side", "cards");

  // The arrows and the keyboard move along the cards too.
  await page.mouse.move(5, 5);
  await page.getByTestId("payment-deck-prev").click();
  await expect(card("lightning")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("payment-deck-next").click();
  await expect(card("bitcoin")).toHaveAttribute("aria-checked", "true");
  await card("bitcoin").focus();
  await page.keyboard.press("Home");
  await expect(card("cashu")).toHaveAttribute("aria-checked", "true");

  // Enter turns the chosen card over: its back holds the amount, the memo on the signature strip, Request and Send.
  await card("cashu").focus();
  await page.keyboard.press("Enter");
  const back = page.getByTestId("payment-back");
  await expect(composer).toHaveAttribute("data-side", "back");
  await expect(back).toContainText("Cashu");
  await expect(back).toContainText(/· with \S/);
  await expect(page.getByTestId("payment-amount")).toBeFocused();
  await expect(composer.locator(".payment-flip")).toHaveAttribute("data-flipped", "true");
  await expect(back.getByPlaceholder("What for? (optional)")).toBeVisible();
  await expect(page.getByTestId("payment-send")).toBeDisabled();
  await page.getByTestId("payment-amount").fill("7");
  await expect(page.getByTestId("payment-request")).toBeEnabled();

  // Back to the cards, in a short window where the sheet scrolls: passing over the cards still moves nothing, and
  // another one turned over by a click has its amount focused, the sheet in view.
  await page.getByTestId("payment-change-card").click();
  await expect(composer).toHaveAttribute("data-side", "cards");
  await page.setViewportSize({ width: 1280, height: 560 });
  await expect(card("cashu")).toBeFocused();
  const short = await stillness(page);
  for (const id of ["bitcoin", "lightning", "cashu", "lightning"]) {
    await pointAt(card(id));
    await expect(card(id)).toHaveAttribute("aria-checked", "true");
    expect(await stillness(page), `over ${id}, in a short window`).toEqual(short);
  }
  const at = await pointAt(card("lightning"));
  await page.mouse.click(at.x, at.y);
  await expect(back).toContainText("Lightning");
  await expect(page.getByTestId("payment-amount")).toBeFocused();
  await expect(composer).toBeInViewport();
  await expect(page.getByTestId("payment-amount")).toBeInViewport();
  await expect(page.getByTestId("payment-send"), "Lightning pays a request the contact sends").toBeDisabled();
  await expect(page.getByTestId("payment-send")).toHaveAttribute("title", /tap Pay on your contact's request/);

  // The card turned over is the one the next payment starts on. Escape goes back to the cards, then closes.
  await page.keyboard.press("Escape");
  await expect(composer).toHaveAttribute("data-side", "cards");
  await page.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);
  await (await composerRow(page, "payment-button")).click();
  await expect(card("lightning")).toHaveAttribute("aria-checked", "true");
});

test("back from a chosen card by its Cards button and by Escape, then a payment on another card", { tag: ["@feature:payments.chat.cards", "@feature:payments.cashu.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { viewport: { width: 1280, height: 900 } }), peer("bob")]);
  for (const p of [alice, bob]) await wallets(p);
  await link(alice, bob);
  await connect(alice, bob);
  await getTestCoins(alice);
  await openChat(alice);
  const { page } = alice;
  const card = (id: string) => page.getByTestId(`payment-card-${id}-testnet`);
  const composer = await openPayments(page);

  // Lightning turned over, then back to the cards with "‹ Cards" in the card's top-left corner: the deck is back, the
  // keyboard on the card that was turned over.
  await card("lightning").click();
  await expect(page.getByTestId("payment-amount")).toBeFocused();
  const back = page.getByTestId("payment-change-card");
  await expect(back).toHaveAccessibleName("Back to the cards");
  // It leads the card's head, before the mark and the name (its place on screen moves while the card turns).
  await expect(page.getByTestId("payment-back").locator(".payment-back-head > :first-child")).toHaveAttribute("data-testid", "payment-change-card");
  await back.click();
  await expect(composer).toHaveAttribute("data-side", "cards");
  await expect(card("lightning")).toBeFocused();

  // Cashu turned over; a click on the card's text keeps the sheet, and Escape goes back to the cards, not out.
  await card("cashu").click();
  await expect(page.getByTestId("payment-amount")).toBeVisible();
  await page.getByTestId("payment-back").locator(".payment-back-hint").click();
  await expect(composer).toHaveAttribute("data-side", "back");
  await page.keyboard.press("Escape");
  await expect(composer).toHaveAttribute("data-side", "cards");
  await expect(card("cashu")).toBeFocused();

  // Chosen again, it pays: 21 test sats, reviewed, received.
  await card("cashu").click();
  await page.getByTestId("payment-amount").fill("21");
  await page.getByTestId("payment-send").click();
  await composer.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state")).toHaveText(/Received/, { timeout: 60_000 });
});

test("the Accept cards are switches, grey when off, and a saved choice stays", { tag: ["@feature:payments.chat.methods", "@feature:payments.chat.cards"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { viewport: { width: 1280, height: 900 } }), peer("bob")]);
  for (const p of [alice, bob]) await wallets(p);
  await link(alice, bob);
  const { page } = alice;
  const accept = (id: string) => page.getByTestId(`payment-accept-${id}-testnet`);
  const drawn = (id: string) => page.getByTestId(`payment-accept-switch-${id}-testnet`);
  const composer = await openPayments(page, "accept");
  await expect(page.getByRole("switch", { name: /^Accept Lightning \(Testnet\) from / })).toBeVisible();
  await expect(accept("lightning")).toHaveAttribute("aria-checked", "true");
  await expect(drawn("lightning")).toHaveAttribute("data-on", "true");

  // From the keyboard: the arrows bring Lightning to the front, Space turns it off, and it goes grey.
  await accept("cashu").focus();
  await page.keyboard.press("ArrowRight");
  await expect(accept("lightning")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(accept("lightning")).toHaveAttribute("aria-checked", "false");
  await expect(drawn("lightning")).toHaveAttribute("data-on", "false");
  await expect(accept("lightning").locator("[data-deck=face]")).toHaveAttribute("data-checked", "false");
  await expect(accept("lightning")).toContainText("Testnet");
  await expect(composer).toHaveAttribute("data-side", "cards");
  await page.getByTestId("payment-accept-save").click();
  await expect(page.getByTestId("payment-accept-status")).toHaveAttribute("data-state", "saved");
  await closePayments(page);

  // Opened again, the choice is there: Lightning off on Accept, gone from Pay.
  await openPayments(page, "accept");
  await expect(accept("lightning")).toHaveAttribute("aria-checked", "false");
  await expect(drawn("lightning")).toHaveAttribute("data-on", "false");
  await expect(accept("cashu")).toHaveAttribute("aria-checked", "true");
  await openPayments(page, "pay");
  await expect(page.getByTestId("payment-card-lightning-testnet")).toHaveCount(0);
  await closePayments(page);
});

test("on a phone the payment cards are a track, and a tap turns one over", { tag: ["@feature:payments.chat.cards"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { mobile: true }), peer("bob")]);
  for (const p of [alice, bob]) await wallets(p);
  await link(alice, bob);
  await connect(alice, bob);
  const { page } = alice;
  // On a phone the + menu is a sheet from the bottom.
  await expect(await composerRow(page, "payment-button")).toBeEnabled({ timeout: 60_000 });
  await (await composerRow(page, "payment-button")).click();
  const composer = page.getByTestId("payment-composer");
  await expect(composer.locator(".wallet-deck")).toHaveAttribute("data-mode", "track");
  await page.getByTestId("payment-deck-next").click();
  await expect(page.getByTestId("payment-card-lightning-testnet")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("payment-use").click();
  await expect(page.getByTestId("payment-back")).toContainText("Lightning");
  await expect(page.getByTestId("payment-amount")).toBeVisible();
  // The composer is a sheet: nothing in it runs off the screen.
  const sheet = (await composer.boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
});
