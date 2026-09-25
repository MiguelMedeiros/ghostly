import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { fingerprints as fpr, TestGpg, vector } from "../../packages/browser/test/helpers/gpg";

/**
 * An OpenPGP key proven with a real GnuPG, in the test process, holding committed TEST keys
 * (packages/browser/test/vectors/openpgp). gpg runs the commands the app shows, on the statement
 * the app built in this run; the page only ever sees what gpg printed.
 */
let gpg: TestGpg;
test.beforeAll(() => { gpg = new TestGpg(["alice", "bob", "expired", "revoked"]); });
test.afterAll(() => gpg?.close());

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);

/** Identities → OpenPGP with the plain gpg signer, up to the paste; returns the dialog and the statement. */
async function startPgp(peer: Peer, fingerprint: string) {
  await peer.page.getByTestId("identities-new").click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-openpgp").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveAttribute("data-value", "gpg");
  await add.getByTestId("add-identity-subject").fill(fingerprint.replace(/(.{4})/g, "$1 ")); // as gpg --fingerprint prints it
  await add.getByTestId("add-identity-start").click();
  const statement = (await add.getByTestId("add-identity-copy-2").textContent())!;
  expect(statement).toMatch(new RegExp(`^Ghostly identity proof v1: I control openpgp:${fingerprint} and authorize the Ghostly key `));
  await expect(add.getByTestId("add-identity-copy-0")).toHaveText(`printf '%s' '${statement}' > ghostly-identity.txt`);
  await expect(add.getByTestId("add-identity-copy-1")).toContainText(`gpg --local-user ${fingerprint} --clearsign --output - ghostly-identity.txt`);
  return { add, statement };
}
async function refused(peer: Peer, fingerprint: string, paste: (statement: string) => string, reason: RegExp) {
  const { add, statement } = await startPgp(peer, fingerprint);
  await add.getByTestId("add-identity-paste").fill(paste(statement));
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toHaveText(reason);
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toHaveCount(0);
}

test("an OpenPGP key signed with gpg: refused when it should be, then shared with one contact only", { tag: ["@feature:proofs.openpgp", "@feature:proofs.share"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("pgp-alice"), peer("pgp-bob"), peer("pgp-carol")]);
  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);
  await go(alice, "#/identities");

  // Each refused before anything is saved.
  await refused(alice, fpr.alice, () => `${gpg.clearsign(fpr.alice, "Some other statement")}\n${gpg.exportKey(fpr.alice)}`, /signs different text/);
  await refused(alice, fpr.alice, s => `${gpg.clearsign(fpr.bob, s)}\n${gpg.exportKey(fpr.alice)}`, /made by another key/);
  await refused(alice, fpr.alice, s => `${gpg.clearsign(fpr.bob, s)}\n${gpg.exportKey(fpr.bob)}`, /not the one the statement names/);
  // gpg will not sign with an expired key, so it signs while it was valid (its clock set back): the key has expired since.
  await refused(alice, fpr.expired, s => `${gpg.clearsign(fpr.expired, s, "20260201T000000")}\n${vector("expired.pub.asc")}`, /expired on 2026-06-01/);
  // Signed with the key, pasted with the public key as it is now: carrying its revocation.
  await refused(alice, fpr.revoked, s => `${gpg.clearsign(fpr.revoked, s)}\n${vector("revoked.pub.asc")}`, /revoked/);
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(0);

  // The real one: exactly what the two commands print, pasted at once.
  const { add, statement } = await startPgp(alice, fpr.alice);
  await add.getByTestId("add-identity-paste").fill(`${gpg.clearsign(fpr.alice, statement)}\n${gpg.exportKey(fpr.alice)}`);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(1);
  await expect(alice.page.getByTestId("identity-proof")).toContainText("Not shared");

  // Shared with Bob only.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);

  // Bob's app verified it on its own: fingerprint, how, and the user ID on the card.
  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  await expect(theirCards(bob)).toContainText("Alice Test <alice@example.org>");
  const back = await turnTheirs(bob);
  await expect(back).toHaveAttribute("data-provider", "openpgp");
  await expect(back).toContainText("Alice Test <alice@example.org>");
  await expect(back.getByTestId("chat-identity-received-subject")).toHaveAttribute("title", fpr.alice);
  await expect(back).toContainText("OpenPGP signature (Ed25519 signing subkey, v4 key)");
  // keys.openpgp.org is only ever asked from this button, which says so.
  await expect(back.getByTestId("chat-identity-lookup")).toHaveText("Check emails with keys.openpgp.org");
  await closeIdentities(bob);

  // Carol was never shown it.
  await openIdentities(carol);
  await expect(theirCards(carol)).toHaveCount(0);
  await closeIdentities(carol);
  await expect(carol.page.getByTestId("chat-identity-ghostly-mark")).toBeVisible();
});
