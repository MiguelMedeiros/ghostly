import { expect, test, type Peer } from "../support/fixtures";
import { injectNostrSigner } from "../support/nostrSigner";
import { closeIdentities, openIdentities, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);

/**
 * The composer's identity button, beside ⚡: the profile's identities as ID cards, step for step as ⚡ pays. With none
 * yet, the blank card adds one there, without leaving the chat. "Use …" turns the chosen card over, as a payment card
 * turns; its back shares it and the contact sees it verified, the back says so and the card comes back with the seal.
 * Turned over again, Stop sharing, and the contact sees it is no longer shared.
 */
test("an identity is added, shared and withdrawn from the chat's composer", { tag: ["@feature:proofs.composer", "@feature:proofs.share", "@feature:proofs.withdraw"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("cid-alice"), peer("cid-bob")]);
  await injectNostrSigner(alice);
  await pair(alice, bob);
  const withBob = await chatId(alice);

  // No identity yet: the deck is the blank card, which adds one here.
  const button = alice.page.getByTestId("composer-identities-button");
  await expect(button).toHaveAttribute("aria-label", "Share identities in this chat");
  await button.click();
  const picker = alice.page.getByTestId("composer-identities");
  await expect(picker.getByRole("radio")).toHaveCount(1);
  await expect(picker.getByTestId("composer-identity-add")).toContainText("Add your first identity");
  await expect(picker.getByTestId("composer-identities-empty")).toContainText("No identities yet");
  await picker.getByTestId("composer-identities-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveAttribute("data-value", "nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  expect(await chatId(alice)).toBe(withBob);

  // The new card comes up chosen, not shared yet: one line on what Bob would see, and "Use Nostr" in its colour.
  const nostr = picker.getByTestId("composer-identity").filter({ hasText: "Nostr" });
  await expect(nostr).toHaveAttribute("aria-checked", "true");
  await expect(nostr).toContainText("Not shared with");
  await expect(nostr.getByTestId("id-card-shared")).toHaveCount(0);
  await expect(picker.getByTestId("composer-identity-hint")).toContainText(/will see your Nostr npub1/);
  const use = picker.getByTestId("composer-identity-use");
  await expect(use).toHaveText("Use Nostr");
  await expect(picker.getByTestId("composer-identity-panel")).toHaveCount(0);

  // Use turns it over, like a payment card: the back is what Bob sees, and Share with him.
  await use.click();
  await expect(picker).toHaveAttribute("data-side", "back");
  await expect(picker.locator(".composer-identity-flip")).toHaveAttribute("data-flipped", "true");
  const back = picker.getByTestId("composer-identity-back");
  const status = back.getByTestId("composer-identity-status");
  const share = back.getByTestId("composer-identity-share");
  await expect(back.getByTestId("composer-identity-sees")).toContainText("Nostr");
  await expect(status).toHaveText("Not shared");
  await expect(share).toHaveText(/^Share with /);
  await expect(share).toBeFocused();

  // Share: the back says it is done (briefly: the UI tests check the line), Bob's app verifies it, and the card comes
  // back wearing the check seal.
  await share.click();
  await expect(picker).toHaveAttribute("data-side", "cards");
  await expect(nostr.getByTestId("id-card-shared")).toBeVisible();
  await expect(nostr).toBeFocused();
  await expect(button.getByTestId("composer-identities-count")).toHaveText("1");
  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  await closeIdentities(bob);

  // From the same picker, still open: turned over again, it is shared and verified; Stop sharing.
  await expect(picker.getByTestId("composer-identity-hint")).toContainText(/ sees your Nostr npub1/);
  await use.click();
  await expect(status).toHaveText("Shared · verified by your contact");
  await expect(back).toContainText("a copy they kept stays");
  await expect(share).toHaveText("Stop sharing");
  await share.click();
  await expect(picker).toHaveAttribute("data-side", "cards");
  await expect(nostr.getByTestId("id-card-shared")).toHaveCount(0);
  await expect(button.getByTestId("composer-identities-count")).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "withdrawn");
  const bobsCard = await turnTheirs(bob);
  await expect(bobsCard.getByTestId("chat-identity-received-status")).toHaveText("No longer shared");
  await closeIdentities(bob);

  // Escape closes it and gives the focus back to the button; opened again, the keys start on the chosen card.
  await alice.page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await expect(nostr).toBeFocused();
  await alice.page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  // On a phone the button waits behind the plus with GIF, ⚡ and files; the input keeps its width.
  await alice.page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toBeHidden();
  await alice.page.getByTestId("composer-more").click();
  await expect(button).toBeVisible();
  const input = await alice.page.getByPlaceholder("Message…").boundingBox();
  expect(input!.width).toBeGreaterThan(200);
  const more = await alice.page.locator(".composer-more-open").boundingBox();
  expect(more!.x + more!.width).toBeLessThanOrEqual(390);
  await button.click();
  await expect(picker).toBeVisible();
  const sheet = await picker.boundingBox();
  expect(sheet!.x).toBeGreaterThanOrEqual(0);
  expect(sheet!.x + sheet!.width).toBeLessThanOrEqual(390);
  // The cards fit the sheet, and so does the action under them; turned over, so does its back.
  for (const part of [nostr, use]) {
    await expect(part).toBeVisible();
    const box = await part.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await use.click();
  await expect(share).toBeFocused();
  for (const part of [back, share]) {
    const box = await part.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const card = await picker.boundingBox();
  expect(card!.y).toBeGreaterThanOrEqual(0);
});
