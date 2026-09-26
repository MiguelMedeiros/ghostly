import { createWallet, expect, getTestCoins, openWallet, test, useTestnet, walletCard, type Peer } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";

/**
 * The Cashu and Lightning cards on their own: what they refuse, and how they lead to each other. A new profile
 * has no wallet, so each test makes a Testnet Cashu wallet with New first, which talks to the test mint
 * (`E2E_MINT_URL` answers for it when set, see support/mint.ts); the Lightning card comes with it.
 */

/** A mint address that resolves nowhere: its requests are cut here, before they reach any network. */
const UNREACHABLE = "https://mint.unreachable.invalid";

async function cashu(p: Peer) {
  await useTestnet(p);
  return showCashu(p);
}
async function showCashu(p: Peer) {
  await openWallet(p, "cashu-testnet");
  await expect(p.page.getByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  return p.page;
}

test("Send refuses text that is neither a Lightning invoice nor an address, and says so", { tag: ["@network", "@feature:wallet.cashu.pay-invoice"] }, async ({ peer }) => {
  const page = await cashu(await peer("cashu-send"));
  await page.getByTestId("wallet-send").click();
  const input = page.getByTestId("wallet-pay-input");
  await expect(input).toBeFocused();
  const pay = page.getByRole("button", { name: "Pay", exact: true });
  await expect(pay, "nothing to pay yet").toBeDisabled();

  await input.fill("lnbc-this-is-not-an-invoice");
  await expect(page.getByText("That is not a Lightning invoice or a Lightning address.")).toBeVisible();
  await expect(page.getByTestId("wallet-pay-preview")).toHaveCount(0);
  await expect(pay).toBeDisabled();

  // An empty field is not an error: the hint comes back.
  await input.fill("");
  await expect(page.getByText("That is not a Lightning invoice or a Lightning address.")).toHaveCount(0);
  await expect(page.getByText("Paying a contact? Use ⚡ in the chat.")).toBeVisible();

  // Something that looks like ecash is offered as a token to redeem, not called a bad invoice.
  await input.fill("cashuBthis-is-not-a-real-token");
  await expect(page.getByText("That is not a Lightning invoice or a Lightning address.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redeem ecash token" })).toBeEnabled();
});

test("a mint that is not a mint is refused with a reason, and nothing is added", { tag: ["@network", "@feature:wallet.cashu.mint.add"] }, async ({ peer }) => {
  const alice = await peer("cashu-mints");
  let reached = 0;
  await alice.context.route(`${UNREACHABLE}/**`, (route) => { reached++; return route.abort("namenotresolved"); });
  const page = await cashu(alice);
  const rows = page.getByTestId("mint-row");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  const field = page.getByTestId("wallet-mint-url");
  const add = page.getByTestId("wallet-add-mint");
  await expect(add, "nothing typed, nothing to add").toBeDisabled();

  const refused = async (url: string, reason: RegExp) => {
    await field.fill(url);
    await add.click();
    await expect(page.getByTestId("wallet-error")).toHaveText(reason);
    await expect(rows).toHaveCount(before);
    await expect(field, "what was typed stays, to be corrected").toHaveValue(url);
    await expect(page.getByTestId("wallet-mints")).not.toContainText(url.replace(/^https?:\/\//, ""));
  };
  await refused("not a url", /not a valid mint URL/);
  await refused("http://mint.example.com", /Mints must use https/);
  // A real address that does not answer: the wallet talks to it before adding it, so a typo is never kept.
  await refused(UNREACHABLE, /\S/);
  expect(reached, "the wallet tried the mint before refusing it").toBeGreaterThan(0);

  // Still nothing added after a reload.
  await page.reload();
  await showCashu(alice);
  await expect(page.getByTestId("mint-row").first()).toBeVisible();
  await expect(page.getByTestId("mint-row")).toHaveCount(before);
  await expect(page.getByTestId("wallet-mints")).not.toContainText("unreachable.invalid");
});

// An unreachable mint is refused with a reason that names it, not the browser's "Failed to fetch".
test("an unreachable mint is refused with a reason a person can act on", { tag: ["@network", "@feature:wallet.cashu.mint.add"] }, async ({ peer }) => {
  const alice = await peer("cashu-mint-reason");
  await alice.context.route(`${UNREACHABLE}/**`, (route) => route.abort("namenotresolved"));
  const page = await cashu(alice);
  await page.getByTestId("wallet-mint-url").fill(UNREACHABLE);
  await page.getByTestId("wallet-add-mint").click();
  await expect(page.getByTestId("wallet-error")).toHaveText(/mint\.unreachable\.invalid|could not reach|not reachable|did not answer/i);
  await expect(page.getByTestId("wallet-error")).not.toHaveText(/^Failed to fetch$/);
});

test("the Lightning card pays invoices and addresses, not tokens, and its settings lead to the Cashu card", { tag: ["@network", "@feature:wallet.lightning.card", "@feature:wallet.lightning.sources"] }, async ({ peer }) => {
  const alice = await peer("lightning-card");
  await useTestnet(alice);
  await openWallet(alice, "lightning-testnet");
  const page = alice.page;
  await expect(page.getByTestId("wallet-card-lightning-testnet")).toHaveAttribute("aria-selected", "true");
  // The card's own tabs, under the deck (which is a tablist too).
  const tabs = page.getByRole("tabpanel").getByRole("tablist").getByRole("tab");
  await expect(tabs).toHaveText(["Receive", "Send"]);
  await expect(page.getByTestId("wallet-history")).toHaveCount(0);
  // No mint settings here: they belong to the Cashu card.
  await expect(page.getByTestId("wallet-mints")).toHaveCount(0);
  await page.getByTestId("wallet-send").click();
  await expect(page.getByTestId("wallet-pay-input")).toHaveAttribute("placeholder", "Paste a Lightning invoice or a Lightning address");

  await page.getByRole("button", { name: "Cashu settings" }).click();
  await expect(page.getByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-card-lightning-testnet")).toHaveAttribute("aria-selected", "false");
  await expect(tabs).toHaveText(["Receive", "Send", "History"]);
  await expect(page.getByTestId("wallet-mints")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cashu settings" })).toHaveCount(0);
});

test.describe("test sats", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  test("a Testnet and a Mainnet Cashu wallet side by side: each its own mints and balance, no switch, and Mainnet stays untouched", { tag: ["@feature:wallet.mode", "@feature:wallet.instances.networks", "@feature:wallet.cashu.test-sats", "@feature:wallet.test-coins", "@feature:wallet.cashu.receive-lightning"] }, async ({ peer }) => {
    const alice = await peer("cashu-testnet");
    // The Mainnet default mints are answered by the suite's own mint: no real mint is reached.
    await mockMainnetMints(alice.context);
    await createWallet(alice, "cashu", "mainnet");
    await createWallet(alice, "cashu", "testnet");
    const page = alice.page;
    const mainnet = walletCard(page, "cashu-mainnet"), testnet = walletCard(page, "cashu-testnet");
    // No profile-wide mode: no switch, no banner, no badge by the name. Each card says its own network.
    await expect(page.getByTestId("wallet-mode")).toHaveCount(0);
    await expect(page.getByTestId("testnet-notice")).toHaveCount(0);
    await expect(page.getByTestId("testnet-badge")).toHaveCount(0);
    await expect(testnet.getByTestId("wallet-card-network")).toHaveText("Testnet");
    await expect(mainnet.getByTestId("wallet-card-network")).toHaveCount(0);
    await expect(page.getByTestId("wallet-chip"), "the bar names the place, not the balance").toHaveText("Wallets");

    await openWallet(alice, "cashu-mainnet");
    const realMints = await page.getByTestId("mint-row").count();
    expect(realMints).toBeGreaterThan(0);
    await expect(page.getByTestId("mint-row").filter({ hasText: "testnut.cashu.space" })).toHaveCount(0);

    // The Testnet wallet: only test mints, the public one first, and it is where invoices are made.
    await openWallet(alice, "cashu-testnet");
    await expect(page.getByTestId("mint-row")).toHaveCount(1);
    await expect(page.getByTestId("mint-row").first()).toContainText("testnut.cashu.space");
    await expect(page.getByTestId("mint-row").first()).toContainText("Primary");
    await expect(testnet).toContainText("0 test sats");

    await getTestCoins(alice);
    await expect(page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats$/);
    await expect(page.getByTestId("wallet-test-balance"), "the whole balance is test sats; it is not said twice").toHaveCount(0);
    await expect(testnet).toContainText("10,000 test sats");
    await expect(page.getByTestId("wallet-chip")).toHaveText("Wallets");
    await expect(page.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");

    // The Mainnet wallet: its real mints and real sats only, and the test sats never counted there.
    await openWallet(alice, "cashu-mainnet");
    await expect(page.getByTestId("mint-row")).toHaveCount(realMints);
    await expect(page.getByTestId("mint-row").filter({ hasText: "testnut.cashu.space" })).toHaveCount(0);
    await expect.poll(async () => (await page.getByTestId("wallet-balance").innerText()).trim()).toMatch(/^0\s*sats/);
    await expect(page.getByTestId("wallet-test-balance")).toHaveCount(0);
    await expect(mainnet).not.toContainText("test sats");
    await expect(page.getByTestId("test-coins"), "no test coins for real money").toHaveCount(0);
    await expect(page.getByTestId("wallet-new"), "opening another wallet is not sats arriving").toHaveCount(0);

    // Both are kept, each with its own balance.
    await page.reload();
    await openWallet(alice, "cashu-testnet");
    await expect(page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats$/);
    await expect(walletCard(page, "cashu-mainnet")).toBeVisible();
  });

});
