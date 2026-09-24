import type { Page } from "@playwright/test";
import { expect, test, type Peer } from "../support/fixtures";
import { LocalOidcIssuer } from "../support/oidcIssuer";
import { pair } from "../support/paired";
import { choose } from "../support/select";

/**
 * An identity proof attested by an OpenID Connect provider, end to end, against the
 * issuer in e2e/support/oidcIssuer.ts (the suite's build knows it as "Test issuer").
 * Alice signs in once; the provider's ID token carries her proof's statement id as nonce.
 * She shares it with Bob only: Bob's app checks the provider's signature against its keys
 * and shows who attests it; Carol, another contact of Alice's, sees nothing.
 */

async function addAccountProof(page: Page, issuer: LocalOidcIssuer, signer = "oidc-email") {
  await page.evaluate(() => { location.hash = "#/identities"; });
  await page.getByTestId("identity-add").click();
  const add = page.getByTestId("add-identity");
  await add.getByTestId("add-identity-oidc").click();
  await choose(add.getByTestId("add-identity-signer"), signer);
  await expect(add.getByTestId("add-identity-subject")).toHaveAttribute("data-value", issuer.issuer);
  await add.getByTestId("add-identity-start").click();
  // The provider's page opens in a popup from this click.
  const [popup] = await Promise.all([page.context().waitForEvent("page"), add.getByTestId("add-identity-finish").click()]);
  await popup.getByRole("link", { name: "Continue as alice" }).click();
  return add;
}

test("a provider-attested account is verified by the contact it is shared with, and by nobody else", { tag: ["@feature:proofs.oidc", "@feature:proofs.share"] }, async ({ peer }) => {
  const issuer = new LocalOidcIssuer();
  const [alice, bob, carol] = await Promise.all([peer("oidc-alice"), peer("oidc-bob"), peer("oidc-carol")]);
  await Promise.all([alice, bob, carol].map((p: Peer) => issuer.attach(p.context)));
  await pair(alice, carol);
  const carolChat = await alice.page.evaluate(() => location.hash);
  await pair(alice, bob);
  const bobChat = await alice.page.evaluate(() => location.hash);

  const add = await addAccountProof(alice.page, issuer);
  await expect(add).toHaveCount(0);
  const proof = alice.page.getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText("Attested by oidc.ghostly.test");
  // Only what she chose: openid and email, and the statement id as nonce.
  const request = issuer.requests.at(-1)!;
  expect(request.get("scope")).toBe("openid email");
  expect(request.get("nonce")).toMatch(/^[a-f0-9]{64}$/);
  expect(request.get("response_type")).toBe("id_token");

  // Shared with Bob only.
  await alice.page.evaluate((h) => { location.hash = h; }, bobChat);
  await alice.page.getByTitle("Options").click();
  await alice.page.getByTestId("chat-identities-open").click();
  const dialog = alice.page.getByTestId("chat-identities");
  await dialog.getByTestId("chat-identity-share").first().click();
  await expect(dialog.getByTestId("chat-identity-mine-status").first()).toHaveText("Shared · verified by your contact");
  await dialog.getByRole("button", { name: "Close" }).click();

  await bob.page.getByTitle("Options").click();
  await bob.page.getByTestId("chat-identities-open").click();
  const received = bob.page.getByTestId("chat-identity-received");
  await expect(received).toHaveCount(1);
  await expect(received).toHaveAttribute("data-status", "verified");
  await expect(received).toContainText("Attested by oidc.ghostly.test");
  await expect(received).toContainText("alice@example.test");

  // Carol is Alice's contact too, and receives nothing.
  await alice.page.evaluate((h) => { location.hash = h; }, carolChat);
  await carol.page.getByTitle("Options").click();
  await carol.page.getByTestId("chat-identities-open").click();
  await expect(carol.page.getByTestId("chat-identities")).toBeVisible();
  await expect(carol.page.getByTestId("chat-identity-received")).toHaveCount(0);
});

test("a token the provider signed for another nonce is refused and nothing is saved", { tag: ["@feature:proofs.oidc.nonce"] }, async ({ peer }) => {
  const issuer = new LocalOidcIssuer();
  const alice = await peer("oidc-wrong-nonce");
  await issuer.attach(alice.context);
  issuer.nonceOverride = "0".repeat(64);
  const add = await addAccountProof(alice.page, issuer, "oidc-account");
  await expect(add.getByTestId("add-identity-error")).toHaveText(/another sign-in request/);
  await add.getByRole("button", { name: /Cancel|Close/ }).first().click();
  await expect(alice.page.getByTestId("identity-proof")).toHaveCount(0);
});
