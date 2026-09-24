import type { Page } from "@playwright/test";
import { chat, connect, expect, link, openChat, openWallet, say, test, type Peer } from "../support/fixtures";
import { mintEndpoint } from "../support/mint";

/**
 * Payments in a chat beyond the happy path: memos, a payment the contact refuses, ecash that was
 * never picked up, and a Lightning invoice pasted as text. Everything runs against a local mint
 * (`cashubtc/mintd` with its fake Lightning backend: worthless sats, invoices that pay themselves),
 * so these tests run only when `E2E_MINT_URL` points at one on this machine. See e2e/README.md.
 */
const local = () => process.env.E2E_MINT_URL?.startsWith("http://127.0.0.1:") ?? false;

test.beforeEach(() => {
  test.skip(!local(), "Requires an explicitly local fake mint (E2E_MINT_URL=http://127.0.0.1:…)");
});

/** Two people in one chat, connected. */
async function chatting(peer: (name: string) => Promise<Peer>, a: string, b: string): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer(a), peer(b)]);
  await link(alice, bob);
  await connect(alice, bob);
  return [alice, bob];
}

async function testMint(p: Peer): Promise<void> {
  await openWallet(p, "cashu");
  await p.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await expect(p.page.getByTestId("wallet-balance")).toBeVisible();
}

/** Fills the wallet over Lightning at its primary mint; the local mint pays its own invoices. */
async function fund(p: Peer, sats: number): Promise<void> {
  await openWallet(p, "cashu");
  await p.page.getByTestId("wallet-receive").click();
  await p.page.getByTestId("wallet-receive-amount").fill(String(sats));
  await p.page.getByTestId("wallet-create-invoice").click();
  await expect(p.page.getByTestId("wallet-paid")).toBeVisible();
}

const balanceOf = async (page: Page, testId: "wallet-test-balance" | "wallet-balance") =>
  Number(((await page.getByTestId(testId).textContent()) ?? "").replace(/,/g, "").match(/(\d+)/)![1]);

/** Opens the composer, fills it and stops at the review. */
async function prepareSend(p: Peer, sats: number, memo?: string) {
  await p.page.getByTestId("payment-button").click();
  await p.page.getByTestId("payment-card-cashu").click();
  const composer = p.page.getByTestId("payment-composer");
  await p.page.getByTestId("payment-amount").fill(String(sats));
  if (memo) await composer.getByPlaceholder("What for? (optional)").fill(memo);
  await p.page.getByTestId("payment-send").click();
  const review = composer.getByTestId("payment-review");
  await expect(review).toBeVisible();
  return review;
}

const bubble = (p: Peer, text: string | RegExp) => chat(p).getByTestId("payment-bubble").filter({ hasText: text });

test("a request's memo shows on both sides, and test-mint payments say test sats", { tag: ["@feature:payments.chat.memo", "@feature:payments.cashu.test-sats", "@feature:payments.cashu.send", "@feature:payments.chat.review"] }, async ({ peer }) => {
  const [alice, bob] = await chatting(peer, "memo-alice", "memo-bob");
  for (const p of [alice, bob]) await testMint(p);
  await fund(alice, 100);
  for (const p of [alice, bob]) await openChat(p);

  // A request with a memo: both bubbles carry it, in test sats.
  await bob.page.getByTestId("payment-button").click();
  await bob.page.getByTestId("payment-card-cashu").click();
  await bob.page.getByTestId("payment-amount").fill("12");
  await bob.page.getByTestId("payment-composer").getByPlaceholder("What for? (optional)").fill("half the pizza");
  await bob.page.getByTestId("payment-request").click();
  for (const p of [alice, bob]) {
    const request = bubble(p, "equest");
    await expect(request).toContainText("half the pizza");
    await expect(request).toContainText(/12\s*test sats/);
    await expect(request).not.toContainText(/\d\s*sats/);
  }

  // A payment: test sats on both sides too, and never shown as plain sats.
  const review = await prepareSend(alice, 21);
  await expect(review).toContainText("cashu-test");
  await review.getByRole("button", { name: "Approve payment" }).click();
  for (const p of [alice, bob]) {
    const sent = bubble(p, /(You sent|Sent you)/);
    await expect(sent.getByTestId("payment-state")).toHaveText(/Received/);
    await expect(sent).toContainText(/21\s*test sats/);
  }
  await expect(bubble(alice, "You sent")).toContainText("Cashu · cashu-test");
  await expect(bubble(alice, "You sent")).toHaveCount(1);
  await expect(bubble(bob, "Sent you")).toHaveCount(1);
});

// The composer's "What for?" goes with a direct send: it is kept on the review and sent with the ecash.
test("a sent payment's memo shows in both bubbles", { tag: ["@feature:payments.chat.memo", "@feature:payments.cashu.send"] }, async ({ peer }) => {
  const [alice, bob] = await chatting(peer, "send-memo-alice", "send-memo-bob");
  for (const p of [alice, bob]) await testMint(p);
  await fund(alice, 100);
  for (const p of [alice, bob]) await openChat(p);
  const review = await prepareSend(alice, 21, "for the tickets");
  await review.getByRole("button", { name: "Approve payment" }).click();
  for (const p of [alice, bob]) {
    const sent = bubble(p, /(You sent|Sent you)/);
    await expect(sent.getByTestId("payment-state")).toHaveText(/Received/);
    await expect(sent).toContainText("for the tickets");
    await expect(sent).toContainText(/21\s*test sats/);
  }
});

test("a payment the contact refuses comes back, and is never shown as paid", { tag: ["@feature:payments.chat.refused", "@feature:wallet.cashu.mint.add", "@feature:wallet.cashu.mint.manage", "@feature:wallet.history"] }, async ({ peer }) => {
  const [alice, bob] = await chatting(peer, "refused-alice", "refused-bob");
  // Both are in Testnet, where Bob's test mint is the public one. Alice keeps her test sats at a mint
  // Bob has not chosen: the local mint under its own address (a mint on this machine belongs to Testnet
  // too, and is never added by itself). Bob's wallet only takes ecash from mints he picked, and refuses.
  for (const p of [alice, bob]) await testMint(p);
  const own = mintEndpoint();
  await alice.page.getByTestId("wallet-mint-url").fill(own);
  await alice.page.getByTestId("wallet-add-mint").click();
  const row = alice.page.getByTestId("mint-row").filter({ hasText: own.replace(/^https?:\/\//, "") });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Make primary" }).click();
  await expect(alice.page.getByTestId("mint-row").first()).toContainText(own.replace(/^https?:\/\//, ""));
  await fund(alice, 60);
  await expect.poll(() => balanceOf(alice.page, "wallet-test-balance")).toBe(60);
  for (const p of [alice, bob]) await openChat(p);

  const review = await prepareSend(alice, 21);
  await review.getByRole("button", { name: "Approve payment" }).click();

  // Bob's side says why, once, and has no payment.
  await expect(chat(bob).getByText(/Could not receive 21 sats: Ecash from 127\.0\.0\.1 is not accepted/)).toBeVisible();
  await expect(chat(bob).getByTestId("payment-bubble")).toHaveCount(0);
  // Alice's payment comes back to her: taken back, with the reason, and the review closed as failed.
  const sent = bubble(alice, "You sent");
  await expect(sent.getByTestId("payment-state")).toHaveText(/^Taken back · .*not accepted/);
  await expect(sent).toHaveAttribute("data-state", "reclaimed");
  await expect(review.getByTestId("review-status")).toHaveText("failed");
  await expect(review).toContainText(/Refused: .*The sats came back\./);
  await expect(review.getByRole("button", { name: "Approve payment" })).toHaveCount(0);
  // Nothing left to take back.
  await expect(sent.getByRole("button", { name: "Take it back" })).toHaveCount(0);
  await review.getByRole("button", { name: "Close", exact: true }).click();

  // Still never "Received" or "Paid", even after a reload.
  await alice.page.reload();
  await expect(sent.getByTestId("payment-state")).toHaveText(/^Taken back/);
  await expect(sent.getByTestId("payment-state")).not.toHaveText(/Received|Paid/);
  await say(bob, "no worries");
  await expect(chat(alice).getByText("no worries")).toBeVisible();

  // The sats are Alice's again, less the mint's fee for swapping them twice.
  await openWallet(alice, "cashu");
  await expect.poll(() => balanceOf(alice.page, "wallet-test-balance")).toBeGreaterThanOrEqual(56);
  expect(await balanceOf(alice.page, "wallet-test-balance")).toBeLessThan(60);
  await alice.page.getByTestId("wallet-history").click();
  await expect(alice.page.getByTestId("wallet-tx").filter({ hasText: "Took a payment back" })).toHaveCount(1);
  await expect(alice.page.getByTestId("wallet-tx").filter({ hasText: "Sent ecash" })).toHaveCount(1);
});

test("a contact who turns Cashu off stops a reviewed payment before anything is spent", { tag: ["@feature:payments.chat.method-off", "@feature:payments.chat.review"] }, async ({ peer }) => {
  const [alice, bob] = await chatting(peer, "off-alice", "off-bob");
  for (const p of [alice, bob]) await testMint(p);
  await fund(alice, 50);
  await expect.poll(() => balanceOf(alice.page, "wallet-test-balance")).toBe(50);
  await openChat(alice);
  await openChat(bob);
  const review = await prepareSend(alice, 21);

  // Bob turns Cashu off for this chat while Alice looks at the review.
  await bob.page.getByTitle("Options").click();
  await bob.page.getByTestId("chat-payments-open").click();
  await bob.page.getByTestId("chat-payments").getByTestId("chat-payments-cashu").click();
  await bob.page.getByTestId("chat-payments-save").click();
  await expect(bob.page.getByTestId("chat-payments")).toHaveCount(0);

  // Alice's app learns it on the open session; approving is refused and nothing leaves.
  await expect(async () => {
    await review.getByRole("button", { name: "Approve payment" }).click({ timeout: 5000 });
    await expect(review).toContainText("Cashu is off in this chat", { timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await expect(review.getByTestId("review-status")).toHaveText("pending");
  await expect(chat(alice).getByTestId("payment-bubble")).toHaveCount(0);
  await expect(chat(bob).getByTestId("payment-bubble")).toHaveCount(0);
  await review.getByRole("button", { name: "Cancel" }).click();
  await openWallet(alice, "cashu");
  await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^50\s*sats/);
});

// Every send from the chat is reviewed; ecash the contact never picks up can still be taken back.
test("ecash the contact never picks up can be taken back", { tag: ["@feature:payments.cashu.reclaim"] }, async ({ peer }) => {
  const [alice, bob] = await chatting(peer, "unredeemed-alice", "unredeemed-bob");
  for (const p of [alice, bob]) await testMint(p);
  await fund(alice, 50);
  await expect.poll(() => balanceOf(alice.page, "wallet-test-balance")).toBe(50);
  for (const p of [alice, bob]) await openChat(p);
  // Bob's wallet cannot reach the mint to redeem: the token stays unspent, and Alice's payment waits.
  await bob.context.route(/^https:\/\/testnut\.cashu\.space\/v1\/swap/, () => new Promise<void>(() => {}));

  const review = await prepareSend(alice, 21);
  await review.getByRole("button", { name: "Approve payment" }).click();
  const sent = bubble(alice, "You sent");
  await expect(sent.getByTestId("payment-state")).toHaveText(/Waiting for your contact/);
  await review.getByRole("button", { name: "Close", exact: true }).click().catch(() => {});
  await sent.getByRole("button", { name: "Take it back" }).click();
  await expect(sent.getByTestId("payment-state")).toHaveText(/^Taken back/);
  await openWallet(alice, "cashu");
  await expect.poll(() => balanceOf(alice.page, "wallet-test-balance")).toBeGreaterThanOrEqual(47);
});

test("a Lightning invoice pasted into the chat is a card with a QR code to hide and a Copy button", { tag: ["@feature:payments.lightning.invoice-card"] }, async ({ peer }) => {
  const [alice, bob] = await chatting(peer, "invoice-alice", "invoice-bob");
  // An invoice from the mint, made outside Ghostly and pasted as text.
  const { Wallet } = await import("@cashu/cashu-ts");
  const outside = new Wallet(mintEndpoint(), { unit: "sat" });
  await outside.loadMint();
  const invoice = (await outside.createMintQuoteBolt11(13)).request;
  expect(invoice).toMatch(/^lnbc/);
  await say(bob, `lunch? ${invoice}`);

  for (const [p, mine] of [[alice, false], [bob, true]] as const) {
    const card = chat(p).getByTestId("invoice-bubble").last();
    await expect(card.getByTestId("money-amount")).toHaveText("13");
    await expect(card).toContainText("Lightning invoice");
    await expect(card).toContainText(/Expires in/);
    await expect(chat(p).getByText("lunch?", { exact: true })).toBeVisible();
    await expect(card.getByTestId("invoice-pay"), mine ? "nobody pays their own invoice" : "the contact can pay it").toHaveCount(mine ? 0 : 1);

    // The QR code hides on a tap and comes back with "QR".
    const qr = card.getByTitle("Hide the QR code");
    await expect(qr.locator("svg")).toBeVisible();
    await expect(card.getByRole("button", { name: "QR", exact: true })).toHaveCount(0);
    await qr.click();
    await expect(qr).toHaveCount(0);
    await card.getByRole("button", { name: "QR", exact: true }).click();
    await expect(card.getByTitle("Hide the QR code").locator("svg")).toBeVisible();
    await expect(card.getByRole("button", { name: "QR", exact: true })).toHaveCount(0);

    // Copy puts the invoice itself on the clipboard (a page-local one: never this machine's).
    await p.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
    });
    await card.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(card.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await p.page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(invoice);
    await expect(card.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Open wallet" })).toHaveAttribute("href", `lightning:${invoice}`);
  }
});
