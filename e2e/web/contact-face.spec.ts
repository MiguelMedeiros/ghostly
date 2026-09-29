import { mkdirSync, readFileSync } from "node:fs";
import { DEFAULT_NOSTR_RELAYS, expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, stopSharing } from "../support/identities";
import { LocalNostrRelay } from "../support/nostrRelay";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";
import { choose } from "../support/select";

/**
 * A contact shown as one of their identities (docs/wisps/PUBLIC-PROFILES.md, Name and photo of a contact): Alice
 * shares a Nostr identity whose profile has a name and a picture; Bob picks it under Show as in her identities, and
 * his chat list and header show her profile's name and photo, the Nostr mark on the avatar's corner. Her marks' card
 * names the identity. When she withdraws the proof, Bob's list falls back to her own name at once. No public host is
 * reached: the test relay answers the default relays, and the picture host is answered here.
 */

const WEBP = readFileSync(new URL("../support/avatar-fixtures/avatar-lossy.webp", import.meta.url));
const CORS = { "access-control-allow-origin": "*" };
const now = () => Math.floor(Date.now() / 1000);
/** Screenshots for the pull request, when E2E_SHOTS names a directory. */
async function shot(peer: Peer, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await peer.page.waitForTimeout(500);
  await peer.page.screenshot({ path: `${dir}/${name}.png` });
}

test("a contact shown as their Nostr profile in the chat list and header, and back to their own name once the proof is withdrawn", {
  tag: ["@feature:proofs.contact-face", "@feature:proofs.badges", "@feature:proofs.public-profile.nostr", "@feature:proofs.share", "@feature:proofs.withdraw"],
}, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const relay = new LocalNostrRelay();
  const [alice, bob] = await Promise.all([peer("cf-alice"), peer("cf-bob")]);
  await Promise.all([relay.attach(alice.context, "alice", DEFAULT_NOSTR_RELAYS), relay.attach(bob.context, "bob", DEFAULT_NOSTR_RELAYS)]);
  for (const p of [alice, bob]) await p.context.route("https://image.nostr.build/**", route => route.fulfill({ status: 200, contentType: "image/webp", headers: CORS, body: WEBP }));
  const a = await injectNostrSigner(alice);
  relay.add({ kind: 0, created_at: now() - 600, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice Nostr", picture: "https://image.nostr.build/alice.webp" }) }, a.secret);
  await addNostrIdentity(alice);

  await pair(alice, bob);
  await shareIdentity(alice, "Nostr");
  await closeIdentities(alice);

  const row = bob.page.getByTestId("chat-row").first();
  const name = row.getByTestId("chat-row-name");
  await expect(row.getByTestId("contact-mark")).toHaveAttribute("data-icon", "nostr", { timeout: 60_000 });
  const ownName = (await name.textContent())!;
  expect(ownName).not.toBe("Alice Nostr");

  // Her identities: Show as offers her only profile with one tap; Bob picks it in the select instead.
  const panel = await openIdentities(bob);
  const showAs = panel.getByTestId("contact-face");
  await expect(showAs.getByTestId("contact-face-suggest")).toContainText("Use Nostr name & photo");
  await expect(showAs.getByTestId("contact-face-suggest")).toContainText("Alice Nostr");
  await shot(bob, "show-as-offer");
  await choose(showAs.getByTestId("contact-face-select"), `nostr:${a.pubkey}`);
  await expect(showAs.getByTestId("contact-face-suggest")).toHaveCount(0);
  await closeIdentities(bob);

  // The list and the header: her profile's name and photo, the Nostr mark on the avatar's corner.
  await expect(name).toHaveText("Alice Nostr");
  await expect(row.getByTestId("chat-row-avatar")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await expect(row.getByTestId("contact-face-corner")).toHaveAttribute("data-provider", "nostr");
  await expect(bob.page.getByTestId("chat-name")).toHaveText("Alice Nostr");
  await expect(bob.page.getByTestId("chat-avatar")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  // Her Ghostly key stays in the row's tooltip.
  await expect(row).toHaveAttribute("title", /^Alice Nostr · \S+/);

  // Her mark in the list names the identity on hover, and the hover opens nothing.
  const url = bob.page.url();
  await row.getByTestId("contact-mark").hover();
  const tip = bob.page.getByTestId("contact-marks-tip");
  await expect(tip.getByTestId("identity-tip-name")).toHaveText("Alice Nostr");
  await expect(tip.getByTestId("identity-tip-state")).toHaveText(/^Verified /);
  await expect(tip.getByTestId("identity-tip-source")).toContainText("Loaded from relay.damus.io");
  await shot(bob, "list-card");
  expect(bob.page.url()).toBe(url);
  await bob.page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);

  // Search finds her by the profile's name.
  const search = bob.page.getByPlaceholder(/search/i);
  await search.fill("nostr");
  await expect(bob.page.getByTestId("chat-row")).toHaveCount(1);
  await search.fill("");

  // Withdrawn: the proof no longer vouches for the profile, and Bob's list shows her own name again.
  await stopSharing(alice, "Nostr");
  await closeIdentities(alice);
  await expect(name).toHaveText(ownName, { timeout: 60_000 });
  await expect(row.getByTestId("contact-face-corner")).toHaveCount(0);
  await expect(bob.page.getByTestId("chat-name")).toHaveText(ownName);
});
