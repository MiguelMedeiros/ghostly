import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace } from "../support/identities";
import { pair } from "../support/paired";
import { choose } from "../support/select";

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** The fake providers (proofs/testing.ts) join the picker; read when the engine starts, hence the reload. */
async function useFakeIdentities(peer: Peer) {
  await peer.page.evaluate(() => localStorage.setItem("ghostly-test-identities", "1"));
  await peer.page.reload();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("every kind of signer: a pasted signature and a provider's attestation, both verified by the contact", { tag: ["@feature:proofs.unverifiable", "@feature:proofs.share", "@feature:proofs.binding"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("idk-alice"), peer("idk-bob")]);
  await useFakeIdentities(alice);
  await pair(alice, bob);
  const chatHash = await alice.page.evaluate(() => location.hash);
  await alice.page.evaluate(() => { location.hash = "#/identities"; });

  // external-tool: the statement is shown to copy, signed outside Ghostly, pasted back.
  const seed = ed25519.utils.randomSecretKey();
  await alice.page.getByTestId("identity-add").click();
  const add = alice.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-fake-key").click();
  await choose(add.getByTestId("add-identity-signer"), "fake-tool");
  await add.getByTestId("add-identity-subject").fill(hex(ed25519.getPublicKey(seed)));
  await add.getByTestId("add-identity-start").click();
  const statement = await add.getByTestId("add-identity-copy-0").textContent();
  expect(statement).toMatch(/^Ghostly identity proof v1: I control fake-key:[a-f0-9]{64} and authorize the Ghostly key /);
  // A signature over anything else is refused before it is saved.
  await add.getByTestId("add-identity-paste").fill(b64url(ed25519.sign(new TextEncoder().encode(`${statement}\n`), seed)));
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toHaveText(/Invalid test signature/);
  await add.getByTestId("add-identity-paste").fill(b64url(ed25519.sign(new TextEncoder().encode(statement!), seed)));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);

  // redirect: a login provider vouches for an account.
  await alice.page.getByTestId("identity-add").click();
  await add.getByTestId("add-identity-fake-account").click();
  await add.getByTestId("add-identity-start").click();
  // The login opens from its own click (a popup needs the click's user activation).
  await expect(add.getByTestId("add-identity-finish")).toHaveText("Continue with Test account");
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(2);
  await expect(alice.page.getByTestId("identity-proof").filter({ hasText: "Attested by issuer.ghostly.test" })).toHaveCount(1);

  // Bob's app has no fake providers: it says it cannot verify them, and nothing is sent.
  await alice.page.evaluate(h => { location.hash = h; }, chatHash);
  const mine = (await openIdentities(alice)).getByTestId("chat-identities-mine");
  // The picker opens on the Ghostly card; the arrow brings the first proof forward without turning it over.
  await mine.getByTestId("composer-identity-deck-next").click();
  await expect(mine.getByTestId("composer-identity").first()).toHaveAttribute("aria-checked", "true");
  await expect(mine.getByTestId("composer-identity-hint")).toContainText("cannot verify");
  await expect(mine.getByTestId("composer-identity-use")).toBeDisabled();
  await closeIdentities(alice);

  // With them, Bob verifies both, and says who vouches for the attested one.
  await useFakeIdentities(bob);
  for (const which of ["Your own key", "Attested by issuer.ghostly.test"]) await shareIdentity(alice, which);
  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(2);
  await expect(theirFace(bob, "Attested by issuer.ghostly.test")).toHaveAttribute("data-status", "verified");
  await expect(theirFace(bob, "Their own key")).toHaveAttribute("data-status", "verified");
});
