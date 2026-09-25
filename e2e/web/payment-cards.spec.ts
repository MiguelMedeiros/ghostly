import { connect, expect, link, test } from "../support/fixtures";

/**
 * Paying in a chat starts from the wallet's cards: a stack in the composer, where the card the pointer rests on
 * comes up and says what it would do. The card clicked turns over, and its back is where the amount and what it
 * is for are written. A card that cannot be used here comes up to say why, and does not turn over.
 */
test("the chat's payment cards: flip through them, turn one over, and back to the cards", { tag: ["@feature:payments.chat.cards"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { viewport: { width: 1280, height: 900 } }), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const { page } = alice;
  const card = (id: string) => page.getByTestId(`payment-card-${id}`);
  const composer = page.getByTestId("payment-composer");
  await expect(page.getByTestId("payment-button")).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId("payment-button").click();

  // The cards first, as a choice of how to pay, the remembered one chosen and focused.
  const cards = composer.getByRole("radiogroup", { name: "Pay with" }).getByRole("radio");
  await expect(cards).toHaveCount(7);
  await expect(card("cashu")).toHaveAttribute("aria-checked", "true");
  await expect(card("cashu")).toBeFocused();
  await expect(composer).toHaveAttribute("data-side", "cards");
  await expect(page.getByTestId("payment-amount")).toHaveCount(0);

  // Resting on a card brings it up and says what Send and Request do with it; nothing turns over yet.
  await card("lightning").hover();
  await expect(card("lightning")).toHaveAttribute("aria-checked", "true");
  await expect(card("cashu")).toHaveAttribute("aria-checked", "false");
  await expect(composer).toContainText("Request with a Lightning invoice");
  await expect(page.getByTestId("payment-use")).toHaveText(/Use Lightning/);
  await expect(composer).toHaveAttribute("data-side", "cards");

  // A card that cannot be used here comes up greyed, says why, and cannot be turned over.
  await card("bitcoin").hover();
  await expect(card("bitcoin")).toHaveAttribute("aria-checked", "true");
  await expect(card("bitcoin")).toBeDisabled();
  await expect(card("bitcoin")).toHaveAttribute("title", /Bitcoin is not set up yet/);
  await expect(page.getByTestId("payment-use")).toBeDisabled();
  await card("bitcoin").click({ force: true });
  await expect(composer).toHaveAttribute("data-side", "cards");

  // The arrows and the keyboard move along the cards too.
  await page.mouse.move(5, 5);
  await page.getByTestId("payment-deck-prev").click();
  await expect(card("bark")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("payment-deck-next").click();
  await page.getByTestId("payment-deck-next").click();
  await expect(card("usdt")).toHaveAttribute("aria-checked", "true");
  await card("usdt").focus();
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

  // Back to the cards, and another one turned over by a click.
  await page.getByTestId("payment-change-card").click();
  await expect(composer).toHaveAttribute("data-side", "cards");
  await card("lightning").click();
  await expect(back).toContainText("Lightning");
  await expect(page.getByTestId("payment-send"), "Lightning pays a request the contact sends").toBeDisabled();
  await expect(page.getByTestId("payment-send")).toHaveAttribute("title", /tap Pay on your contact's request/);

  // The card turned over is the one the next payment starts on.
  await page.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);
  await page.getByTestId("payment-button").click();
  await expect(card("lightning")).toHaveAttribute("aria-checked", "true");
});

test("on a phone the payment cards are a track, and a tap turns one over", { tag: ["@feature:payments.chat.cards"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { mobile: true }), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const { page } = alice;
  // On a phone the ⚡ is behind "More".
  await page.getByTestId("composer-more").click();
  await expect(page.getByTestId("payment-button")).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId("payment-button").click();
  const composer = page.getByTestId("payment-composer");
  await expect(composer.locator(".wallet-deck")).toHaveAttribute("data-mode", "track");
  await page.getByTestId("payment-deck-next").click();
  await expect(page.getByTestId("payment-card-lightning")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("payment-use").click();
  await expect(page.getByTestId("payment-back")).toContainText("Lightning");
  await expect(page.getByTestId("payment-amount")).toBeVisible();
  // The composer is a sheet: nothing in it runs off the screen.
  const sheet = (await composer.boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
});
