import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, test, type Peer } from "../support/fixtures";
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
async function identities(peer: Peer) {
  await peer.page.getByTitle("Options").click();
  await peer.page.getByTestId("chat-identities-open").click();
  return peer.page.getByTestId("chat-identities");
}
const close = (peer: Peer) => peer.page.getByTestId("chat-identities").getByRole("button", { name: "Close" }).click();

test("a Nostr identity is proven once, shared with one contact only, withdrawn, and expires", async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("idp-alice"), peer("idp-bob"), peer("idp-carol")]);
  const pubkey = await injectNostrSigner(alice);

  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);
  const withCarol = await chatId(alice);

  // Profile → Identities: signed once by the NIP-07 signer, checked before it is saved.
  await go(alice, "#/profile");
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  await expect(add.getByTestId("add-identity-signer")).toHaveValue("nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  const proof = alice.page.getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText("Nostr");
  await expect(proof).toContainText("Not shared");

  // Shared with Bob, and only with Bob.
  await go(alice, withBob);
  let dialog = await identities(alice);
  await dialog.getByTestId("chat-identity-share").click();
  await expect(dialog.getByTestId("chat-identity-mine-status")).toHaveText("Shared · verified by your contact");
  await close(alice);

  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  dialog = await identities(bob);
  const received = dialog.getByTestId("chat-identity-received");
  await expect(received).toHaveCount(1);
  await expect(received).toHaveAttribute("data-status", "verified");
  await expect(received.getByTestId("chat-identity-received-status")).toHaveText("Verified");
  await expect(received).toContainText("Their own key");
  await received.getByText("Details").click();
  await expect(received.getByTestId("chat-identity-received-subject")).toHaveText(pubkey);
  await expect(received).toContainText("Nostr signature");
  await close(bob);

  dialog = await identities(carol);
  await expect(dialog.getByTestId("chat-identities-none")).toBeVisible();
  await expect(dialog.getByTestId("chat-identity-received")).toHaveCount(0);
  await close(carol);
  await expect(carol.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  // Alice's chat with Carol offers it, but has not shared it.
  await go(alice, withCarol);
  dialog = await identities(alice);
  await expect(dialog.getByTestId("chat-identity-mine-status")).toHaveText("Not shared");
  await close(alice);

  // Withdrawn: Bob's app says so, and the badge goes.
  await go(alice, withBob);
  dialog = await identities(alice);
  await dialog.getByTestId("chat-identity-withdraw").click();
  await expect(dialog.getByTestId("chat-identity-mine-status")).toHaveText("Not shared");
  await close(alice);
  await expect(bob.page.getByTestId("chat-identity-badges")).toHaveCount(0);
  dialog = await identities(bob);
  await expect(dialog.getByTestId("chat-identity-received")).toHaveAttribute("data-status", "withdrawn");
  await expect(dialog.getByTestId("chat-identity-received-status")).toHaveText("No longer shared");
  await close(bob);

  // Shared again, then Bob's clock passes its validity (90 days): expired, never shown as verified.
  dialog = await identities(alice);
  await dialog.getByTestId("chat-identity-share").click();
  await expect(dialog.getByTestId("chat-identity-mine-status")).toHaveText("Shared · verified by your contact");
  await close(alice);
  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  await bob.page.clock.setFixedTime(Date.now() + 91 * 86_400_000);
  dialog = await identities(bob);
  await expect(dialog.getByTestId("chat-identity-received")).toHaveAttribute("data-status", "expired");
  await expect(dialog.getByTestId("chat-identity-received-status")).toHaveText("Expired");
  await close(bob);
  await expect(bob.page.getByTestId("chat-identity-badges")).toHaveCount(0);
});
