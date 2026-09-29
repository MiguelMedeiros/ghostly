import { expect, openProfilePage, test } from "../support/fixtures";
import { injectNostrSigner } from "../support/nostrSigner";
import { choose } from "../support/select";

/**
 * Identities is a place of its own: in the account bar under the chat list and in a phone's tab bar, a page
 * beside the list where proofs are added and listed. Profile only links to it.
 */

test("the account bar opens Identities, where a proof is added and listed; Profile links there", { tag: ["@feature:proofs.page", "@feature:proofs.nostr", "@feature:app.navigation"] }, async ({ peer }) => {
  const alice = await peer("idpage-alice");
  await injectNostrSigner(alice);
  const { page } = alice;

  const item = page.getByTestId("account-identities");
  await expect(item).toHaveAccessibleName("Identities");
  await expect(item.getByTestId("identities-attention")).toHaveCount(0);
  await item.click();
  await expect(page).toHaveURL(/#\/identities$/);
  await expect(item).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Identities" })).toBeVisible();

  await page.getByTestId("identities-new").click();
  const add = page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await expect(add.getByTestId("add-identity-signer")).toHaveAttribute("data-value", "nip07");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  const proof = page.getByTestId("identities-page").getByTestId("identity-proof");
  await expect(proof).toHaveCount(1);
  await expect(proof).toContainText("Nostr");
  await expect(proof).toContainText("Not shared");
  // A 90-day proof made now needs nothing: no dot.
  await expect(item.getByTestId("identities-attention")).toHaveCount(0);
  // Its Nostr layer came with it.
  await expect(page.getByTestId("nostr-section")).toBeVisible();

  // Profile no longer holds them, and says where they are.
  await openProfilePage(page);
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await expect(page.getByTestId("profile-page").getByTestId("identity-proof")).toHaveCount(0);
  await expect(page.getByTestId("profile-page").getByTestId("nostr-section")).toHaveCount(0);
  await expect(page.getByTestId("profile-identities-link")).toContainText("Identities");
  await page.getByTestId("profile-identities-link").click();
  await expect(page.getByTestId("identities-page").getByTestId("identity-proof")).toHaveCount(1);
});

test("a proof in its last days puts a dot on Identities, in the bar and in the phone's tab bar", { tag: ["@feature:proofs.page", "@feature:proofs.expiry", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const alice = await peer("idpage-phone", { mobile: true });
  await injectNostrSigner(alice);
  const { page } = alice;

  // Five tabs, Identities among them, each one easy to tap.
  const tabs = page.getByTestId("mobile-tabs").getByRole("button");
  await expect(tabs).toHaveCount(5);
  for (const box of await Promise.all((await tabs.all()).map(tab => tab.boundingBox()))) {
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }
  await page.getByTestId("mobile-tab-identities").click();
  await expect(page.getByRole("heading", { name: "Identities" })).toBeVisible();
  await page.getByTestId("identities-new").click();
  const add = page.getByTestId("add-identity");
  await add.getByTestId("add-identity-nostr").click();
  await choose(add.getByTestId("add-identity-validity"), "7");
  await add.getByTestId("add-identity-start").click();
  await expect(add).toHaveCount(0);
  await expect(page.getByTestId("identity-proof")).toHaveCount(1);
  await expect(page.getByTestId("identity-proof-expiring")).toHaveCount(0);
  await expect(page.getByTestId("mobile-tab-identities").getByTestId("identities-attention")).toHaveCount(0);

  // Six and a half days later, it is in its last day and a half (the page is drawn again on the way back).
  await page.clock.setFixedTime(Date.now() + 6.5 * 86_400_000);
  await page.getByTestId("mobile-tab-chats").click();
  await page.getByTestId("mobile-tab-identities").click();
  await expect(page.getByTestId("identity-proof-expiring")).toHaveText("Expires in 1 day");
  await expect(page.getByTestId("mobile-tab-identities").getByTestId("identities-attention")).toBeVisible();
  await expect(page.getByTestId("mobile-tab-identities")).toHaveAccessibleName("Identities, needs attention");
  // Seeing it does not clear it: renewing or removing it does.
  await page.getByTestId("mobile-tab-chats").click();
  await expect(page.getByTestId("mobile-tab-identities").getByTestId("identities-attention")).toBeVisible();
  await page.getByTestId("mobile-tab-identities").click();
  // The page starts on the Ghostly card: the proof's card, once chosen, has Remove.
  await page.getByTestId("identity-proof").click();
  await page.getByTestId("identity-proof-remove").click();
  await page.getByTestId("identity-proof-remove-confirm").click();
  await expect(page.getByTestId("identity-proof")).toHaveCount(0);
  await expect(page.getByTestId("identities-attention")).toHaveCount(0);
});
