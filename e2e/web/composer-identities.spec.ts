import { expect, test, type Peer } from "../support/fixtures";
import { injectNostrSigner } from "../support/nostrSigner";
import { closeIdentities, openIdentities, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { INTERFACE_NOTES, NOTE, heard, listen } from "../support/sounds";

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);

/**
 * The composer's + → Identity, beside Payment: the profile's identities as ID cards, step for step as a payment is made. With none
 * yet, the blank card adds one there, without leaving the chat. "Use …" turns the chosen card over, as a payment card
 * turns; its back shares it, the picker closes, and both chats show the share as a small ID card that turns verified
 * once the contact's app checked it. Turned over again, Stop sharing: a line in both chats, and the contact sees it is
 * no longer shared.
 */
test("an identity is added, shared and withdrawn from the chat's composer, and both chats show it", { tag: ["@feature:proofs.composer", "@feature:proofs.share", "@feature:proofs.withdraw", "@feature:proofs.timeline", "@feature:app.attention.cues"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("cid-alice"), peer("cid-bob")]);
  // What each would hear (e2e/support/sounds.ts): the Identities category's cues.
  await Promise.all([listen(alice), listen(bob)]);
  await injectNostrSigner(alice);
  await pair(alice, bob);
  const withBob = await chatId(alice);

  // No identity yet: the deck is the Ghostly card, chosen, then the blank card, which adds one here.
  const plus = alice.page.getByTestId("composer-more");
  const row = () => composerRow(alice.page, "composer-identities-button");
  await expect(await row()).toHaveAttribute("data-count", "0");
  await (await row()).click();
  const picker = alice.page.getByTestId("composer-identities");
  await expect(picker.getByRole("radio")).toHaveCount(2);
  await expect(picker.getByTestId("composer-identity-ghostly")).toHaveAttribute("aria-checked", "true");
  await expect(picker.getByTestId("composer-identity-use")).toHaveText(/Use Ghostly/);
  await expect(picker.getByTestId("composer-identity-add")).toContainText("Add an identity");
  await picker.getByTestId("composer-identity-add").focus();
  await alice.page.keyboard.press("End");
  await expect(picker.getByTestId("composer-identities-empty")).toContainText("No other identities yet");
  await picker.getByTestId("composer-identities-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveAttribute("data-value", "nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  expect(await chatId(alice)).toBe(withBob);
  // Added, so verified: a stamp, once.
  await expect.poll(() => heard(alice, NOTE.sealed)).toBe(1);

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

  // Share: the picker closes and the keys go back to the message. Both chats show the share as a small ID card,
  // checking and then verified: Bob's app verified it.
  await share.click();
  await expect(picker).toHaveCount(0);
  await expect(alice.page.getByPlaceholder("Message…")).toBeFocused();
  const mine = alice.page.getByTestId("identity-share").and(alice.page.locator("[data-side=mine][data-kind=shared]"));
  await expect(mine).toHaveCount(1);
  await expect(mine.getByTestId("identity-share-text")).toHaveText("You shared Nostr");
  await expect(mine.getByTestId("identity-share-subject")).toContainText("npub1");
  await expect(mine).toHaveAttribute("data-state", "verified", { timeout: 60_000 });
  const theirs = bob.page.getByTestId("identity-share").and(bob.page.locator("[data-side=theirs][data-kind=shared]"));
  await expect(theirs).toHaveCount(1);
  await expect(theirs.getByTestId("identity-share-text")).toHaveText(/ shared Nostr$/);
  await expect(theirs).toHaveAttribute("data-state", "verified", { timeout: 60_000 });
  await expect(theirs.getByTestId("identity-share-subject")).toContainText("npub1");
  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  // Bob hears the card come in, then its check once his app verified it, each once; Alice turned cards over and moved
  // along the deck without a sound (Interface sounds are off by default).
  await expect.poll(() => heard(bob, NOTE.shared)).toBe(1);
  await expect.poll(() => heard(bob, NOTE.checked)).toBe(1);
  expect(await heard(alice, NOTE.shared, NOTE.checked)).toBe(0);
  for (const p of [alice, bob]) expect(await heard(p, ...INTERFACE_NOTES)).toBe(0);
  // Tapping Bob's card opens Alice's identities on that card.
  await theirs.getByRole("button").click();
  await expect(bob.page.getByTestId("chat-identities")).toBeVisible();
  const chosen = bob.page.getByTestId("chat-identities-received").getByTestId("chat-identity-received").and(bob.page.locator("[aria-checked=true]"));
  await expect(chosen).toContainText("Nostr");
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  await closeIdentities(bob);
  // A reload keeps one card each, verified: the entries are stored, not made again.
  await bob.page.reload();
  await expect(theirs).toHaveCount(1, { timeout: 30_000 });
  await expect(theirs).toHaveAttribute("data-state", "verified");
  // Nor are their sounds.
  expect(await heard(bob, NOTE.shared, NOTE.checked)).toBe(2);

  // The + menu's Identity row says one is shared here; it opens the picker again.
  await expect(await row()).toHaveAttribute("data-count", "1");
  await expect(await row()).toContainText("1 shared in this chat");
  await (await row()).click();

  // Opened again it starts on the Ghostly card; a click on the Nostr card, wearing the seal, turns it over: it is
  // shared and verified; Stop sharing.
  await expect(picker.getByTestId("composer-identity-ghostly")).toHaveAttribute("aria-checked", "true");
  await expect(nostr.getByTestId("id-card-shared")).toBeVisible();
  await nostr.click();
  await expect(status).toHaveText("Shared · verified by your contact");
  await expect(back).toContainText("a copy they kept stays");
  await expect(share).toHaveText("Stop sharing");
  await share.click();
  await expect(picker).toHaveAttribute("data-side", "cards");
  await expect(nostr.getByTestId("id-card-shared")).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-identity-ghostly-mark")).toBeVisible();
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "withdrawn");
  const bobsCard = await turnTheirs(bob);
  await expect(bobsCard.getByTestId("chat-identity-received-status")).toHaveText("No longer shared");
  await closeIdentities(bob);
  // Stopping is a line in both chats, after the card.
  await expect(alice.page.getByTestId("identity-share").and(alice.page.locator("[data-kind=stopped]")).getByTestId("identity-share-text")).toHaveText(/^You stopped sharing Nostr · npub1/);
  await expect(bob.page.getByTestId("identity-share").and(bob.page.locator("[data-kind=stopped]")).getByTestId("identity-share-text")).toHaveText(/ stopped sharing Nostr · npub1/);

  // Escape closes it and gives the focus back to the +; opened again, the keys start on the chosen card.
  await alice.page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(plus).toBeFocused();
  await expect(await row()).toHaveAttribute("data-count", "0");
  await (await row()).click();
  await expect(picker.getByTestId("composer-identity-ghostly")).toBeFocused();
  await alice.page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  // On a phone the + menu is a sheet from the bottom; the input keeps its width.
  await alice.page.setViewportSize({ width: 390, height: 844 });
  const input = await alice.page.getByPlaceholder("Message…").boundingBox();
  expect(input!.width).toBeGreaterThan(200);
  await plus.click();
  const menu = alice.page.getByTestId("composer-menu");
  await expect(menu).toHaveAttribute("data-menu", "sheet");
  const sheetMenu = await menu.boundingBox();
  expect(sheetMenu!.x).toBeGreaterThanOrEqual(0);
  expect(sheetMenu!.x + sheetMenu!.width).toBeLessThanOrEqual(390);
  await menu.getByTestId("composer-identities-button").click();
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
  // The sheet opens on the Ghostly card; a tap on the Nostr card turns that one over.
  await nostr.click();
  await expect(share).toBeFocused();
  for (const part of [back, share]) {
    const box = await part.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  const card = await picker.boundingBox();
  expect(card!.y).toBeGreaterThanOrEqual(0);
});
