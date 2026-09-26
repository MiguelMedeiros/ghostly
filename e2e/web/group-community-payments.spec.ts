import { expect, openProfilePage, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { paymentCard } from "../support/payments";

/**
 * Payments in a community group (WISP 9xx · Group Community § Payments), three browsers that never pair and a real
 * Cashu mint (the test mint, or `E2E_MINT_URL`, see support/mint.ts). Members have no edge to each other: the request
 * and the ecash go through the hubs, sealed to the two members. Alice asks Bob while Bob's app is closed; back, Bob
 * gets it from whoever is there and pays; Carol sees the request and then sees it paid. Then Alice asks the whole
 * group: Carol pays it, once, and everyone sees who did.
 */
test.describe("community payments", { tag: "@network" }, () => {
  test.describe.configure({ retries: 1 });

  const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
  const timeline = (peer: Peer) => peer.page.locator(".chat-wallpaper");

  async function setName(peer: Peer, name: string): Promise<void> {
    await openProfilePage(peer.page);
    await peer.page.getByTestId("account-nickname").fill(name);
    await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
    await peer.page.goBack();
    await expect(peer.page.getByTitle("New Chat")).toBeVisible();
  }

  /** A Testnet Cashu wallet made with New (the test mint is primary), and, for a payer, test sats from Get test coins. */
  async function testnet(peer: Peer, fund = false): Promise<void> {
    await useTestnet(peer);
    await openWallet(peer, "cashu-testnet");
    await expect(peer.page.getByTestId("wallet-balance")).toBeVisible();
    if (fund) {
      await peer.page.getByTestId("test-coins-get").click();
      await expect(peer.page.getByTestId("test-coins-result")).toHaveText("+10,000 test sats", { timeout: 60_000 });
      await expect(peer.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);
    }
    await peer.page.goBack();
  }

  /** Names travel with what members say, in a community: everyone says hello and hears everyone. */
  async function hello(peers: Peer[]): Promise<void> {
    for (const p of peers) {
      const box = p.page.getByPlaceholder("Message…");
      await expect(box).toBeEnabled({ timeout: 120_000 });
      await box.fill(`hi from ${p.name}`);
      await box.press("Enter");
    }
    for (const p of peers) for (const q of peers) await expect(timeline(p).getByText(`hi from ${q.name}`, { exact: true })).toBeVisible({ timeout: 180_000 });
  }

  /** ⚡ in the group: whom, then the Cashu card, an amount, Request. */
  async function request(peer: Peer, whom: string | "group", amount: number, memo: string): Promise<void> {
    await (await composerRow(peer.page, "payment-button")).click();
    if (whom === "group") await peer.page.getByTestId("group-pay-everyone").click();
    else await peer.page.getByTestId("group-pay-recipient").filter({ hasText: whom }).click();
    await paymentCard(peer.page, "cashu-testnet").click();
    await peer.page.getByTestId("payment-amount").fill(String(amount));
    await peer.page.getByPlaceholder("What for? (optional)").fill(memo);
    await peer.page.getByTestId("payment-request").click();
    await expect(peer.page.getByTestId("payment-composer")).toHaveCount(0);
  }

  /** Pays the request with this memo from its bubble, through the review. */
  async function pay(peer: Peer, memo: string): Promise<void> {
    const bubble = timeline(peer).getByTestId("payment-bubble").filter({ hasText: memo });
    await bubble.getByTestId("payment-pay").click({ timeout: 180_000 });
    const review = timeline(peer).getByTestId("payment-review");
    await expect(review).toContainText("cashu-test");
    await review.getByRole("button", { name: "Approve payment" }).click();
  }

  test("through the hubs: a request to a member who was away, seen by the third; a request to the group, paid once", { tag: ["@feature:groups.community.payments.member", "@feature:groups.community.payments.group-request"] }, async ({ peer }) => {
    test.setTimeout(15 * 60_000);
    const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
    await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);
    await Promise.all([testnet(alice), testnet(bob, true), testnet(carol, true)]);

    // A community: what New group makes by default.
    await alice.page.getByTestId("sidebar-new-more").click();
    await alice.page.getByTestId("new-group").click();
    await expect(alice.page.getByTestId("new-group-kind-community").getByRole("radio")).toBeChecked();
    await alice.page.getByTestId("new-group-name").fill("Lunch");
    await alice.page.getByTestId("new-group-create").click();
    const url = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
    await alice.page.getByTestId("group-share-done").click();
    for (const p of [bob, carol]) {
      await p.page.goto(url);
      await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
    }
    for (const p of [alice, bob, carol]) await expect(p.page.getByTestId("group-members")).toContainText("3 members", { timeout: 180_000 });
    await hello([alice, bob, carol]);

    // Bob's app is closed. Alice asks him anyway: the group keeps it, sealed to him.
    const bobUrl = bob.page.url();
    await bob.page.close();
    await request(alice, "Bob", 21, "tacos");
    await expect(timeline(alice).getByTestId("group-pay-caption").filter({ hasText: "You asked Bob" })).toContainText("Waiting for payment");
    const carolSees = timeline(carol).getByTestId("group-pay-note").filter({ hasText: "tacos" });
    await expect(carolSees.getByTestId("group-pay-note-title")).toHaveText("Alice asked Bob", { timeout: 120_000 });
    await expect(carolSees).toHaveAttribute("data-state", "open");
    // Carol carries it (her app may be a hub) but has nothing to pay it with.
    await expect(carolSees.getByTestId("payment-pay")).toHaveCount(0);
    await expect(timeline(carol).getByTestId("payment-bubble").filter({ hasText: "tacos" })).toHaveCount(0);

    // Bob is back: whoever is there hands him the request. He pays; the ecash goes through the hubs to Alice.
    bob.page = await bob.context.newPage();
    await bob.page.goto(bobUrl);
    await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 60_000 });
    await pay(bob, "tacos");
    for (const p of [alice, bob]) await expect(timeline(p).getByTestId("payment-bubble").filter({ hasText: "tacos" }).filter({ hasText: /request/i }).getByTestId("payment-state")).toHaveText(/Paid/, { timeout: 180_000 });
    await expect(carolSees).toHaveAttribute("data-state", "paid", { timeout: 120_000 });
    await expect(carolSees.getByTestId("group-pay-note-state")).toHaveText("Paid");

    // Alice asks the whole group. Carol pays; Bob sees it paid by Carol and cannot pay it any more.
    await request(alice, "group", 10, "tip jar");
    for (const p of [bob, carol]) await expect(timeline(p).getByTestId("payment-bubble").filter({ hasText: "tip jar" }).getByTestId("payment-pay")).toBeVisible({ timeout: 180_000 });
    await expect(timeline(bob).getByTestId("group-pay-caption").filter({ hasText: "Alice asked the group" })).toContainText("Waiting for payment", { timeout: 120_000 });
    await pay(carol, "tip jar");
    for (const p of [alice, bob, carol]) {
      await expect(timeline(p).getByTestId("group-pay-caption").filter({ hasText: "asked the group" })).toContainText(p === carol ? "Paid by you" : "Paid by Carol", { timeout: 180_000 });
      await expect(timeline(p).getByTestId("payment-bubble").filter({ hasText: "tip jar" }).first().getByTestId("payment-state")).toHaveText(/Paid|Received/);
    }
    await expect(timeline(bob).getByTestId("payment-bubble").filter({ hasText: "tip jar" }).getByTestId("payment-pay")).toHaveCount(0);

    // The money moved only once: Alice got 21 + 10, Carol paid 10 (and fees), Bob 21.
    await openWallet(alice, "cashu-testnet");
    await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^31\s*test sats/, { timeout: 60_000 });
    await openWallet(bob, "cashu-testnet");
    await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^9,97[5-9]\s*test sats/);
    await openWallet(carol, "cashu-testnet");
    await expect(carol.page.getByTestId("wallet-balance")).toHaveText(/^9,98[5-9]\s*test sats/);
  });
});
