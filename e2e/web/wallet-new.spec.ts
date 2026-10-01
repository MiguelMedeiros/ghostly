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

test("on a phone: a first setup whose Ethereum RPC does not answer says so in words, not the browser's", { tag: ["@feature:wallet.instances.create", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  test.setTimeout(120_000);
  const alice = await peer("first-rpc-silent", { mobile: true, offlineMainnet: true });
  // The test mint is down, and Sepolia's RPC takes the request and never answers: the app gives up after 15 s. The
  // card said the browser's words for that ("Fetch is aborted" in Safari, "signal timed out" here).
  await alice.context.route(/^https:\/\/testnut\.cashu\.space\//, (route) => route.abort("connectionrefused"));
  await alice.context.route(/^https:\/\/ethereum-sepolia-rpc\.publicnode\.com/, () => {});
  await alice.page.getByTestId("mobile-tabs").getByRole("button", { name: "Wallets" }).click();
  const first = alice.page.getByTestId("wallet-first");
  await first.getByTestId("wallet-first-testnet").click();
  await expect(first.getByTestId("wallet-first-error-usdt")).toHaveText(
    "Could not create the Testnet USDT wallet: ethereum-sepolia-rpc.publicnode.com did not answer in time. Nothing was saved; try again.", { timeout: 60_000 });
});

test("on a phone: a first setup that made nothing gives way to a wallet made with New", { tag: ["@feature:wallet.instances.create", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const alice = await peer("first-fails-phone", { mobile: true, offlineMainnet: true });
  await useFakeProviders(alice);
  // The test mint and Sepolia's RPC are down: the first setup makes neither.
  for (const down of [/^https:\/\/testnut\.cashu\.space\//, /^https:\/\/ethereum-sepolia-rpc\.publicnode\.com/]) await alice.context.route(down, (route) => route.abort("connectionrefused"));
  await alice.page.getByTestId("mobile-tabs").getByRole("button", { name: "Wallets" }).click();
  const first = alice.page.getByTestId("wallet-first");
  await first.getByTestId("wallet-first-testnet").click();
  await expect(first.getByTestId("wallet-first-error-cashu")).toBeVisible({ timeout: 60_000 });
  await expect(first.getByTestId("wallet-first-error-usdt")).toBeVisible({ timeout: 60_000 });
  // A Lightning wallet made with New instead: its card is on the page, chosen, and the setup is gone.
  await createWallet(alice, "lightning", "testnet", { provider: "fake-lightning", fill: async (form) => {
    await form.getByLabel("Access token").fill("a-test-token");
    await form.getByTestId("provider-save").click();
  } });
  await expect(first).toHaveCount(0);
  await expect(alice.page.getByTestId("wallet-card-lightning-testnet")).toBeInViewport();
});

test("New makes a Testnet kind in one click, checked before its card appears, and says what each Mainnet kind asks for", { tag: ["@feature:wallet.instances.create", "@feature:wallet.fedimint.mainnet"] }, async ({ peer }) => {
  const alice = await peer("new-one-click");
  await createWallet(alice, "cashu", "testnet");
  await expect(alice.page.getByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  await expect(panelBalance(alice)).toHaveText(/^0\s*test sats/);

  await alice.page.getByTestId("wallet-add").click();
  const dialog = alice.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await expect(dialog.getByTestId("new-wallet-type-cashu-status")).toHaveText("Added");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  // Spark asks for the person's Breez API key, Fedimint for a federation's invite: neither is made in one click.
  await expect(dialog.getByTestId("new-wallet-type-spark-status")).toHaveText("Create…");
  await expect(dialog.getByTestId("new-wallet-type-fedimint-status")).toHaveText("Join with invite…");
  await dialog.getByTestId("new-wallet-type-spark").click();
  await expect(dialog.getByTestId("new-wallet-api-key")).toBeVisible();
  await expect(dialog.getByTestId("new-wallet-progress")).toHaveCount(0);
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-spark-]")).toHaveCount(0);
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

test("two people pay on the same network; a card of a network the contact has no wallet on is not offered", { tag: ["@feature:wallet.instances.networks", "@feature:payments.chat.networks", "@feature:payments.cashu.send"] }, async ({ peer }) => {
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
  await expect(review.getByTestId("review-rail")).toHaveText("Cashu");
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

test("on a phone: a kind that could not be made says why on its own card, not only under the fold", { tag: ["@feature:wallet.instances.create", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const phone = { width: 390, height: 844 };
  const alice = await peer("new-fails-phone", { mobile: true, viewport: phone, offlineMainnet: true });
  // The test mint is down.
  await alice.context.route(/^https:\/\/testnut\.cashu\.space\//, (route) => route.abort("connectionrefused"));
  await alice.page.getByTestId("mobile-tabs").getByRole("button", { name: "Wallets" }).click();
  await alice.page.getByTestId("wallet-add").click();
  const sheet = alice.page.getByTestId("new-wallet");
  await sheet.getByRole("radio", { name: "Testnet" }).click();
  const cashu = sheet.getByTestId("new-wallet-type-cashu");
  await cashu.click();
  await expect(cashu).toHaveAttribute("data-state", "error", { timeout: 60_000 });
  // The whole message is under the eight kinds, below the bottom of the screen; the card says why in a line.
  const reason = sheet.getByTestId("new-wallet-type-cashu-reason");
  await expect(reason).toHaveText("Could not reach testnut.cashu.space.");
  const box = (await reason.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(phone.height);
});
