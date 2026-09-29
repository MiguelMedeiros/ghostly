import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { LocalAtproto, atprotoConfigured, type AtprotoAccount } from "../support/atproto";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";

/**
 * A Bluesky / AT Protocol identity, end to end, against the local PLC directory and reference PDS of e2e/infra
 * (support/atproto.ts). Alice types her handle; her server's own OAuth pages (PAR, PKCE, DPoP) ask her to log in
 * and approve Ghostly's narrow permission; Ghostly writes one record in her repository. Bob's app checks it from
 * her signed repository, without logging in. Removing it deletes the record (a fresh approval) and revokes it.
 *
 * AT Protocol's development client only returns to 127.0.0.1, and the callback page must share the app's origin,
 * so these peers open the app at 127.0.0.1 (the preview server must listen there).
 */
const origin = (process.env.E2E_WEB_URL ?? `http://localhost:${process.env.E2E_WEB_PORT || 4173}`).replace("//localhost:", "//127.0.0.1:");
test.use({ baseURL: origin });

/** The PDS's own login and consent pages, in the window Ghostly opened. */
async function approveOnServer(popup: Page, account: AtprotoAccount) {
  await popup.waitForLoadState();
  const password = popup.locator('input[type="password"]');
  await expect(password).toBeVisible();
  const identifier = popup.locator('input[autocomplete="username"], input[name="username"], input[name="identifier"]').first();
  if (await identifier.count() && !(await identifier.inputValue())) await identifier.fill(account.handle);
  await password.fill(account.password);
  await popup.getByRole("button", { name: /^(Sign in|Next|Log in)$/i }).click();
  await popup.getByRole("button", { name: /^(Authorize|Accept|Allow)$/i }).click();
}

async function addBluesky(page: Page, account: AtprotoAccount) {
  await page.evaluate(() => { location.hash = "#/identities"; });
  await page.getByTestId("identities-new").click();
  const add = page.getByTestId("add-identity");
  await add.getByTestId("add-identity-atproto").click();
  await add.getByTestId("add-identity-field-handle").fill(account.handle);
  const start = add.getByTestId("add-identity-start");
  await expect(start).toHaveText("Continue on your server");
  const [popup] = await Promise.all([page.context().waitForEvent("page"), start.click()]);
  return { add, popup };
}

test("a Bluesky account, added through its server's OAuth, is verified by the contact; removing it deletes the record and revokes it", {
  tag: ["@gated", "@feature:proofs.atproto", "@feature:proofs.atproto.oauth", "@feature:proofs.atproto.remove"],
}, async ({ peer, relay }) => {
  test.skip(!atprotoConfigured(), "Requires the AT Protocol network of e2e/infra (E2E_ATPROTO_PDS_URL, E2E_ATPROTO_PLC_URL)");
  const atproto = new LocalAtproto();
  const account = await atproto.account("alice");
  const [alice, bob] = await Promise.all([peer("atp-alice"), peer("atp-bob")]);
  await Promise.all([alice, bob].map(p => atproto.attach(p.context)));
  await pair(alice, bob);
  const bobChat = await alice.page.evaluate(() => location.hash);

  // Add: the handle, then the server's own pages.
  const { add, popup } = await addBluesky(alice.page, account);
  await expect(popup).toHaveURL(/^https:\/\/pds\.ghostly\.test\/oauth\/authorize\?/);
  await approveOnServer(popup, account);
  await expect(add).toHaveCount(0, { timeout: 90_000 });
  const card = alice.page.getByTestId("identity-proof");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Bluesky / AT Protocol");
  await expect(card).toContainText(`@${account.handle}`);
  await expect(card).toContainText(account.did.slice(0, 14));
  // One record in her repository, carrying the statement; nothing else was written.
  const records = await atproto.proofRecords(account.did);
  expect(records).toHaveLength(1);
  expect(records[0].value.statement).toContain(`I control atproto:${account.did} and authorize the Ghostly key`);

  // Shared with Bob, whose app checks it from her repository.
  await alice.page.evaluate((h) => { location.hash = h; }, bobChat);
  await shareIdentity(alice, /Bluesky/);
  await closeIdentities(alice);
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  await expect(theirCards(bob)).toContainText(`@${account.handle}`);
  const back = await turnTheirs(bob);
  await expect(back).toContainText("Record signed with the account's key, from pds.ghostly.test");
  await closeIdentities(bob);

  // Bob's app is closed when Alice removes it: the withdrawal cannot reach him, the revocation goes to Pkarr.
  const withAlice = await bob.page.evaluate(() => location.hash);
  await bob.page.goto("about:blank");

  // Removed: a fresh approval deletes the record, then the proof is revoked.
  await alice.page.evaluate(() => { location.hash = "#/identities"; });
  await alice.page.getByTestId("identity-proof").click();
  await alice.page.getByTestId("identity-proof-remove").click();
  await expect(alice.page.getByText(/Also deletes the record on your server/)).toBeVisible();
  const [again] = await Promise.all([alice.context.waitForEvent("page"), alice.page.getByTestId("identity-proof-remove-confirm").click()]);
  await approveOnServer(again, account);
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(0, { timeout: 90_000 });
  await expect.poll(() => atproto.proofRecords(account.did)).toHaveLength(0);
  await expect.poll(() => [...relay.packets.values()].some(packet => packet.includes("_ghostly-revoked"))).toBe(true);
  await alice.context.close();

  // Bob opens Ghostly again and checks: revoked by its owner.
  await bob.page.goto(`/${withAlice}`);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await openIdentities(bob);
  const theirs = await turnTheirs(bob);
  // The app also looks by itself a minute after starting; either way it ends revoked.
  if (await theirs.getAttribute("data-status") === "verified") await theirs.getByTestId("chat-identity-recheck").click();
  await expect(theirs).toHaveAttribute("data-status", "revoked");
  await expect(theirs.getByTestId("chat-identity-received-status")).toHaveText("Revoked: its owner removed it and published a revocation");
});
