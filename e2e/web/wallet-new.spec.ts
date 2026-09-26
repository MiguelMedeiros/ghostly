import { chat, connect, createWallet, expect, getTestCoins, link, openChat, openWallet, showNetwork, test, useFakeProviders, type Peer } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";
import { closePayments, openPayments, paymentCard } from "../support/payments";

/**
 * Wallets are made one at a time, each on its own network: New in the Wallets header, a network, a kind, one click.
 * A new profile has none, and says how to start. Test coins only: Mainnet creation runs against mocked mints.
 */

const panelBalance = (p: Peer) => p.page.getByTestId("wallet-balance");

test("a new profile has no wallet and says how to start; one choice makes Testnet Cashu and USDT", { tag: ["@network", "@feature:wallet.instances.create", "@feature:wallet.ready"] }, async ({ peer }) => {
  const alice = await peer("first-run");
  await openWallet(alice);
  const first = alice.page.getByTestId("wallet-first");
  await expect(first).toContainText("Create your first wallet");
  await expect(alice.page.getByTestId("wallet-add")).toBeVisible();
  // No network switch, no Testnet badge: each wallet carries its own network.
  await expect(alice.page.getByTestId("wallet-mode")).toHaveCount(0);
  await expect(alice.page.getByTestId("testnet-badge")).toHaveCount(0);
  await first.getByTestId("wallet-first-testnet").click();
  const deck = alice.page.getByRole("tablist", { name: "Testnet wallets" });
  await expect(deck.getByTestId("wallet-card-cashu-testnet")).toBeVisible({ timeout: 90_000 });
  await expect(deck.getByTestId("wallet-card-usdt-testnet")).toBeVisible({ timeout: 90_000 });
  await expect(deck.getByTestId("wallet-card-cashu-testnet").getByTestId("wallet-card-network")).toHaveText("Testnet");
  await expect(first).toHaveCount(0);
  await expect(deck.locator("[role=tab]")).toHaveCount(3); // Cashu, Lightning through it, USDT
});

test("New makes a Testnet kind in one click, checked before its card appears, and says what Mainnet does not have yet", { tag: ["@feature:wallet.instances.create", "@feature:wallet.bark.mainnet-off", "@feature:wallet.fedimint.mainnet-off"] }, async ({ peer }) => {
  const alice = await peer("new-one-click");
  await createWallet(alice, "cashu", "testnet");
  await expect(alice.page.getByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  await expect(panelBalance(alice)).toHaveText(/^0\s*test sats/);

  await alice.page.getByTestId("wallet-add").click();
  const dialog = alice.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await expect(dialog.getByTestId("new-wallet-type-cashu-status")).toHaveText("Added");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  for (const kind of ["bark", "spark", "fedimint"]) {
    await expect(dialog.getByTestId(`new-wallet-type-${kind}`), kind).toHaveAttribute("aria-disabled", "true");
    await expect(dialog.getByTestId(`new-wallet-type-${kind}-status`), kind).toHaveText("Not yet");
    // Its reason, in place of what it is: Mainnet has not been tried with real funds.
    await expect(dialog.getByTestId(`new-wallet-type-${kind}`), kind).toContainText(/not available yet|not been tried/);
  }
  await dialog.getByTestId("new-wallet-type-bark").click({ force: true });
  await expect(dialog).toBeVisible();
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-bark-]")).toHaveCount(0);
});

test("a source that needs its form: New asks only for it, and a fake Lightning wallet becomes Testnet's Lightning card", { tag: ["@feature:wallet.instances.create", "@feature:wallet.lightning.sources"] }, async ({ peer }) => {
  const alice = await peer("new-source");
  await useFakeProviders(alice);
  await createWallet(alice, "lightning", "testnet", { provider: "fake-lightning", fill: async (form) => {
    await form.getByLabel("Access token").fill("a-test-token");
    await form.getByTestId("provider-save").click();
  } });
  await expect(alice.page.getByTestId("wallet-card-lightning-testnet")).toContainText("Via");
});

test("a Mainnet Cashu wallet (mints mocked) wears no Testnet tag, beside a Testnet one", { tag: ["@feature:wallet.instances.networks", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("new-mainnet");
  await mockMainnetMints(alice.context);
  await createWallet(alice, "cashu", "mainnet");
  await createWallet(alice, "cashu", "testnet");
  const mainnet = alice.page.getByTestId("wallet-card-cashu-mainnet"), testnet = alice.page.getByTestId("wallet-card-cashu-testnet");
  await expect(mainnet.getByTestId("wallet-card-network")).toHaveCount(0);
  await expect(testnet.getByTestId("wallet-card-network")).toHaveText("Testnet");
  await expect(testnet).toContainText("test sats");
  await showNetwork(alice.page, "mainnet");
  await expect(mainnet.getByTestId("wallet-card-network")).toHaveCount(0);
  await expect(mainnet).not.toContainText("test sats");
});

test("two people pay on the same network; a card of a network the contact has no wallet on is not offered", { tag: ["@network", "@feature:wallet.instances.networks", "@feature:payments.chat.networks", "@feature:payments.cashu.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("net-alice"), peer("net-bob")]);
  await mockMainnetMints(bob.context);
  await createWallet(alice, "cashu", "testnet");
  // Bob starts with real money only.
  await createWallet(bob, "cashu", "mainnet");
  await link(alice, bob);
  await connect(alice, bob);
  await openChat(alice);
  await openPayments(alice.page);
  const card = paymentCard(alice.page, "cashu-testnet");
  await expect(card).toHaveAttribute("aria-disabled", "true");
  await expect(card).toHaveAttribute("title", /Your contact has no Testnet Cashu wallet/);
  await closePayments(alice.page);

  // Bob makes a Testnet Cashu wallet: the chat is told, and the card meets his.
  await createWallet(bob, "cashu", "testnet");
  await openChat(bob);
  await openPayments(alice.page);
  await expect(card).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await closePayments(alice.page);

  // Test sats in with Get test coins, then 21 of them to Bob.
  await getTestCoins(alice);
  await openChat(alice);
  await openPayments(alice.page);
  await card.click();
  await alice.page.getByTestId("payment-amount").fill("21");
  await alice.page.getByTestId("payment-send").click();
  const review = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
  await expect(review).toContainText("cashu-test");
  // Which money, in words: test money goes on Approve, with no second question.
  await expect(review.getByTestId("review-network")).toHaveText("Test money");
  await expect(review).toContainText("21 test sats");
  await expect(alice.page.getByTestId("payment-back-network")).toHaveText("Test money");
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(review.getByTestId("review-mainnet-confirm")).toHaveCount(0);
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state")).toHaveText(/Received/, { timeout: 30_000 });
  await openWallet(bob, "cashu-testnet");
  await expect.poll(async () => (await panelBalance(bob).innerText()).trim(), { timeout: 15_000 }).toMatch(/^21\s*test sats/);
  // Bob's Mainnet wallet got nothing.
  await openWallet(bob, "cashu-mainnet");
  await expect.poll(async () => (await panelBalance(bob).innerText()).trim()).toMatch(/^0\s*sats/);
});
