import { expect, test, type Peer } from "../support/fixtures";
import { closeIdentities, openIdentities, shareIdentity, theirCards, theirFace, turnTheirs } from "../support/identities";
import { pair } from "../support/paired";
import { DOMAIN_SLOTS, startTestDomain, type TestDomain } from "../support/domain";
import { choose } from "../support/select";

/**
 * Domain identity proofs. The test domain is served by support/domain.ts: a local DNS-over-HTTPS
 * responder and a local well-known server, reached through routes on the public resolver and on the
 * domain's own address, so the app runs exactly as it does in production.
 */

const chatId = (peer: Peer) => peer.page.evaluate(() => location.hash);
const go = (peer: Peer, hash: string) => peer.page.evaluate(h => { location.hash = h; }, hash);

/** Identities → Domain, with one of its publish signers, up to the instructions. */
async function startDomainProof(peer: Peer, domain: string, signer: "dns" | "https") {
  await go(peer, "#/identities");
  await peer.page.getByTestId("identities-new").click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-domain").click();
  await choose(add.getByTestId("add-identity-signer"), signer);
  await add.getByTestId("add-identity-subject").fill(domain.toUpperCase());
  await add.getByTestId("add-identity-start").click();
  return add;
}

let site: TestDomain;
test.beforeEach(async ({}, info) => { site = await startTestDomain(info.parallelIndex % DOMAIN_SLOTS); });
test.afterEach(async () => { await site.close(); });

test("a domain proven by a DNS TXT record is verified by the one contact it is shared with, and not once the record is gone", { tag: ["@feature:proofs.domain.dns", "@feature:proofs.share"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("dom-alice"), peer("dom-bob"), peer("dom-carol")]);
  for (const p of [alice, bob, carol]) await site.attach(p.context);
  await pair(alice, bob);
  const withBob = await chatId(alice);
  await pair(alice, carol);

  // The instructions name the record and its exact value, ready to copy.
  const add = await startDomainProof(alice, site.domain, "dns");
  await expect(add.getByTestId("add-identity-copy-0")).toHaveText(`_ghostly.${site.domain}`);
  const value = (await add.getByTestId("add-identity-copy-1").textContent())!;
  expect(value).toMatch(/^v=ghostly1; key=[ybndrfg8ejkmcpqxot1uwisza345h769]{52}; proof=[a-f0-9]{64}$/);

  // Not published yet: nothing is saved, and the person is told why.
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toContainText(`No Ghostly TXT record at _ghostly.${site.domain}`);
  // Published: checked, then saved.
  site.publishTxt(value);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
  const proof = alice.page.getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText(site.domain);

  // Shared with Bob only.
  await go(alice, withBob);
  await shareIdentity(alice);
  await closeIdentities(alice);

  await expect(bob.page.getByTestId("chat-identity-badge").first()).toBeVisible();
  await openIdentities(bob);
  await expect(theirCards(bob)).toHaveCount(1);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  let back = await turnTheirs(bob);
  await expect(back.getByTestId("chat-identity-received-subject")).toHaveAttribute("title", site.domain);
  await expect(back).toContainText(`DNS TXT record at _ghostly.${site.domain}, via Quad9`);

  // The DNS method asks the resolver about the record only: the domain's web server never hears of it.
  expect(site.asked.filter(q => q.startsWith("web "))).toEqual([]);
  expect(new Set(site.asked)).toEqual(new Set([`dns _ghostly.${site.domain}`]));

  // Carol was never shown it.
  await closeIdentities(bob);
  await openIdentities(carol);
  await expect(theirCards(carol)).toHaveCount(0);
  await closeIdentities(carol);
  await expect(carol.page.getByTestId("chat-identity-ghostly-mark")).toBeVisible();

  // The record is removed: Bob's next check no longer confirms it, and says why.
  site.unpublish();
  await openIdentities(bob);
  back = await turnTheirs(bob);
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back).toHaveAttribute("data-status", "failed");
  await expect(back).toContainText(`No Ghostly TXT record at _ghostly.${site.domain}`);
  // Published again: the next check confirms it again.
  site.publishTxt(value);
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back).toHaveAttribute("data-status", "verified");
});

test("a domain proven by /.well-known/ghostly.json is fetched from the domain itself, and fails once the file is gone", { tag: ["@feature:proofs.domain.https", "@feature:proofs.share"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("domf-alice"), peer("domf-bob")]);
  for (const p of [alice, bob]) await site.attach(p.context);
  await pair(alice, bob);
  const chat = await chatId(alice);

  const add = await startDomainProof(alice, site.domain, "https");
  await expect(add.getByTestId("add-identity-copy-0")).toHaveText(`https://${site.domain}/.well-known/ghostly.json`);
  const file = (await add.getByTestId("add-identity-copy-1").textContent())!;
  expect(JSON.parse(file)).toMatchObject({ ghostly: 1, proofs: [{ key: expect.any(String), proof: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  await expect(add.getByTestId("add-identity-copy-2")).toHaveText("Access-Control-Allow-Origin: *");
  site.files.set("/.well-known/ghostly.json", file);
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);

  await go(alice, chat);
  await shareIdentity(alice);
  await closeIdentities(alice);

  await openIdentities(bob);
  await expect(theirFace(bob)).toHaveAttribute("data-status", "verified");
  const back = await turnTheirs(bob);
  await expect(back).toContainText(`File at https://${site.domain}/.well-known/ghostly.json`);
  // Its addresses were checked through the resolver before the web server was contacted.
  expect(site.asked).toContain(`dns ${site.domain}`);
  expect(site.asked).toContain("web /.well-known/ghostly.json");

  site.unpublish();
  await back.getByTestId("chat-identity-recheck").click();
  await expect(back).toHaveAttribute("data-status", "failed");
  await expect(back).toContainText("was not found");
});

test("the resolver that checks domain proofs is the person's choice, says what it learns, and is kept", { tag: ["@feature:proofs.domain.resolver"] }, async ({ peer }) => {
  const { page } = await peer("dom-settings");
  await page.goto("/#/settings/advanced");
  const resolver = page.getByTestId("doh-resolver");
  await expect(resolver).toHaveAttribute("data-value", "quad9");
  // What the resolver learns: behind the row's ⓘ, naming the one chosen.
  const row = page.getByTestId("doh-resolver-row");
  await row.getByTestId("row-info").click();
  const learns = row.getByTestId("row-info-text");
  await expect(learns).toContainText("learns which domain was looked up");
  await expect(learns).toContainText("Quad9");
  await choose(resolver, "cloudflare");
  await expect(learns).toContainText("Cloudflare");
  await page.reload();
  await expect(page.getByTestId("doh-resolver")).toHaveAttribute("data-value", "cloudflare");
});
