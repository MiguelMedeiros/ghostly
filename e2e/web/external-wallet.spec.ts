import { chat, connect, expect, link, openChat, openWallet, say, test, type Peer } from "../support/fixtures";
import { LocalLnurlServer } from "../support/lnurl";

/**
 * Paying with a wallet that is not Ghostly, and paying a Lightning address. Sats move through the test
 * mint (`E2E_MINT_URL` answers for the public one when set, see support/mint.ts): worthless, and its
 * invoices pay themselves, so a request settles through the payee's own source with nobody pressing Pay
 * in the chat. The Lightning address is served by a server of this test's own (support/lnurl.ts).
 */
test.describe("another wallet", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  async function switchToTestMint(peer: Peer): Promise<void> {
    await openWallet(peer, "cashu");
    await peer.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
    await expect(peer.page.getByTestId("wallet-test-balance")).toBeVisible();
  }

  async function receive(peer: Peer, sats: number): Promise<string> {
    await openWallet(peer, "cashu");
    await peer.page.getByTestId("wallet-receive").click();
    await peer.page.getByTestId("wallet-receive-amount").fill(String(sats));
    await peer.page.getByTestId("wallet-create-invoice").click();
    return (await peer.page.getByTestId("wallet-invoice").textContent())!.trim();
  }

  test("a request is paid with another wallet, and the bubble turns Paid by itself on both sides", async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await switchToTestMint(p);
    // Alice holds sats in her own wallet: the "other wallet" that will pay Bob's invoice.
    await receive(alice, 100);
    await expect(alice.page.getByTestId("wallet-paid")).toBeVisible();
    for (const p of [alice, bob]) await openChat(p);

    // The wallet page's receive side shows the same thing a contact gets: QR, text, Copy, a lightning: link.
    await openWallet(bob, "lightning");
    await bob.page.getByTestId("wallet-receive").click();
    await bob.page.getByTestId("wallet-receive-amount").fill("7");
    await bob.page.getByTestId("wallet-create-invoice").click();
    const shown = (await bob.page.getByTestId("wallet-invoice").textContent())!.trim();
    await expect(bob.page.getByTestId("wallet-invoice-qr").locator("svg")).toBeVisible();
    await expect(bob.page.getByTestId("wallet-invoice-link")).toHaveAttribute("href", `lightning:${shown}`);
    await openChat(bob);

    // Bob asks for 10 sats. Alice never presses Pay: she pays the invoice from her own wallet page instead.
    await bob.page.getByTestId("payment-button").click();
    await bob.page.getByTestId("payment-card-cashu").click();
    await bob.page.getByTestId("payment-amount").fill("10");
    await bob.page.getByTestId("payment-request").click();
    const bubble = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "10" });
    await expect(bubble(alice)).toBeVisible();
    await bubble(alice).getByTestId("payment-external").click();
    const panel = bubble(alice).getByTestId("payment-external-external");
    await expect(panel.getByTestId("payment-external-qr").locator("svg")).toBeVisible();
    const invoice = (await panel.getByTestId("payment-external").textContent())!.trim();
    expect(invoice.startsWith("lnbc"), "the request carries a Lightning invoice").toBe(true);
    await expect(panel.getByTestId("payment-external-link")).toHaveAttribute("href", `lightning:${invoice}`);
    await panel.getByTestId("payment-external-copy").click();
    expect((await alice.page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(invoice);
    await expect(panel.getByTestId("payment-external-copy")).toHaveText("Copied");
    // "I paid" asks Bob's app to look; it marks nothing paid by itself.
    await panel.getByTestId("payment-external-paid").click();
    await expect(panel.getByTestId("payment-external-checking")).toBeVisible();

    // Alice pays the invoice from her wallet, as any other wallet would.
    await openWallet(alice, "cashu");
    await alice.page.getByTestId("wallet-send").click();
    await alice.page.getByTestId("wallet-pay-input").fill(invoice);
    await expect(alice.page.getByTestId("wallet-pay-preview")).toContainText("10 sats");
    await alice.page.getByRole("button", { name: "Pay 10 sats" }).click();
    await expect(alice.page.getByRole("button", { name: "Pay", exact: true })).toBeVisible();
    await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
    // The test mint settles its own invoices, so it may have paid Bob before Alice's melt reached it.
    await expect(alice.page.getByTestId("wallet-notice").or(alice.page.getByTestId("wallet-error"))).toBeVisible();
    await openChat(alice);

    // Bob's source saw the invoice paid: his request is Paid, and he told Alice, whose bubble turned Paid too.
    await expect(bubble(bob).getByTestId("payment-state")).toHaveText(/Paid/);
    await expect(bubble(alice).getByTestId("payment-state")).toHaveText(/Paid/);
    await expect(bubble(alice).getByTestId("payment-pay"), "nothing left to pay").toHaveCount(0);
  });

  test("a Lightning address is resolved against a local server and paid through the Cashu source", async ({ peer }) => {
    const server = new LocalLnurlServer(45911);
    server.names.set("shop", { description: "Coffee at the shop", minSat: 5, maxSat: 500, commentAllowed: 40 });
    server.names.set("fixed", { description: "One ticket", minSat: 12, maxSat: 12 });
    await server.start();
    try {
      const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
      await link(alice, bob);
      await connect(alice, bob);
      await switchToTestMint(alice);
      await receive(alice, 100);
      await expect(alice.page.getByTestId("wallet-paid")).toBeVisible();

      // The wallet's Send tab: the address, the domain it will ask, the amount within the limits, a comment.
      await alice.page.getByTestId("wallet-send").click();
      await alice.page.getByTestId("wallet-pay-input").fill(server.address("shop"));
      const pay = alice.page.getByTestId("wallet-lnurl");
      await expect(pay).toContainText(server.host);
      expect(server.requests, "nothing is fetched before the person asks").toHaveLength(0);
      await pay.getByTestId("lnurl-lookup").click();
      await expect(pay.getByTestId("lnurl-domain")).toContainText(`Answered by ${server.host}`);
      await expect(pay.getByTestId("lnurl-domain")).toContainText("5 to 500 sats");
      await expect(pay).toContainText("Coffee at the shop");
      await pay.getByTestId("lnurl-amount").fill("21");
      await pay.getByTestId("lnurl-comment").fill("gm");
      await pay.getByTestId("lnurl-invoice").click();
      await expect(pay.getByTestId("lnurl-review")).toContainText("Pay 21 sats to shop@");
      await expect(pay.getByTestId("lnurl-review")).toContainText("through the Cashu mints");
      expect(server.invoices.at(-1)).toMatchObject({ name: "shop", amountSat: 21, comment: "gm" });
      await pay.getByTestId("lnurl-pay").click();
      await expect(pay.getByTestId("lnurl-paid")).toContainText(`Paid 21 sats to ${server.address("shop")}`);
      await expect(pay.getByTestId("lnurl-success")).toContainText('Thanks for "gm"');
      await expect.poll(() => server.paid("shop"), { timeout: 30_000 }).toBe(true);

      // An amount outside the limits never reaches the server.
      await alice.page.getByTestId("wallet-pay-input").fill(server.address("fixed"));
      await pay.getByTestId("lnurl-lookup").click();
      await expect(pay.getByTestId("lnurl-domain")).toContainText("exactly 12 sats");
      await expect(pay.getByTestId("lnurl-amount")).toHaveValue("12");
      await expect(pay.getByTestId("lnurl-comment"), "no comment where none is taken").toHaveCount(0);
      const before = server.requests.length;
      await alice.page.getByTestId("wallet-pay-input").fill(server.address("shop"));
      await pay.getByTestId("lnurl-lookup").click();
      await pay.getByTestId("lnurl-amount").fill("501");
      await pay.getByTestId("lnurl-invoice").click();
      await expect(pay.getByTestId("lnurl-error")).toContainText("between 5 and 500 sats");
      expect(server.requests.length, "the well-known lookups only").toBe(before + 1);

      // An address pasted in the chat is a card the contact can pay the same way, and looks nothing up until tapped.
      await openChat(alice);
      await say(bob, server.address("shop"));
      const card = chat(alice).getByTestId("lnurl-bubble");
      await expect(card.getByTestId("lnurl-text")).toHaveText(server.address("shop"));
      await expect(card).toContainText(`Pays through ${server.host}`);
      await expect(chat(bob).getByTestId("lnurl-bubble").getByTestId("lnurl-pay-open"), "nobody pays their own address").toHaveCount(0);
      const lookups = server.requests.length;
      await card.getByTestId("lnurl-pay-open").click();
      await expect(card.getByTestId("lnurl-resolve")).toContainText(server.host);
      expect(server.requests.length).toBe(lookups);
      await card.getByTestId("lnurl-lookup").click();
      await expect(card.getByTestId("lnurl-domain")).toContainText(`Answered by ${server.host}`);
      await card.getByTestId("lnurl-amount").fill("5");
      await card.getByTestId("lnurl-invoice").click();
      await card.getByTestId("lnurl-pay").click();
      await expect(card.getByTestId("lnurl-paid")).toContainText("Paid 5 sats");
    } finally {
      server.close();
    }
  });
});
