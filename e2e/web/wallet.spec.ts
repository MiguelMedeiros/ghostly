import { chat, connect, expect, link, openChat, openWallet, test, type Peer } from "../support/fixtures";
import { TEST_MINT, mintEndpoint } from "../support/mint";

/**
 * Sats move through a real Cashu mint: the test mint, whose sats are worthless
 * and whose invoices pay themselves. That is the public one unless
 * `E2E_MINT_URL` names another — CI runs its own, see support/mint.ts — so
 * these tests need the internet only when nobody gave them a mint.
 * Wallets start with real mints too; the tests never touch them.
 */
test.describe("wallet", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  const balance = async (peer: Peer) => {
    await showCashu(peer);
    return Number(((await peer.page.getByTestId("wallet-test-balance").textContent()) ?? "").match(/^([\d,]+)/)![1].replace(",", ""));
  };
  async function showCashu(peer: Peer): Promise<void> {
    if (await peer.page.getByTestId("wallet-test-balance").isVisible()) return;
    await openWallet(peer, "cashu");
  }

  async function switchToTestMint(peer: Peer): Promise<void> {
    await openWallet(peer, "cashu");
    await peer.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
    await expect(peer.page.getByTestId("wallet-test-balance")).toBeVisible();
    await openChat(peer);
  }

  async function receive(peer: Peer, sats: number): Promise<string> {
    await openWallet(peer, "cashu");
    await peer.page.getByTestId("wallet-receive").click();
    await peer.page.getByTestId("wallet-receive-amount").fill(String(sats));
    await peer.page.getByTestId("wallet-create-invoice").click();
    return (await peer.page.getByTestId("wallet-invoice").textContent())!.trim();
  }

  test("Lightning in, ecash between two people, requests, history and fees", async ({ peer }, testInfo) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await switchToTestMint(p);

    const invoice = await receive(alice, 100);
    expect(invoice.startsWith("lnbc"), "the mint issued a Lightning invoice").toBe(true);
    await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^100 test sats/);
    await expect(alice.page.getByTestId("wallet-paid")).toBeVisible();

    await openChat(alice);
    await alice.page.getByTestId("payment-button").click();
    await alice.page.getByTestId("payment-card-cashu").click();
    await alice.page.getByTestId("payment-amount").fill("21");
    // The Cashu card turned over; the mint that holds the sats pays, so there is no mint to pick.
    await alice.page.getByTestId("payment-send").click();
    const directReview = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
    await expect(directReview).toContainText("cashu-test");
    await showCashu(bob);
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^0 test sats/);
    await directReview.getByRole("button", { name: "Approve payment" }).click();
    const sent = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state");
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^21 test sats/);
    await openChat(bob);
    await expect(sent(bob)).toHaveText(/Received/);
    await expect(sent(alice)).toHaveText(/Received/);
    await directReview.getByRole("button", { name: "Close", exact: true }).click();

    // Bob asks for ecash only: with Lightning on, the test mint would pay the request's own invoice by
    // itself, racing Alice (it is a faucet), and the request could be paid before she gets to it.
    await bob.page.getByTitle("Options").click();
    await bob.page.getByTestId("chat-payments-open").click();
    await bob.page.getByTestId("chat-payments").getByTestId("chat-payments-lightning").click();
    await bob.page.getByTestId("chat-payments-save").click();
    await bob.page.getByTestId("payment-button").click();
    await bob.page.getByTestId("payment-card-cashu").click();
    await bob.page.getByTestId("payment-amount").fill("10");
    await bob.page.getByTestId("payment-request").click();
    await alice.page.getByTestId("payment-pay").click();
    const requestReview = chat(alice).getByTestId("payment-review");
    await expect(requestReview).toContainText("cashu-test");
    await requestReview.getByRole("button", { name: "Approve payment" }).click();
    for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "equest" }).getByTestId("payment-state")).toHaveText(/Paid/);
    await showCashu(bob);
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^31 test sats/);

    await showCashu(alice);
    await alice.page.getByTestId("wallet-history").click();
    const txs = await alice.page.getByTestId("wallet-tx").allTextContents();
    expect(txs).toHaveLength(3);
    // The test mint charges 100 ppk: each ecash payment costs a sat or two, the Lightning receive nothing.
    expect(txs[2]).toContain("no fee");
    expect(txs[1]).toMatch(/fee \d/);
    expect(txs[0]).toMatch(/fee \d/);
    const fees = Number((await alice.page.getByTestId("wallet-fees-paid").textContent())!.match(/(\d+) sats/)![1]);
    expect(await balance(alice), "balance = received - sent - fees, to the sat").toBe(100 - 21 - 10 - fees);
    await alice.page.screenshot({ path: testInfo.outputPath("cashu-chat-history.png"), fullPage: true });
    await expect(alice.page.getByTestId("mint-fees").filter({ hasText: "0.1 sat per proof" })).toBeVisible();
  });

  test("test-mint ecash reaches a contact who never turned test sats on", async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    await switchToTestMint(alice);
    await receive(alice, 50);
    await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^50 test sats/);
    await openChat(alice);
    await alice.page.getByTestId("payment-button").click();
    await alice.page.getByTestId("payment-card-cashu").click();
    await alice.page.getByTestId("payment-amount").fill("10");
    await alice.page.getByTestId("payment-send").click();
    const review = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
    await review.getByRole("button", { name: "Approve payment" }).click();
    const sent = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "10" }).getByTestId("payment-state");
    await expect(sent(bob)).toHaveText(/Received/, { timeout: 60000 });
    await expect(sent(alice)).toHaveText(/Received/);
    // Bob is on Mainnet: the test sats wait in Testnet, and the wallet says where they are.
    await openWallet(bob, "cashu");
    await expect(bob.page.getByTestId("wallet-balance")).toContainText(/^0\s*sats/);
    await expect(bob.page.getByTestId("wallet-waiting-test-sats")).toContainText("10 test sats are waiting in Testnet");
    await bob.page.getByTestId("wallet-waiting-test-sats").getByRole("button", { name: "Switch to Testnet" }).click();
    await expect(bob.page.getByTestId("testnet-badge")).toBeVisible();
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^10 test sats/);
  });

  test("an invoice pasted into the chat is a card that can be paid", async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await switchToTestMint(p);
    await receive(alice, 50);
    await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^50 test sats/);

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
    // The wallet quotes it, fee reserve included, before anything is paid. The test mint settles its own
    // invoices, so this one is already paid: the card has to say so without spending anything.
    await card.getByTestId("invoice-confirm").click();
    await expect(card.getByTestId("invoice-paid")).toBeVisible();
  });

  test("an ecash token pasted into the chat can be redeemed", async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await switchToTestMint(p);

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
