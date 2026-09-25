import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, myStatus, openIdentities, shareIdentity, stopSharing, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";

/**
 * A NIP-07 signer in the page, like a Nostr browser extension. Its key stays in the test process: the page
 * only gets the public key and the signed events. A disposable key, never a real account.
 */
async function injectNostrSigner(peer: Peer): Promise<string> {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  await peer.page.exposeFunction("__testNostrPubkey", () => pubkey);
  await peer.page.exposeFunction("__testNostrSign", (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret));
  await peer.context.addInitScript(() => {
    const w = window as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & { nostr?: unknown };
    w.nostr = { getPublicKey: () => w.__testNostrPubkey(), signEvent: (event: unknown) => w.__testNostrSign(event) };
  });
  await peer.page.reload();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
  return pubkey;
}

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);

test("a Nostr identity is proven once, shared with one contact only, withdrawn, and expires", { tag: ["@feature:proofs.nostr", "@feature:proofs.share", "@feature:proofs.withdraw", "@feature:proofs.expiry"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("idp-alice"), peer("idp-bob"), peer("idp-carol")]);
  const pubkey = await injectNostrSigner(alice);

  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);
  const withCarol = await chatId(alice);

  // Identities: signed once by the NIP-07 signer, checked before it is saved.
  await go(alice, "#/identities");
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveAttribute("data-value", "nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  const proof = alice.page.getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText("Nostr");
  await expect(proof).toContainText("Not shared");

  // Shared with Bob, and only with Bob.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);

  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  await expect(theirCards(bob)).toContainText("Their own key");
  let back = await turnTheirs(bob);
  await expect(back.getByTestId("chat-identity-received-status")).toHaveText("Verified");
  await expect(back.getByTestId("chat-identity-received-subject")).toHaveAttribute("title", pubkey);
  await expect(back).toContainText("Nostr signature");
  await closeIdentities(bob);

  const none = await openIdentities(carol);
  await expect(none.getByTestId("chat-identities-none")).toBeVisible();
  await expect(theirCards(carol)).toHaveCount(0);
  await closeIdentities(carol);
  await expect(carol.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  // Alice's chat with Carol offers it, but has not shared it.
  await go(alice, withCarol);
  await openIdentities(alice);
  await expect(await myStatus(alice)).toHaveText("Not shared");
  await closeIdentities(alice);

  // Withdrawn: Bob's app says so, and the badge goes.
  await go(alice, withBob);
  await stopSharing(alice);
  await expect(await myStatus(alice)).toHaveText("Not shared");
  await closeIdentities(alice);
  await expect(bob.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "withdrawn");
  back = await turnTheirs(bob);
  await expect(back.getByTestId("chat-identity-received-status")).toHaveText("No longer shared");
  await closeIdentities(bob);

  // Shared again, then Bob's clock passes its validity (90 days): expired, never shown as verified.
  await shareIdentity(alice);
  await closeIdentities(alice);
  const badges = bob.page.getByTestId("chat-identity-badges");
  await expect(badges.getByTestId("chat-identity-badge")).toHaveAttribute("data-state", "verified");
  await bob.page.clock.setFixedTime(Date.now() + 91 * 86_400_000);
  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "expired");
  back = await turnTheirs(bob);
  await expect(back.getByTestId("chat-identity-received-status")).toHaveText("Expired");
  await closeIdentities(bob);
  // The header keeps its mark, greyed as expired, without the check.
  await expect(badges.getByTestId("chat-identity-badge")).toHaveAttribute("data-state", "expired");
  await expect(badges.getByTestId("chat-identity-check-1")).toHaveCount(0);
});

test("removing a proof revokes it for a contact the person never reconnects to", { tag: ["@feature:proofs.nostr", "@feature:proofs.revoke", "@feature:proofs.page"] }, async ({ peer, relay }) => {
  const [alice, carol] = await Promise.all([peer("idr-alice"), peer("idr-carol")]);
  await injectNostrSigner(alice);
  await pair(alice, carol);
  const withCarol = await chatId(alice);
  await go(alice, "#/identities");
  await alice.page.getByTestId("identity-add").click();
  await alice.page.getByTestId("add-identity-nostr").click();
  await alice.page.getByTestId("add-identity-start").click();
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(1);
  await go(alice, withCarol);
  await shareIdentity(alice);
  await closeIdentities(alice);
  await expect(carol.page.getByTestId("chat-identity-badges")).toBeVisible();

  // Carol's app is closed when Alice removes it: the withdrawal cannot reach her, the revocation goes to Pkarr.
  const carolChat = await chatId(carol);
  await carol.page.goto("about:blank");
  await go(alice, "#/identities");
  // The page opens on the Ghostly card (#238): the proof's card first.
  await alice.page.getByTestId("identity-proof").click();
  await alice.page.getByTestId("identity-proof-remove").click();
  await alice.page.getByTestId("identity-proof-remove-confirm").click();
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(0);
  await expect.poll(() => [...relay.packets.values()].some(packet => packet.includes("_ghostly-revoked"))).toBe(true);
  await alice.context.close();

  // Alice never comes back. Carol opens Ghostly again and checks: revoked.
  await carol.page.goto(`/${carolChat}`);
  await expect(carol.page.getByPlaceholder("Message…")).toBeVisible();
  await openIdentities(carol);
  await expect(theirFace(carol)).toHaveAttribute("data-status", /verified|revoked/);
  const back = await turnTheirs(carol);
  // The app also looks by itself a minute after starting; either way it ends revoked.
  if (await back.getAttribute("data-status") === "verified") await back.getByTestId("chat-identity-recheck").click();
  await expect(back).toHaveAttribute("data-status", "revoked");
  await expect(back.getByTestId("chat-identity-received-status")).toHaveText("Revoked: its owner removed it and published a revocation");
  await closeIdentities(carol);
  // The header keeps its mark, struck through as revoked, without the check.
  const badges = carol.page.getByTestId("chat-identity-badges");
  await expect(badges.getByTestId("chat-identity-badge")).toHaveAttribute("data-state", "revoked");
  await expect(badges.getByTestId("chat-identity-check-1")).toHaveCount(0);

  // The account bar's Identities carries a dot for it until Carol has seen it on the Identities page.
  await expect(carol.page.getByTestId("account-identities").getByTestId("identities-attention")).toBeVisible();
  await carol.page.getByTestId("account-identities").click();
  await expect(carol.page.getByTestId("identity-received").getByTestId("identity-received-status")).toHaveText("Revoked by its owner");
  await expect(carol.page.getByTestId("identities-attention")).toHaveCount(0);
});
