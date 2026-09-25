import type { Locator } from "@playwright/test";
import { expect, type Peer } from "./fixtures";

/**
 * A chat's identities panel (src/components/identities/ContactIdentitiesPanel.tsx), the way a person uses it: opened
 * from the contact's marks in the chat's header, the contact's ID cards on top (a click turns one over), and under
 * "Yours, for this contact" the chat's identity picker (a click on a card turns it over to Share or Stop sharing).
 */

/**
 * The contact's marks in the chat's header (ContactMarks.tsx `IdentityStack`), always there in a paired chat: the
 * proofs they shared (`chat-identity-badge`), or their Ghostly mark alone (`chat-identity-ghostly-mark`) when none.
 */
export const headerMarks = (peer: Peer) => peer.page.getByTestId("chat-identity-badges");

/** A click on the header's marks; the panel beside the chat. */
export async function openIdentities(peer: Peer) {
  const panel = peer.page.getByTestId("chat-identities");
  if (await panel.count()) return panel;
  await headerMarks(peer).click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeIdentities(peer: Peer) {
  await peer.page.getByTestId("chat-identities-close").click();
  await expect(peer.page.getByTestId("chat-identities")).toHaveCount(0);
}

/** One of my identities in the panel's picker, by what its card says (its provider, its subject). */
const myCard = (peer: Peer, which?: string | RegExp) => {
  const cards = peer.page.getByTestId("chat-identities-mine").getByTestId("composer-identity");
  return which === undefined ? cards.first() : cards.filter({ hasText: which });
};

/** Turns one of my cards over: its back says where it stands with this contact. Leaves it turned. */
export async function turnMine(peer: Peer, which?: string | RegExp) {
  const mine = peer.page.getByTestId("chat-identities-mine");
  if (await mine.getByTestId("composer-identity-back").count()) await backToMyCards(peer);
  await myCard(peer, which).click();
  await expect(mine.getByTestId("composer-identity-back")).toBeVisible();
  return mine;
}

export async function backToMyCards(peer: Peer) {
  const mine = peer.page.getByTestId("chat-identities-mine");
  const back = mine.getByTestId("composer-identity-change-card");
  if (await back.count()) await back.click();
  await expect(mine.getByTestId("chat-identities-picker")).toHaveAttribute("data-side", "cards");
}

/** Where one of mine stands with this contact ("Shared · verified by your contact", "Not shared"…), read on its back. */
export async function myStatus(peer: Peer, which?: string | RegExp) {
  const mine = await turnMine(peer, which);
  return mine.getByTestId("composer-identity-status");
}

/** Shares one of mine with this chat's contact and waits until the contact's app verified it (within `timeout`). */
export async function shareIdentity(peer: Peer, which?: string | RegExp, { verified = true, timeout = 60_000 } = {}) {
  await openIdentities(peer);
  const mine = await turnMine(peer, which);
  await mine.getByTestId("composer-identity-share").click();
  await doneAndTurned(mine);
  if (verified) await expect(await myStatus(peer, which)).toHaveText("Shared · verified by your contact", { timeout });
  await backToMyCards(peer);
}

/** Stops sharing one of mine with this chat's contact. */
export async function stopSharing(peer: Peer, which?: string | RegExp) {
  await openIdentities(peer);
  const mine = await turnMine(peer, which);
  await mine.getByRole("button", { name: "Stop sharing" }).click();
  await doneAndTurned(mine);
}

/**
 * After Share or Stop sharing: the back says it is done (`composer-identity-done`, for DONE_MS only, too short to
 * wait on under load), then the card turns face up by itself. The button leaving is what lasts.
 */
async function doneAndTurned(mine: Locator) {
  await expect(mine.getByTestId("composer-identity-share")).toHaveCount(0);
  await expect(mine.getByTestId("chat-identities-picker")).toHaveAttribute("data-side", "cards");
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
