import { expect, test, type Peer } from "../support/fixtures";
import { injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
async function received(peer: Peer) {
  await peer.page.getByTitle("Options").click();
  await peer.page.getByTestId("chat-identities-open").click();
  const dialog = peer.page.getByTestId("chat-identities");
  const row = dialog.getByTestId("chat-identity-received");
  return { row, close: () => dialog.getByRole("button", { name: "Close" }).click() };
}

/**
 * The composer's identity button, beside ⚡: the profile's identities as ID cards, the way ⚡ shows the ways of
 * paying. With none yet, the blank card adds one there, without leaving the chat; the chosen card's panel shares it,
 * and the contact sees it verified; Stop sharing, and the contact sees it is no longer shared.
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
  await expect(picker.getByRole("tab")).toHaveCount(1);
  await expect(picker.getByTestId("composer-identity-add")).toContainText("Add your first identity");
  await expect(picker.getByTestId("composer-identities-empty")).toContainText("No identities yet");
  await picker.getByTestId("composer-identities-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveValue("nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  expect(await chatId(alice)).toBe(withBob);

  // The new card comes up chosen, not shared yet.
  const nostr = picker.getByTestId("composer-identity").filter({ hasText: "Nostr" });
  await expect(nostr).toHaveAttribute("aria-selected", "true");
  await expect(nostr).toContainText("Not shared with");
  await expect(nostr.getByTestId("id-card-shared")).toHaveCount(0);
  const panel = picker.getByTestId("composer-identity-panel");
  const status = panel.getByTestId("composer-identity-status");
  const share = panel.getByTestId("composer-identity-share");
  await expect(panel).toContainText("Nostr");
  await expect(status).toHaveText("Not shared");

  // Share with this chat: Bob's app verifies it, and the card wears the check seal.
  await expect(share).toHaveText("Share with this chat");
  await share.click();
  await expect(status).toHaveText("Shared · verified by your contact");
  await expect(nostr.getByTestId("id-card-shared")).toBeVisible();
  await expect(share).toHaveText("Stop sharing");
  await expect(button.getByTestId("composer-identities-count")).toHaveText("1");
  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  let bobs = await received(bob);
  await expect(bobs.row).toHaveAttribute("data-status", "verified");
  await bobs.close();

  // From the same picker, still open: Stop sharing.
  await share.click();
  await expect(status).toHaveText("Not shared");
  await expect(nostr.getByTestId("id-card-shared")).toHaveCount(0);
  await expect(button.getByTestId("composer-identities-count")).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  bobs = await received(bob);
  await expect(bobs.row).toHaveAttribute("data-status", "withdrawn");
  await expect(bobs.row.getByTestId("chat-identity-received-status")).toHaveText("No longer shared");
  await bobs.close();

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
  // The cards fit the sheet, and so does the action under them.
  for (const part of [nostr, share]) {
    await expect(part).toBeVisible();
    const box = await part.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
});
