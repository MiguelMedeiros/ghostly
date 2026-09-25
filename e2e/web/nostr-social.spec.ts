import { readFileSync } from "node:fs";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, turnTheirs } from "../support/identities";
import { LocalNostrRelay, NOSTR_TEST_RELAY } from "../support/nostrRelay";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";

/**
 * The Nostr social layer on top of a shared Nostr proof: what a contact's proven key lets a person see
 * (profile, follows, notes), each part loaded only when asked, from the relays in their profile, with
 * its source and freshness shown; and what publication lets them do, through their own signer, each
 * action confirmed. The relay lives in the test process; the signers are disposable keys in the test.
 */

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
const now = () => Math.floor(Date.now() / 1000);

/** Identities → Nostr: this app asks the test relay and nothing else. */
async function useTestRelay(peer: Peer) {
  await go(peer, "#/identities");
  const relays = peer.page.getByTestId("nostr-relays");
  await expect(relays).toHaveValue("wss://relay.damus.io\nwss://nos.lol");
  await relays.fill(NOSTR_TEST_RELAY);
  await peer.page.getByTestId("nostr-relays-save").click();
  await expect(peer.page.getByTestId("nostr-relays-save")).toBeDisabled();
  await expect(relays).toHaveValue(NOSTR_TEST_RELAY);
  // Kept by the engine, not only shown: a fresh page reads it back.
  await peer.page.reload();
  await expect(relays).toHaveValue(NOSTR_TEST_RELAY);
}

test("a contact's profile, follows and notes load only on request from the person's relays; nothing loads without the shared proof; publication goes through the person's own signer", { tag: ["@feature:nostr.social.profile", "@feature:nostr.social.follows", "@feature:nostr.social.notes", "@feature:nostr.social.no-proof", "@feature:nostr.social.publish", "@feature:proofs.nostr", "@feature:proofs.share"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const relay = new LocalNostrRelay();
  const [alice, bob, carol] = await Promise.all([peer("ns-alice"), peer("ns-bob"), peer("ns-carol")]);
  await Promise.all([relay.attach(alice.context, "alice"), relay.attach(bob.context, "bob"), relay.attach(carol.context, "carol")]);
  const [a, b] = await Promise.all([injectNostrSigner(alice), injectNostrSigner(bob)]);
  const other = getPublicKey(generateSecretKey());

  // What the relay holds before anyone asks: Alice's profile, follows and notes; Bob's follows and mute list.
  relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice in Chains", about: "Just here for the ghosts.", picture: "https://image.nostr.build/alice.png", nip05: "alice@example.com" }), created_at: now() - 3600 }, a.secret);
  relay.add({ kind: 3, tags: [["p", b.pubkey], ["p", other]], content: "", created_at: now() - 3000 }, a.secret);
  relay.add({ kind: 1, tags: [], content: "Good morning, Nostr", created_at: now() - 2000 }, a.secret);
  relay.add({ kind: 1, tags: [], content: "Win big at the casino tonight", created_at: now() - 1500 }, a.secret);
  relay.add({ kind: 1, tags: [], content: "Ghostly is neat", created_at: now() - 1000 }, a.secret);
  relay.add({ kind: 3, tags: [["p", a.pubkey], ["p", other]], content: "", created_at: now() - 2500 }, b.secret);
  relay.add({ kind: 10000, tags: [["word", "casino"]], content: "", created_at: now() - 2400 }, b.secret);
  // Alice's picture, from a host Ghostly fetches pictures from.
  const png = readFileSync(new URL("../../src-tauri/icons/32x32.png", import.meta.url));
  let pictureFetches = 0;
  await bob.context.route("https://image.nostr.build/**", route => { pictureFetches++; return route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: png }); });

  await addNostrIdentity(alice);
  await addNostrIdentity(bob);
  await useTestRelay(bob);
  await pair(alice, bob);
  const withBob = await chatId(alice);
  const bobsChat = await chatId(bob);
  await pair(alice, carol);

  // Alice shares her Nostr identity with Bob only.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);

  // Carol got no proof: no Nostr card, and her app never asked any relay.
  const none = await openIdentities(carol);
  await expect(none.getByTestId("chat-identities-none")).toBeVisible();
  await expect(none.getByTestId("nostr-contact")).toHaveCount(0);
  await closeIdentities(carol);

  // Bob sees the card, turned over, and nothing was fetched before he asks.
  await expect(bob.page.getByTestId("chat-identity-badges")).toBeVisible();
  await openIdentities(bob);
  const back = await turnTheirs(bob, "Nostr");
  const card = back.getByTestId("nostr-contact");
  await expect(card).toHaveAttribute("data-subject", a.pubkey);
  await expect(card).toContainText("relay.ghostly.test");
  expect(relay.requests).toEqual([]);
  await expect(card.getByTestId("nostr-profile-name")).toHaveCount(0);

  // Profile, on request: name, picture, about, NIP-05, with its source and time; the proof card takes the name.
  await card.getByTestId("nostr-load-profile").click();
  await expect(card.getByTestId("nostr-profile-name")).toContainText("Alice in Chains");
  await expect(card.getByTestId("nostr-profile-name")).toContainText("@alice");
  await expect(card.getByTestId("nostr-profile-about")).toHaveText("Just here for the ghosts.");
  await expect(card.getByTestId("nostr-profile-nip05")).toContainText("alice@example.com");
  await expect(card.getByTestId("nostr-profile-avatar")).toBeVisible();
  await expect(card.getByTestId("nostr-profile-source")).toContainText("from relay.ghostly.test");
  await expect(card.getByTestId("nostr-profile-source")).toContainText("Self-described");
  await expect(back).toContainText("Nostr · Alice in Chains");
  expect(pictureFetches).toBe(1);
  expect(relay.requests).toEqual([{ by: "bob", filter: { kinds: [0], authors: [a.pubkey], limit: 3 } }]);

  // Follows: the count, then the hints against Bob's own list once he loads it, each with its direction.
  await card.getByTestId("nostr-load-follows").click();
  await expect(card.getByTestId("nostr-follows-count")).toHaveText("Follows 2 accounts");
  await expect(card.getByTestId("nostr-hints")).toHaveCount(0);
  await card.getByTestId("nostr-load-own").click();
  await expect(card.getByTestId("nostr-hint-follows-you")).toContainText("Follows you");
  await expect(card.getByTestId("nostr-hint-you-follow")).toContainText("You follow them");
  await expect(card.getByTestId("nostr-hint-mutual")).toHaveText("You both follow 1 account");

  // Notes: newest first, the one matching Bob's mute list hidden and counted.
  await card.getByTestId("nostr-load-notes").click();
  const notes = card.getByTestId("nostr-note");
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText("Ghostly is neat");
  await expect(notes.nth(1)).toContainText("Good morning, Nostr");
  await expect(card.getByTestId("nostr-notes-hidden")).toHaveText("1 note hidden by your mute list.");
  await expect(card.getByTestId("nostr-notes-more")).toHaveCount(0);
  // Only Bob asked, and only about Alice's key and his own.
  expect(relay.requests.every(r => r.by === "bob" && r.filter.authors?.every(k => k === a.pubkey || k === b.pubkey))).toBe(true);

  // Publication is off: no follow button, no posting.
  await expect(card.getByTestId("nostr-follow")).toHaveCount(0);
  await expect(card.getByTestId("nostr-unfollow")).toHaveCount(0);
  await closeIdentities(bob);
  await go(bob, "#/identities");
  await expect(bob.page.getByTestId("nostr-post")).toHaveCount(0);
  await bob.page.getByTestId("nostr-publish").click();
  await expect(bob.page.getByTestId("nostr-publish")).toHaveAttribute("aria-checked", "true");

  // A note: drafted, shown with the public notice, confirmed, signed by the NIP-07 signer, sent.
  await bob.page.getByTestId("nostr-post").click();
  await bob.page.getByTestId("nostr-post-text").fill("Hello from Ghostly");
  await bob.page.getByTestId("nostr-post-submit").click();
  const publish = bob.page.getByTestId("nostr-publish-dialog");
  await expect(publish.getByTestId("nostr-publish-preview")).toHaveText("Hello from Ghostly");
  await expect(publish.getByTestId("nostr-publish-notice")).toContainText("Public on Nostr");
  await expect(publish.getByTestId("nostr-publish-notice")).toContainText(NOSTR_TEST_RELAY);
  expect(relay.published).toEqual([]);
  await publish.getByTestId("nostr-publish-confirm").click();
  await expect(publish.getByTestId("nostr-publish-result")).toContainText(`Published to ${NOSTR_TEST_RELAY}`);
  await publish.getByTestId("nostr-publish-close").click();
  expect(relay.published).toHaveLength(1);
  expect(relay.published[0]).toMatchObject({ by: "bob", event: { kind: 1, pubkey: b.pubkey, content: "Hello from Ghostly" } });

  // The profile: the fields Bob edits change, the ones he does not are kept.
  relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "bob", lud16: "bob@wallet.example" }), created_at: now() - 100 }, b.secret);
  await bob.page.getByTestId("nostr-own-load").click();
  await expect(bob.page.getByTestId("nostr-own-name")).toHaveText("bob");
  await bob.page.getByTestId("nostr-profile-edit").click();
  await bob.page.getByTestId("nostr-profile-name").fill("Bobby");
  await bob.page.getByTestId("nostr-profile-about").fill("Ghostly user");
  await bob.page.getByTestId("nostr-profile-submit").click();
  await expect(publish.getByTestId("nostr-publish-preview")).toContainText("Bobby");
  await publish.getByTestId("nostr-publish-confirm").click();
  await expect(publish.getByTestId("nostr-publish-result")).toBeVisible();
  await publish.getByTestId("nostr-publish-close").click();
  expect(JSON.parse(relay.published[1].event.content)).toEqual({ name: "bob", lud16: "bob@wallet.example", display_name: "Bobby", about: "Ghostly user" });
  await expect(bob.page.getByTestId("nostr-own-name")).toHaveText("Bobby");

  // Unfollow, then follow again, from the contact's card: the rest of the list travels unchanged.
  await go(bob, bobsChat);
  await openIdentities(bob);
  await turnTheirs(bob, "Nostr");
  await card.getByTestId("nostr-unfollow").click();
  await expect(publish.getByTestId("nostr-publish-preview")).toContainText("1 account");
  await publish.getByTestId("nostr-publish-confirm").click();
  await expect(publish.getByTestId("nostr-publish-result")).toBeVisible();
  await publish.getByTestId("nostr-publish-close").click();
  expect(relay.published[2].event).toMatchObject({ kind: 3, pubkey: b.pubkey, tags: [["p", other]] });
  await expect(card.getByTestId("nostr-hint-you-follow")).toContainText("You do not follow them");
  await card.getByTestId("nostr-follow").click();
  await publish.getByTestId("nostr-publish-confirm").click();
  await expect(publish.getByTestId("nostr-publish-result")).toBeVisible();
  await publish.getByTestId("nostr-publish-close").click();
  expect(relay.published[3].event).toMatchObject({ kind: 3, pubkey: b.pubkey, tags: [["p", other], ["p", a.pubkey]] });
  await expect(card.getByTestId("nostr-hint-you-follow")).toContainText("You follow them");
  // The signer signed exactly what was published, plus the one identity proof; nothing else was asked of it.
  expect([b.signed(1), b.signed(0), b.signed(3), b.signed(30078)]).toEqual([1, 1, 2, 1]);
  expect(a.signed(0) + a.signed(1) + a.signed(3)).toBe(0);
  expect(relay.published.every(p => p.by === "bob")).toBe(true);
  await closeIdentities(bob);
});
