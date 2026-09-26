import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { attachPubky, PUBKY_HOMESERVER_HOST, PubkyApprover, pubkyTestnet, scanApprovalQr } from "../support/pubky";

/**
 * A Pubky identity (WISP 302) end to end, against Pubky's testnet in e2e/infra: ONE request for write access to one
 * proof folder, approved in Pubky Passport (a stand-in page, opened from the click) or by scanning the QR code as
 * Pubky Ring would; the statement written to the homeserver and read back through the key's own Pkarr records; a
 * contact verifying it the same way; and removal, which asks again to delete the file and publishes a revocation.
 * `PubkyApprover` (e2e/support/pubky.ts) holds the throwaway key, in the test process.
 */

test.skip(!pubkyTestnet(), "Needs the e2e infra's Pubky testnet (npm run e2e:infra:use)");

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);
const PROOF_FOLDER = /^\/pub\/ghostly\.app\/proofs\/([a-f0-9]{64})\/:w$/;

/** Identities → Add → Pubky → Continue: the approval screen, both ways. */
async function startPubky(peer: Peer) {
  await go(peer, "#/identities");
  await peer.page.getByTestId("identities-new").click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-pubky").click();
  await add.getByTestId("add-identity-start").click();
  await expect(add.getByTestId("approval")).toBeVisible();
  return add;
}

/** Whatever the page logged, for checking that no request (it carries a relay secret) was ever printed. */
function collectLogs(peer: Peer): string[] {
  const logs: string[] = [];
  peer.context.on("console", message => logs.push(message.text()));
  peer.page.on("pageerror", error => logs.push(error.message));
  return logs;
}

test("a Pubky identity approved in Passport is verified by a contact; removing it deletes its file and revokes it", { tag: ["@feature:proofs.pubky", "@feature:proofs.share", "@feature:proofs.revoke", "@gated"] }, async ({ peer, relay }) => {
  test.setTimeout(240_000);
  const approver = await new PubkyApprover(relay).start();
  try {
    const [alice, bob] = await Promise.all([peer("pubky-alice"), peer("pubky-bob")]);
    const logs = collectLogs(alice);
    await attachPubky(alice.context, relay, approver);
    await attachPubky(bob.context, relay);
    // Bob's app cannot read Quad9, the default resolver, as in the Mac desktop app and Safari (WebKit reaches it over
    // HTTP/3, whose answers carry no CORS header): his check must ask the next resolver for the homeserver's address.
    let quad9 = 0;
    await bob.context.route(/^https:\/\/dns\.quad9\.net\//, (route) => { quad9++; return route.abort("failed"); });
    await pair(alice, bob);
    const withBob = await chatId(alice);

    // One screen: Passport's button first, Ring's QR code of the same request below, and the Google note.
    const add = await startPubky(alice);
    await expect(add.getByTestId("approval-open")).toHaveText("Approve in your browser (Pubky Passport)");
    await expect(add.getByTestId("approval-qr")).toContainText("Or scan with Pubky Ring");
    await expect(add.getByTestId("approval")).toContainText("Google plus Passport");
    const [passport] = await Promise.all([alice.context.waitForEvent("page"), add.getByTestId("approval-open").click()]);
    const opened = new URL(passport.url());
    expect(`${opened.origin}${opened.pathname}`).toBe("https://passport.pubky.app/authorize");
    expect(opened.search).toBe("");
    expect(opened.hash).toMatch(/^#d=pubkyauth%3A/i);
    await expect(passport.locator("#caps")).toHaveText(PROOF_FOLDER);
    await passport.getByRole("button", { name: "Approve" }).click();

    // Approved: the proof is written, read back through PKDNS, saved; the Passport window is closed by Ghostly.
    await expect(add).toHaveCount(0, { timeout: 90_000 });
    await expect.poll(() => passport.isClosed()).toBe(true);
    expect(approver.approved).toHaveLength(1);
    const folder = PROOF_FOLDER.exec(approver.approved[0])![1];
    const card = alice.page.getByTestId("identity-proof");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Pubky");
    await expect(alice.page.getByTestId("identity-panel-subject")).toContainText(approver.key);
    await expect(alice.page.getByTestId("identity-panel")).toContainText(PUBKY_HOMESERVER_HOST);

    // On the homeserver: one file in that folder, the statement for this key.
    const listing = await approver.read(`/pub/ghostly.app/proofs/${folder}/`);
    expect(listing.status).toBe(200);
    const files = listing.text.split("\n").filter(Boolean);
    expect(files).toHaveLength(1);
    const file = `/pub/ghostly.app/proofs/${folder}/${files[0].split("/").at(-1)}`;
    expect(file).toMatch(/\/[a-f0-9]{64}\.txt$/);
    expect((await approver.read(file)).text).toMatch(new RegExp(`^Ghostly identity proof v1: I control pubky:${approver.key} and authorize the Ghostly key `));

    // Shared with Bob: his app finds the homeserver through the key's records and reads the file itself.
    await go(alice, withBob);
    await shareIdentity(alice, "Pubky");
    await closeIdentities(alice);
    // Both timelines: one card, verified; no stop line.
    const shares = (p: Peer) => p.page.getByTestId("identity-share");
    await expect(shares(bob)).toHaveCount(1);
    await expect(shares(bob)).toHaveAttribute("data-side", "theirs");
    await expect(shares(bob)).toHaveAttribute("data-state", "verified", { timeout: 60_000 });
    await expect(shares(alice)).toHaveAttribute("data-state", "verified", { timeout: 30_000 });
    await expect(shares(alice)).toHaveAttribute("data-kind", "shared");
    await expect(shares(alice)).toHaveCount(1);
    expect(quad9).toBeGreaterThan(0);
    await openIdentities(bob);
    await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
    await expect(theirCards(bob)).toContainText("Pubky");
    const back = await turnTheirs(bob);
    await expect(back).toContainText(PUBKY_HOMESERVER_HOST);
    await closeIdentities(bob);

    // Bob's app is closed when Alice removes it: only the revocation can tell him.
    const bobChat = await chatId(bob);
    await bob.page.goto("about:blank");
    await go(alice, "#/identities");
    await alice.page.getByTestId("identity-proof").click();
    await alice.page.getByTestId("identity-proof-remove").click();
    const notes = alice.page.getByTestId("identity-proof-remove-notes");
    await expect(notes).toContainText("one more approval in Pubky Ring or Passport");
    await alice.page.getByTestId("identity-proof-remove-confirm").click();
    await expect(notes.getByTestId("approval")).toBeVisible();
    const [again] = await Promise.all([alice.context.waitForEvent("page"), notes.getByTestId("approval-open").click()]);
    await again.getByRole("button", { name: "Approve" }).click();
    await expect(alice.page.getByTestId("identity-proof")).toHaveCount(0, { timeout: 90_000 });
    // The same folder was asked for again, and its file is gone.
    expect(approver.approved).toEqual([approver.approved[0], approver.approved[0]]);
    expect((await approver.read(file)).status).toBe(404);
    await expect.poll(() => [...relay.packets.values()].some(packet => packet.includes("_ghostly-revoked"))).toBe(true);
    // Alice never comes back: her app cannot tell Bob it is withdrawn, only the revocation on Pkarr can.
    await alice.context.close();

    // Bob comes back: revoked.
    await bob.page.goto(`/${bobChat}`);
    await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
    await openIdentities(bob);
    const revoked = await turnTheirs(bob);
    // The app also looks by itself once it is back; Check again may re-render under the click, so retry until revoked.
    await expect(async () => {
      if (await revoked.getAttribute("data-status") !== "revoked") await revoked.getByTestId("chat-identity-recheck").click({ timeout: 5_000 });
      await expect(revoked).toHaveAttribute("data-status", "revoked", { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(revoked.getByTestId("chat-identity-received-status")).toHaveText("Revoked: its owner removed it and published a revocation");

    // No request, with its relay secret, ever reached Alice's console.
    expect(logs.join("\n")).not.toMatch(/pubkyauth|#d=/i);
  } finally { approver.stop(); }
});

test("a Pubky identity approved by scanning the QR code, as Pubky Ring does", { tag: ["@feature:proofs.pubky", "@gated"] }, async ({ peer, relay }) => {
  test.setTimeout(180_000);
  const approver = await new PubkyApprover(relay).start();
  try {
    const alice = await peer("pubky-ring");
    await attachPubky(alice.context, relay);
    const add = await startPubky(alice);
    // Ring's QR code is the cookie request (`signin?`), the form the Ring in the app stores reads.
    const scanned = await scanApprovalQr(alice.page);
    expect(scanned.startsWith("pubkyauth://signin?")).toBe(true);
    await approver.approve(scanned);
    await expect(add).toHaveCount(0, { timeout: 90_000 });
    await expect(alice.page.getByTestId("identity-proof")).toHaveCount(1);
    await expect(alice.page.getByTestId("identity-panel-subject")).toContainText(approver.key);
    expect(approver.approved).toEqual([expect.stringMatching(PROOF_FOLDER)]);
    // Only Ring was used: no Passport window was ever opened.
    expect(alice.context.pages()).toHaveLength(1);
  } finally { approver.stop(); }
});
