import { expect, test, type Peer } from "../support/fixtures";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
async function received(peer: Peer) {
  await peer.page.getByTitle("Options").click();
  await peer.page.getByTestId("chat-identities-open").click();
  const dialog = peer.page.getByTestId("chat-identities");
  const row = dialog.getByTestId("chat-identity-received");
  return { row, close: () => dialog.getByRole("button", { name: "Close" }).click() };
}

/**
 * The composer's identity button, beside ⚡: each identity of the profile is a switch for this chat. One tap
 * shares it, and the contact sees it verified; one tap stops, and the contact sees it is no longer shared.
 */
test("an identity is shared and withdrawn from the chat's composer", { tag: ["@feature:proofs.composer", "@feature:proofs.share", "@feature:proofs.withdraw"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("cid-alice"), peer("cid-bob")]);
  await injectNostrSigner(alice);
  await pair(alice, bob);
  const withBob = await chatId(alice);

  // No identity yet: the picker leads to the Identities page.
  const button = alice.page.getByTestId("composer-identities-button");
  await button.click();
  const picker = alice.page.getByTestId("composer-identities");
  await expect(picker.getByTestId("composer-identities-empty")).toContainText("No identities yet");
  await picker.getByRole("button", { name: "Add one" }).click();
  await expect(alice.page.getByTestId("identities-mine")).toBeVisible();

  await addNostrIdentity(alice);
  await go(alice, withBob);
  await expect(button).toHaveAttribute("aria-label", "Share identities in this chat");
  await button.click();
  const nostr = picker.getByRole("switch").filter({ hasText: "Nostr" });
  await expect(nostr).toHaveAttribute("aria-checked", "false");
  await expect(nostr.getByTestId("composer-identity-status")).toHaveText("Not shared");

  // One tap: shared with Bob, verified by his app.
  await nostr.click();
  await expect(nostr).toHaveAttribute("aria-checked", "true");
  await expect(nostr.getByTestId("composer-identity-status")).toHaveText("Shared · verified by your contact");
  await expect(button.getByTestId("composer-identities-count")).toHaveText("1");
  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  let bobs = await received(bob);
  await expect(bobs.row).toHaveAttribute("data-status", "verified");
  await bobs.close();

  // From the same picker, still open: one tap stops it.
  await nostr.click();
  await expect(nostr).toHaveAttribute("aria-checked", "false");
  await expect(nostr.getByTestId("composer-identity-status")).toHaveText("Not shared");
  await expect(button.getByTestId("composer-identities-count")).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  bobs = await received(bob);
  await expect(bobs.row).toHaveAttribute("data-status", "withdrawn");
  await expect(bobs.row.getByTestId("chat-identity-received-status")).toHaveText("No longer shared");
  await bobs.close();

  // Escape closes it and gives the focus back to the button.
  await alice.page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(button).toBeFocused();

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
  await expect(picker.getByRole("switch").filter({ hasText: "Nostr" })).toBeVisible();
});
