import { chat, connect, expect, link, openChat, openWallet, test, type Peer } from "../support/fixtures";

// Sats that come in while the wallet is closed show as a count on the wallet icon, until it is opened.
test.describe("wallet badge", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  async function testSats(peer: Peer) {
    await openWallet(peer, "cashu");
    await peer.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
    await expect(peer.page.getByTestId("wallet-balance")).toBeVisible();
  }

  test("what came in while the wallet was closed shows on its icon, and goes once it is opened", { tag: ["@feature:wallet.badge", "@feature:payments.cashu.send"] }, async ({ peer }, testInfo) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) { await testSats(p); await openChat(p); }
    await expect(bob.page.getByTestId("wallet-new")).toHaveCount(0);

    await openWallet(alice, "cashu");
    await alice.page.getByTestId("wallet-receive").click();
    await alice.page.getByTestId("wallet-receive-amount").fill("50");
    await alice.page.getByTestId("wallet-create-invoice").click();
    await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^50\s*sats/);
    // Her own wallet was open when they arrived: nothing to point out.
    await openChat(alice);
    await expect(alice.page.getByTestId("wallet-new")).toHaveCount(0);

    await alice.page.getByTestId("payment-button").click();
    await alice.page.getByTestId("payment-card-cashu").click();
    await alice.page.getByTestId("payment-amount").fill("21");
    await alice.page.getByTestId("payment-send").click();
    await alice.page.getByTestId("payment-composer").getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
    await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state")).toHaveText(/Received/);

    // Test sats: an outlined count on the icon, and the button says it to screen readers.
    const badge = bob.page.getByTestId("wallet-new");
    await expect(badge).toHaveText("+21");
    await expect(badge).toHaveClass(/wallet-new-test/);
    await expect(bob.page.getByTestId("wallet-chip")).toHaveAttribute("aria-label", /21 new sats/);
    // It sits on the icon, inside the wallet button, not in the gap beside it.
    const icon = (await bob.page.getByTestId("wallet-chip").locator("svg").boundingBox())!;
    const box = (await badge.boundingBox())!, button = (await bob.page.getByTestId("wallet-chip").boundingBox())!;
    expect(box.x).toBeGreaterThan(icon.x);
    expect(box.x).toBeLessThan(icon.x + icon.width + 4);
    expect(box.x + box.width).toBeLessThanOrEqual(button.x + button.width);
    await bob.page.getByTestId("account-bar").screenshot({ path: testInfo.outputPath("wallet-badge.png") });

    await bob.page.getByTestId("wallet-chip").click();
    await expect(badge).toHaveCount(0);
    await bob.page.goBack();
    await expect(badge).toHaveCount(0);
  });
});
