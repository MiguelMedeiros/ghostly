import { copyInvite } from "./clipboard";
import { pasteInvite } from "./clipboard";
import { expect, type Peer } from "./fixtures";
/** Fresh disposable peers: first use is automatic, so this takes no comparison. */
export async function pair(host: Peer, guest: Peer) {
  await host.page.getByTitle("New Chat").click();
  const invite = await copyInvite(host.page);
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(guest.page, invite);
  // The composer is open before the contact is (what is written waits, WISP 400): paired means live on both sides.
  for (const peer of [host, guest]) await expect(peer.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
  for (const peer of [host, guest]) await expect(peer.page.getByPlaceholder("Message…")).toBeEnabled();
  // Open is not verified: neither side has been asked to compare anything.
  for (const peer of [host, guest]) await expect(peer.page.getByTestId("pair-verified")).toHaveCount(0);
}

/** The optional comparison, from the connection panel. Both sides see one code. */
export async function verifyContact(host: Peer, guest: Peer) {
  for (const peer of [host, guest]) {
    await peer.page.getByTestId("connection-options").click();
    await peer.page.getByTestId("pair-verify").click();
  }
  const codes = await Promise.all([host, guest].map(peer => peer.page.getByTestId("pair-code").textContent()));
  expect(codes[0]).toBe(codes[1]);
  for (const peer of [host, guest]) {
    await peer.page.getByTestId("pair-verify-confirm").click();
    await expect(peer.page.getByTestId("pair-verified")).toBeVisible();
  }
}
