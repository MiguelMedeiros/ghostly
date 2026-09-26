import { TEST_COINS, chat, connect, createWallet, expect, getTestCoins, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { TEST_MINT, mintEndpoint, mockMainnetMints } from "../support/mint";
import { composerRow } from "../support/composer";
import { chatPayments, paymentCard } from "../support/payments";

/**
 * Sats move through a real Cashu mint: the test mint, whose sats are worthless
 * and whose invoices read paid by themselves (Receive waits for a payer anyway;
 * test sats come from Get test coins). That is the public one unless
 * `E2E_MINT_URL` names another — CI runs its own, see support/mint.ts — so
 * these tests need the internet only when nobody gave them a mint.
 * A new profile has no wallet: each test makes the Testnet Cashu wallets it needs with New, before the two meet.
 */
test.describe("wallet", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  const balance = async (peer: Peer) => {
    await showCashu(peer);
    return Number(((await peer.page.getByTestId("wallet-balance").textContent()) ?? "").match(/^([\d,]+)/)![1].replace(",", ""));
  };
  async function showCashu(peer: Peer): Promise<void> {
    if (await peer.page.getByTestId("wallet-balance").isVisible()) return;
    await openWallet(peer, "cashu-testnet");
  }

  async function receive(peer: Peer, sats: number): Promise<string> {
    await openWallet(peer, "cashu-testnet");
    await peer.page.getByTestId("wallet-receive").click();
    await peer.page.getByTestId("wallet-receive-amount").fill(String(sats));
    await peer.page.getByTestId("wallet-create-invoice").click();
    return (await peer.page.getByTestId("wallet-invoice").textContent())!.trim();
  }

  test("Receive waits, test coins in, ecash between two people, requests, history and fees", { tag: ["@feature:wallet.cashu.receive-lightning", "@feature:wallet.testnet.receive-held", "@feature:wallet.test-coins", "@feature:payments.cashu.send", "@feature:payments.cashu.request", "@feature:payments.chat.review", "@feature:wallet.history"] }, async ({ peer }, testInfo) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    for (const p of [alice, bob]) await useTestnet(p);
    await link(alice, bob);
    await connect(alice, bob);

    // Receive only makes the invoice: the test mint reads it paid by itself (a poll every 4 s), and nothing comes of it.
    const invoice = await receive(alice, 100);
    expect(invoice.startsWith("lnbc"), "the mint issued a Lightning invoice").toBe(true);
    await alice.page.waitForTimeout(12_000);
    await expect(alice.page.getByTestId("wallet-paid")).toHaveCount(0);
    await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^0\s*test sats/);
    // Test sats come when asked for.
    await getTestCoins(alice);
    await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);

    await openChat(alice);
    await (await composerRow(alice.page, "payment-button")).click();
    await paymentCard(alice.page, "cashu-testnet").click();
    await alice.page.getByTestId("payment-amount").fill("21");
    // The Cashu card turned over; the mint that holds the sats pays, so there is no mint to pick.
    await alice.page.getByTestId("payment-send").click();
    const directReview = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
    await expect(directReview).toContainText("cashu-test");
    await showCashu(bob);
    await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^0\s*test sats/);
    await directReview.getByRole("button", { name: "Approve payment" }).click();
    const sent = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state");
    await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^21\s*test sats/);
    await openChat(bob);
    await expect(sent(bob)).toHaveText(/Received/);
    await expect(sent(alice)).toHaveText(/Received/);
    // The sheet closed once the payment went out.
    await expect(alice.page.getByTestId("payment-composer")).toHaveCount(0);

    // Bob asks for ecash only: the request is paid in ecash, reviewed.
    await chatPayments(bob.page, { lightning: false });
    await (await composerRow(bob.page, "payment-button")).click();
    await paymentCard(bob.page, "cashu-testnet").click();
    await bob.page.getByTestId("payment-amount").fill("10");
    await bob.page.getByTestId("payment-request").click();
    await alice.page.getByTestId("payment-pay").click();
    const requestReview = chat(alice).getByTestId("payment-review");
    await expect(requestReview).toContainText("cashu-test");
    await requestReview.getByRole("button", { name: "Approve payment" }).click();
    for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "equest" }).getByTestId("payment-state")).toHaveText(/Paid/);
    await showCashu(bob);
    await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^31\s*test sats/);

    await showCashu(alice);
    await alice.page.getByTestId("wallet-history").click();
    const txs = await alice.page.getByTestId("wallet-tx").allTextContents();
    expect(txs).toHaveLength(3);
    // The test mint charges 100 ppk: each ecash payment costs a sat or two, the test coins nothing.
    expect(txs[2]).toContain("no fee");
    expect(txs[1]).toMatch(/fee \d/);
    expect(txs[0]).toMatch(/fee \d/);
    const fees = Number((await alice.page.getByTestId("wallet-fees-paid").textContent())!.match(/(\d+) (?:test )?sats/)![1]);
    await expect.poll(() => balance(alice), "balance = received - sent - fees, to the sat").toBe(TEST_COINS - 21 - 10 - fees);
    await alice.page.screenshot({ path: testInfo.outputPath("cashu-chat-history.png"), fullPage: true });
    await expect(alice.page.getByTestId("mint-fees").filter({ hasText: "0.1 sat per proof" })).toBeVisible();
  });

  test("test-mint ecash reaches the contact's Testnet wallet and never their Mainnet one", { tag: ["@feature:payments.cashu.test-sats", "@feature:payments.cashu.send", "@feature:wallet.instances.networks"] }, async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    // Bob has real money and test sats side by side (his Mainnet mints answered by the suite's own mint).
    await mockMainnetMints(bob.context);
    await useTestnet(alice);
    await createWallet(bob, "cashu", "mainnet");
    await createWallet(bob, "cashu", "testnet");
    await link(alice, bob);
    await connect(alice, bob);
    await getTestCoins(alice);
    await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);
    await openChat(alice);
    await (await composerRow(alice.page, "payment-button")).click();
    await paymentCard(alice.page, "cashu-testnet").click();
    await alice.page.getByTestId("payment-amount").fill("10");
    await alice.page.getByTestId("payment-send").click();
    const review = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
    await review.getByRole("button", { name: "Approve payment" }).click();
    const sent = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "10" }).getByTestId("payment-state");
    await expect(sent(bob)).toHaveText(/Received/, { timeout: 60000 });
    await expect(sent(alice)).toHaveText(/Received/);
    // Each network's wallet shows its own balance: the test sats are in Testnet, the Mainnet wallet got nothing.
    await openWallet(bob, "cashu-testnet");
    await expect.poll(async () => (await bob.page.getByTestId("wallet-balance").innerText()).trim(), { timeout: 15_000 }).toMatch(/^10\s*test sats/);
    await openWallet(bob, "cashu-mainnet");
    await expect.poll(async () => (await bob.page.getByTestId("wallet-balance").innerText()).trim()).toMatch(/^0\s*sats/);
    await expect(bob.page.getByTestId("wallet-waiting-test-sats")).toHaveCount(0);
  });

  test("an invoice pasted into the chat is a card that can be paid", { tag: ["@feature:payments.lightning.invoice-card"] }, async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    for (const p of [alice, bob]) await useTestnet(p);
    await link(alice, bob);
    await connect(alice, bob);
    await getTestCoins(alice);
    await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);

    const pasted = await receive(bob, 12);
    await openChat(bob);
    await openChat(alice);
    await bob.page.getByPlaceholder("Message…").fill(`coffee? ${pasted}`);
    await bob.page.getByPlaceholder("Message…").press("Enter");
    const card = chat(alice).getByTestId("invoice-bubble").last();
    await expect(card.getByTestId("money-amount")).toHaveText("12");
    await expect(chat(alice).getByText("coffee?", { exact: true })).toBeVisible();
    await expect(card.locator("svg").first()).toBeVisible();
    await expect(chat(bob).getByTestId("invoice-bubble").last().getByTestId("invoice-pay"), "nobody pays their own invoice").toHaveCount(0);

    await card.getByTestId("invoice-pay").click();
    // The wallet quotes it, fee reserve included, before anything is paid. The test mint marks its own
    // invoices paid, so it answers this one is already paid: the card has to say so without spending anything.
    await card.getByTestId("invoice-confirm").click();
    await expect(card.getByTestId("invoice-paid")).toBeVisible();
  });

  test("an ecash token pasted into the chat can be redeemed", { tag: ["@feature:payments.cashu.token-card"] }, async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    for (const p of [alice, bob]) await useTestnet(p);
    await link(alice, bob);
    await connect(alice, bob);
    await openChat(alice);
    await openChat(bob);

    // Minted outside Ghostly, pasted like any other text.
    const { Wallet, getEncodedToken } = await import("@cashu/cashu-ts");
    // The bytes go wherever the mint actually is; the token still says testnut, as the app's does.
    const outside = new Wallet(mintEndpoint(), { unit: "sat" });
    await outside.loadMint();
    const quote = await outside.createMintQuoteBolt11(7);
    let proofs: Awaited<ReturnType<typeof outside.mintProofsBolt11>> | null = null;
    // The test mint pays its own invoices, a moment later.
    await expect.poll(async () => (proofs = await outside.mintProofsBolt11(7, quote.quote).catch(() => null)), { intervals: [1500] }).not.toBeNull();
    const token = getEncodedToken({ mint: TEST_MINT, proofs: proofs!, unit: "sat", memo: "lunch" });

    await bob.page.getByPlaceholder("Message…").fill(token);
    await bob.page.getByPlaceholder("Message…").press("Enter");
    // Ecash in the text box is money handed over: the composer asks first, with the amount read from the token.
    await expect(bob.page.getByRole("alertdialog", { name: /^Send 7 sats to .+\?$/ })).toBeVisible();
    await bob.page.getByTestId("secret-guard-send").click();
    const card = chat(alice).getByTestId("cashu-token-bubble").last();
    await expect(card.getByTestId("money-amount")).toHaveText("7");
    await expect(card).toContainText("testnut.cashu.space");
    await expect(card).toContainText("lunch");
    const before = await balance(alice);
    await openChat(alice);
    await card.getByTestId("token-redeem").click();
    await expect(card.getByTestId("token-redeemed")).toBeVisible();
    await expect.poll(() => balance(alice), "redeeming adds the sats, minus the mint's fee").toBeGreaterThan(before);
    expect(await balance(alice)).toBeLessThanOrEqual(before + 7);
  });
});
