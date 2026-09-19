import { chat, connect, expect, link, test, type Peer } from "../support/fixtures";

const TEST_MINT = "https://testnut.cashu.space";

/**
 * Sats move through a real Cashu mint: the public test mint, whose sats are
 * worthless and whose invoices pay themselves. These tests need the internet.
 * Wallets start with real mints too; the tests never touch them.
 */
test.describe("wallet", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  const balance = async (peer: Peer) => Number(((await peer.page.getByTestId("wallet-test-balance").textContent()) ?? "").match(/^([\d,]+)/)![1].replace(",", ""));

  async function switchToTestMint(peer: Peer): Promise<void> {
    await peer.page.getByTestId("wallet-settings").click();
    await peer.page.getByTestId("wallet-test-mint").click();
    await expect(peer.page.getByTestId("wallet-test-balance")).toBeVisible();
    await peer.page.getByTestId("wallet-settings").click();
  }

  async function receive(peer: Peer, sats: number): Promise<string> {
    await peer.page.getByTestId("wallet-receive").click();
    await peer.page.getByTestId("wallet-receive-amount").fill(String(sats));
    await peer.page.getByTestId("wallet-create-invoice").click();
    return (await peer.page.getByTestId("wallet-invoice").textContent())!.trim();
  }

  test("Lightning in, ecash between two people, requests, history and fees", async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await switchToTestMint(p);

    const invoice = await receive(alice, 100);
    expect(invoice.startsWith("lnbc"), "the mint issued a Lightning invoice").toBe(true);
    await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^100 test sats/);
    await expect(alice.page.getByTestId("wallet-paid")).toBeVisible();

    await alice.page.getByTestId("payment-button").click();
    await alice.page.getByTestId("payment-amount").fill("21");
    await alice.page.getByTestId("payment-send").click();
    const sent = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state");
    await expect(sent(bob)).toHaveText(/Received/);
    await expect(sent(alice)).toHaveText(/Received/);
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^21 test sats/);

    await bob.page.getByTestId("payment-button").click();
    await bob.page.getByTestId("payment-amount").fill("10");
    await bob.page.getByTestId("payment-request").click();
    await alice.page.getByTestId("payment-pay").click();
    for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "equest" }).getByTestId("payment-state")).toHaveText(/Paid/);
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^31 test sats/);

    await alice.page.getByTestId("wallet-history").click();
    const txs = await alice.page.getByTestId("wallet-tx").allTextContents();
    expect(txs).toHaveLength(3);
    // The test mint charges 100 ppk: each ecash payment costs a sat or two, the Lightning receive nothing.
    expect(txs[2]).toContain("no fee");
    expect(txs[1]).toMatch(/fee \d/);
    expect(txs[0]).toMatch(/fee \d/);
    const fees = Number((await alice.page.getByTestId("wallet-fees-paid").textContent())!.match(/(\d+) sats/)![1]);
    expect(await balance(alice), "balance = received - sent - fees, to the sat").toBe(100 - 21 - 10 - fees);
    await alice.page.getByTestId("wallet-history").click();
    await alice.page.getByTestId("wallet-settings").click();
    await expect(alice.page.getByTestId("mint-fees").filter({ hasText: "0.1 sat per proof" })).toBeVisible();
  });

  test("an invoice pasted into the chat is a card that can be paid", async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await switchToTestMint(p);
    await receive(alice, 50);
    await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^50 test sats/);

    const pasted = await receive(bob, 12);
    await bob.page.getByTestId("wallet-receive").click();
    await bob.page.getByPlaceholder("Type a message").fill(`coffee? ${pasted}`);
    await bob.page.getByPlaceholder("Type a message").press("Enter");
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
    const outside = new Wallet(TEST_MINT, { unit: "sat" });
    await outside.loadMint();
    const quote = await outside.createMintQuoteBolt11(7);
    let proofs: Awaited<ReturnType<typeof outside.mintProofsBolt11>> | null = null;
    // The test mint pays its own invoices, a moment later.
    await expect.poll(async () => (proofs = await outside.mintProofsBolt11(7, quote.quote).catch(() => null)), { intervals: [1500] }).not.toBeNull();
    const token = getEncodedToken({ mint: TEST_MINT, proofs: proofs!, unit: "sat", memo: "lunch" });

    await bob.page.getByPlaceholder("Type a message").fill(token);
    await bob.page.getByPlaceholder("Type a message").press("Enter");
    const card = chat(alice).getByTestId("cashu-token-bubble").last();
    await expect(card.getByTestId("money-amount")).toHaveText("7");
    await expect(card).toContainText("testnut.cashu.space");
    await expect(card).toContainText("lunch");
    const before = await balance(alice);
    await card.getByTestId("token-redeem").click();
    await expect(card.getByTestId("token-redeemed")).toBeVisible();
    await expect.poll(() => balance(alice), "redeeming adds the sats, minus the mint's fee").toBeGreaterThan(before);
    expect(await balance(alice)).toBeLessThanOrEqual(before + 7);
  });
});
