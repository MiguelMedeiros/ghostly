import { composerRow } from "./composer";
import { expect, type Peer } from "./fixtures";

/**
 * A chat's identities, the way a person uses them. The contact's: the panel (src/components/identities/
 * ContactIdentitiesPanel.tsx) opened from their marks in the chat's header, their ID cards (a click turns one over).
 * Mine: the composer's + → Identity (ComposerIdentities.tsx), a click on a card turns it over to Share or Stop sharing.
 */

/**
 * The contact's marks in the chat's header (ContactMarks.tsx `IdentityStack`), always there in a paired chat: the
 * proofs they shared (`chat-identity-badge`), or their Ghostly mark alone (`chat-identity-ghostly-mark`) when none.
 */
export const headerMarks = (peer: Peer) => peer.page.getByTestId("chat-identity-badges");

/** The composer's identity picker (+ → Identity). */
const picker = (peer: Peer) => peer.page.getByTestId("composer-identities");

async function closePicker(peer: Peer) {
  if (!(await picker(peer).count())) return;
  await picker(peer).press("Escape");
  await expect(picker(peer)).toHaveCount(0);
}

/** A click on the header's marks; the panel beside the chat. */
export async function openIdentities(peer: Peer) {
  const panel = peer.page.getByTestId("chat-identities");
  if (await panel.count()) return panel;
  await closePicker(peer);
  await headerMarks(peer).click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the contact's panel, and my picker if it is open. */
export async function closeIdentities(peer: Peer) {
  await closePicker(peer);
  const panel = peer.page.getByTestId("chat-identities");
  if (await panel.count()) await peer.page.getByTestId("chat-identities-close").click();
  await expect(panel).toHaveCount(0);
}

/** My picker, open on its cards (the contact's panel closed first). */
async function openMine(peer: Peer) {
  const panel = peer.page.getByTestId("chat-identities");
  if (await panel.count()) { await peer.page.getByTestId("chat-identities-close").click(); await expect(panel).toHaveCount(0); }
  if (!(await picker(peer).count())) {
    await (await composerRow(peer.page, "composer-identities-button")).click();
    await expect(picker(peer)).toBeVisible();
  }
  return picker(peer);
}

/** One of my identities in the picker, by what its card says (its provider, its subject). */
const myCard = (peer: Peer, which?: string | RegExp) => {
  const cards = picker(peer).getByTestId("composer-identity");
  return which === undefined ? cards.first() : cards.filter({ hasText: which });
};

/** Turns one of my cards over in the composer's picker: its back says where it stands with this contact. Leaves it open and turned. */
export async function turnMine(peer: Peer, which?: string | RegExp) {
  const mine = await openMine(peer);
  if (await mine.getByTestId("composer-identity-back").count()) await backToMyCards(peer);
  await myCard(peer, which).click();
  await expect(mine.getByTestId("composer-identity-back")).toBeVisible();
  return mine;
}

export async function backToMyCards(peer: Peer) {
  const mine = picker(peer);
  const back = mine.getByTestId("composer-identity-change-card");
  if (await back.count()) await back.click();
  await expect(mine).toHaveAttribute("data-side", "cards");
}

/** Where one of mine stands with this contact ("Shared · verified by your contact", "Not shared"…), read on its back. */
export async function myStatus(peer: Peer, which?: string | RegExp) {
  const mine = await turnMine(peer, which);
  return mine.getByTestId("composer-identity-status");
}

/** Shares one of mine with this chat's contact and waits until the contact's app verified it (within `timeout`). */
export async function shareIdentity(peer: Peer, which?: string | RegExp, { verified = true, timeout = 60_000 } = {}) {
  const mine = await turnMine(peer, which);
  await mine.getByTestId("composer-identity-share").click();
  // Shared, the picker closes: the chat's timeline shows the share.
  await expect(picker(peer)).toHaveCount(0);
  if (verified) await expect(await myStatus(peer, which)).toHaveText("Shared · verified by your contact", { timeout });
  await closePicker(peer);
}

/** Stops sharing one of mine with this chat's contact. */
export async function stopSharing(peer: Peer, which?: string | RegExp) {
  const mine = await turnMine(peer, which);
  await mine.getByRole("button", { name: "Stop sharing" }).click();
  // The back says it is done for a moment, then the card turns face up by itself. The button leaving is what lasts.
  await expect(mine.getByTestId("composer-identity-share")).toHaveCount(0);
  await expect(mine).toHaveAttribute("data-side", "cards");
  await closePicker(peer);
}

/** The contact's ID cards in the panel, one per identity they shared. */
export const theirCards = (peer: Peer) => peer.page.getByTestId("chat-identities-received").getByTestId("chat-identity-received");

/** One of the contact's cards' face (by what it says, or the first): its `data-status` is verified, expiring, failed, revoked, expired or withdrawn. */
export const theirFace = (peer: Peer, which?: string | RegExp) => {
  const cards = theirCards(peer);
  return (which === undefined ? cards.first() : cards.filter({ hasText: which })).locator("[data-deck=face]");
};

/** Turns one of the contact's cards over (by what it says, or the first): how it was checked, Check again. */
export async function turnTheirs(peer: Peer, which?: string | RegExp) {
  const received = peer.page.getByTestId("chat-identities-received");
  if (await received.getByTestId("chat-identity-back").count()) await backToTheirCards(peer);
  const cards = theirCards(peer);
  await (which === undefined ? cards.first() : cards.filter({ hasText: which })).click();
  const back = received.getByTestId("chat-identity-back");
  await expect(back).toBeVisible();
  return back;
}

export async function backToTheirCards(peer: Peer) {
  await peer.page.getByTestId("chat-identity-cards").click();
  await expect(peer.page.getByTestId("chat-identity-back")).toHaveCount(0);
}

/**
 * Settings → Load public profiles (on by default): identity cards then ask their network for the profile once on
 * screen. Specs that count the requests a relay gets for something else turn it off first. Leaves the page on Settings.
 */
export async function setLoadPublicProfiles(peer: Peer, on: boolean) {
  await peer.page.evaluate(() => { location.hash = "#/settings"; });
  const toggle = peer.page.getByTestId("settings-public-profiles");
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
}
