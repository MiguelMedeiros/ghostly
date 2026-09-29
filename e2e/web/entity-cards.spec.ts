import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { copyInvite } from "../support/clipboard";
import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { LocalNostrRelay } from "../support/nostrRelay";
import { pair } from "../support/paired";

/**
 * What a message's text names gets a card under it (src/lib/parse/entities.ts): an invite joins only on a tap, by the
 * Join dialog's rules; a Nostr key loads only on a tap, from the reader's own relays.
 */

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
const connected = (peer: Peer) => expect(peer.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });

test("an invite sent in a chat is a card: the contact joins with a tap, the sender's own is refused", { tag: ["@feature:chat.cards.invite", "@feature:invite.own", "@feature:invite.rejoin"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("ec-alice"), peer("ec-bob")]);
  await pair(alice, bob);
  const [alicesChat, bobsChat] = await Promise.all([chatId(alice), chatId(bob)]);

  // Alice makes a second invite and sends its link to Bob, inside a sentence.
  await alice.page.getByTitle("New Chat").click();
  const link = await copyInvite(alice.page);
  const invitesChat = await chatId(alice);
  await go(alice, alicesChat);
  await say(alice, `for your other profile: ${link} thanks`);

  // Her own invite: the card says so, offers the chat that owns it, and has no Join.
  const own = chat(alice).getByTestId("entity-invite");
  await expect(own).toHaveAttribute("data-outcome", "own");
  await expect(own.getByTestId("entity-invite-own")).toContainText("This is your own invite");
  await expect(own.getByTestId("entity-invite-join")).toHaveCount(0);

  // Bob's card: from Alice, nothing joined until he taps.
  const card = chat(bob).getByTestId("entity-invite");
  await expect(card).toHaveAttribute("data-outcome", "new");
  await expect(card).toContainText("From");
  await expect(chat(bob).getByTestId("message-text").last()).toContainText(link);
  expect(await chatId(bob)).toBe(bobsChat);
  await card.getByTestId("entity-invite-join").click();

  // The tap made a new chat, and it pairs with the chat the invite came from.
  await expect.poll(() => chatId(bob)).not.toBe(bobsChat);
  const joined = await chatId(bob);
  await connected(bob);
  await go(alice, invitesChat);
  await connected(alice);
  await say(bob, "in by the card");
  await expect(chat(alice).getByText("in by the card")).toBeVisible();

  // Back where the invite was sent, the card opens that chat, never a second one.
  await go(bob, bobsChat);
  const again = chat(bob).getByTestId("entity-invite");
  await expect(again).toHaveAttribute("data-outcome", "joined");
  await again.getByTestId("entity-invite-open").click();
  await expect.poll(() => chatId(bob)).toBe(joined);

  // And Alice's own card takes her to the chat it made.
  await go(alice, alicesChat);
  await chat(alice).getByTestId("entity-invite").getByTestId("entity-invite-open").click();
  await expect.poll(() => chatId(alice)).toBe(invitesChat);
});

test("an npub in a message is a card that loads the profile from the reader's relays, only on a tap", { tag: ["@feature:chat.cards.nostr"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const relay = new LocalNostrRelay();
  const [alice, bob] = await Promise.all([peer("ecn-alice"), peer("ecn-bob")]);
  // Neither has changed the relays: the app's defaults are answered here, and no real relay is reached.
  const defaults = ["wss://relay.damus.io", "wss://nos.lol"];
  await Promise.all([relay.attach(alice.context, "alice", defaults), relay.attach(bob.context, "bob", defaults)]);
  // A route covers pages loaded after it: the peers' pages were open already.
  await Promise.all([alice.page.reload(), bob.page.reload()]);
  const dave = generateSecretKey();
  const D = getPublicKey(dave);
  relay.add({ kind: 0, tags: [], content: JSON.stringify({ name: "dave", display_name: "Dave Nostr", about: "A stranger on Nostr." }), created_at: Math.floor(Date.now() / 1000) - 60 }, dave);

  await pair(alice, bob);
  await say(alice, `follow nostr:${npubEncode(D)} for ghost news`);

  const card = chat(bob).getByTestId("entity-nostr");
  await expect(card).toHaveAttribute("data-type", "profile");
  await expect(card.getByTestId("entity-nostr-where")).toContainText("relay.damus.io, nos.lol");
  expect(relay.requests).toEqual([]);

  await card.getByTestId("entity-nostr-load").click();
  await expect(card.getByTestId("entity-nostr-title")).toHaveText("Dave Nostr");
  await expect(card.getByTestId("entity-nostr-about")).toHaveText("A stranger on Nostr.");
  await expect(card.getByTestId("entity-nostr-source")).toContainText("From ");
  // Only Bob asked, only for Dave's profile.
  expect(relay.requests.every(r => r.by === "bob" && r.filter.authors?.[0] === D && r.filter.kinds?.[0] === 0)).toBe(true);
  expect(relay.requests.length).toBeGreaterThan(0);
});
