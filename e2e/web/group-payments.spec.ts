import { expect, openWallet, test, type Peer } from "../support/fixtures";

/**
 * Payments in a group (WISP 9xx § Payments), three browsers and a real Cashu mint (the test mint, or `E2E_MINT_URL`,
 * see support/mint.ts). Alice asks Bob; Carol sees the request and then sees it paid, though the ecash went only
 * between the two. Then Alice asks the whole group: Carol pays it, once, and everyone sees who did.
 */
test.describe("group payments", { tag: "@network" }, () => {
  test.describe.configure({ retries: 1 });

  const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
  const timeline = (peer: Peer) => peer.page.locator(".chat-wallpaper");

  async function setName(peer: Peer, name: string): Promise<void> {
    await peer.page.getByTestId("account-profile").click();
    await peer.page.getByTestId("account-nickname").fill(name);
    await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
    await peer.page.goBack();
    await expect(peer.page.getByTitle("New Chat")).toBeVisible();
  }

  /** Testnet (the test mint is primary), and, for a payer, test sats from the mint's own invoice. */
  async function testnet(peer: Peer, fund = 0): Promise<void> {
    await openWallet(peer, "cashu");
    await peer.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
    await expect(peer.page.getByTestId("wallet-test-balance")).toBeVisible();
    if (fund) {
      await peer.page.getByTestId("wallet-receive").click();
      await peer.page.getByTestId("wallet-receive-amount").fill(String(fund));
      await peer.page.getByTestId("wallet-create-invoice").click();
      await expect(peer.page.getByTestId("wallet-test-balance")).toHaveText(new RegExp(`^${fund} test sats`), { timeout: 60_000 });
    }
    await peer.page.goBack();
  }

  /** ⚡ in the group: whom, then the Cashu card, an amount, Request. */
  async function request(peer: Peer, whom: string | "group", amount: number, memo: string): Promise<void> {
    await peer.page.getByTestId("payment-button").click();
    if (whom === "group") await peer.page.getByTestId("group-pay-everyone").click();
    else await peer.page.getByTestId("group-pay-recipient").filter({ hasText: whom }).click();
    await peer.page.getByTestId("payment-card-cashu").click();
    await peer.page.getByTestId("payment-amount").fill(String(amount));
    await peer.page.getByPlaceholder("What for? (optional)").fill(memo);
    await peer.page.getByTestId("payment-request").click();
    await expect(peer.page.getByTestId("payment-composer")).toHaveCount(0);
  }

  /** Pays the request with this memo from its bubble, through the review. */
  async function pay(peer: Peer, memo: string): Promise<void> {
    const bubble = timeline(peer).getByTestId("payment-bubble").filter({ hasText: memo });
    await bubble.getByTestId("payment-pay").click({ timeout: 90_000 });
    const review = timeline(peer).getByTestId("payment-review");
    await expect(review).toContainText("cashu-test");
    await review.getByRole("button", { name: "Approve payment" }).click();
  }

  test("a request between two members, seen by the third; a request to the group, paid once", { tag: ["@feature:groups.payments.member", "@feature:groups.payments.group-request", "@feature:groups.payments.notes"] }, async ({ peer }) => {
    test.setTimeout(10 * 60_000);
    const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
    await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);
    await Promise.all([testnet(alice), testnet(bob, 100), testnet(carol, 100)]);

    await alice.page.getByTestId("sidebar-new-more").click();
    await alice.page.getByTestId("new-group").click();
    await alice.page.getByTestId("new-group-name").fill("Lunch");
    await alice.page.getByTestId("new-group-create").click();
    const url = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
    await alice.page.getByTestId("group-share-done").click();
    for (const p of [bob, carol]) {
      await p.page.goto(url);
      await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
    }
    for (const p of [alice, bob, carol]) await expect(p.page.getByTestId("group-connection-options")).toHaveAttribute("data-state", "connected", { timeout: 120_000 });

    // Alice asks Bob. Only Bob can pay it; Carol sees it happen.
    await request(alice, "Bob", 21, "tacos");
    await expect(timeline(alice).getByTestId("group-pay-caption").filter({ hasText: "You asked Bob" })).toContainText("Waiting for payment");
    const carolSees = timeline(carol).getByTestId("group-pay-note").filter({ hasText: "tacos" });
    await expect(carolSees.getByTestId("group-pay-note-title")).toHaveText("Alice asked Bob", { timeout: 60_000 });
    await expect(carolSees).toHaveAttribute("data-state", "open");
    await expect(carolSees.getByTestId("payment-pay")).toHaveCount(0);
    await expect(timeline(carol).getByTestId("payment-bubble").filter({ hasText: "tacos" })).toHaveCount(0);
    await pay(bob, "tacos");
    for (const p of [alice, bob]) await expect(timeline(p).getByTestId("payment-bubble").filter({ hasText: "tacos" }).filter({ hasText: /request/i }).getByTestId("payment-state")).toHaveText(/Paid/, { timeout: 90_000 });
    await expect(carolSees).toHaveAttribute("data-state", "paid", { timeout: 90_000 });
    await expect(carolSees.getByTestId("group-pay-note-state")).toHaveText("Paid");

    // Alice asks the whole group. Carol pays; Bob sees it paid by Carol and cannot pay it any more.
    await request(alice, "group", 10, "tip jar");
    for (const p of [bob, carol]) await expect(timeline(p).getByTestId("payment-bubble").filter({ hasText: "tip jar" }).getByTestId("payment-pay")).toBeVisible({ timeout: 90_000 });
    await expect(timeline(bob).getByTestId("group-pay-caption").filter({ hasText: "Alice asked the group" })).toContainText("Waiting for payment");
    await pay(carol, "tip jar");
    for (const p of [alice, bob, carol]) {
      await expect(timeline(p).getByTestId("group-pay-caption").filter({ hasText: "asked the group" })).toContainText(p === carol ? "Paid by you" : "Paid by Carol", { timeout: 90_000 });
      await expect(timeline(p).getByTestId("payment-bubble").filter({ hasText: "tip jar" }).first().getByTestId("payment-state")).toHaveText(/Paid|Received/);
    }
    await expect(timeline(bob).getByTestId("payment-bubble").filter({ hasText: "tip jar" }).getByTestId("payment-pay")).toHaveCount(0);

    // The money moved only once: Alice got 21 + 10, Carol paid 10 (and fees), Bob 21.
    await openWallet(alice, "cashu");
    await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^31 test sats/, { timeout: 60_000 });
    await openWallet(bob, "cashu");
    await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^(7[5-9]) test sats/);
    await openWallet(carol, "cashu");
    await expect(carol.page.getByTestId("wallet-test-balance")).toHaveText(/^(8[5-9]) test sats/);
  });
});
