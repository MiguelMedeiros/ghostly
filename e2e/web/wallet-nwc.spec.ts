import { FakeNwcWallet, TestRelay } from "../../packages/browser/test/helpers/fakeNwc";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { choose } from "../support/select";
import { composerRow } from "../support/composer";
import { chatPayments } from "../support/payments";

/**
 * Lightning through Nostr Wallet Connect: the person pastes a wallet's `nostr+walletconnect://` URI as the
 * Lightning source of the Testnet mode, and invoices are made and paid by that wallet over its relay.
 *  - Always: a fake NWC wallet service on a relay in this test process (regtest sats in memory, no network).
 *  - GHOSTLY_NWC_REGTEST=1: two Alby Hubs on two regtest LND nodes with a channel (e2e/infra, e2e/support/nwc-regtest):
 *    each person connects their own, and a request in the chat is paid over real Lightning.
 */

async function useNwc(p: Peer, uri: string) {
  await openWallet(p, "lightning");
  const source = p.page.getByTestId("lightning-source");
  await choose(source.getByTestId("lightning-source-select"), "nwc");
  await expect(source.getByTestId("lightning-source-config")).toContainText("custodial or not depends on the wallet");
  await source.getByTestId("provider-form-nwc").getByLabel("Connection URI").fill(uri);
  await source.getByTestId("provider-save").click();
  await expect(source.getByTestId("lightning-source-saved")).toBeVisible({ timeout: 30_000 });
  await expect(source.getByTestId("lightning-source-current")).toContainText("Nostr Wallet Connect");
  await expect(source.getByTestId("lightning-source-status")).toContainText(/Connected · .* via 127\.0\.0\.1:\d+ · regtest/);
  // The URI holds a spending key: sealed in the engine, never back in the page.
  expect(await p.page.content()).not.toContain(new URLSearchParams(uri.split("?")[1]).get("secret")!);
}

/** The balance the Lightning card shows for its source, in sats. */
async function lightningBalance(p: Peer): Promise<number> {
  await openWallet(p, "lightning");
  const shown = p.page.getByTestId("wallet-balance");
  // Once the wallet has answered: before that the card has no number, and a NaN compares with nothing.
  await expect(shown).toHaveText(/^\s*[\d,]+/, { timeout: 60_000 });
  const text = await shown.innerText();
  // "576,410 test sats · <source>": the leading number only.
  return Number(text.trim().match(/^[\d,]+/)?.[0].replaceAll(",", "") ?? NaN);
}

test.describe("NWC with a fake wallet service", () => {
  let relay: TestRelay;
  test.beforeAll(async () => { relay = await TestRelay.start(); });
  test.afterAll(async () => { await relay.close(); });

  test("a wallet connected by its URI receives and pays through its relay", { tag: ["@feature:wallet.lightning.nwc.connect", "@feature:wallet.lightning.nwc.pay"] }, async ({ peer }) => {
    const [mine, other] = [await FakeNwcWallet.start(relay.url, { alias: "Fake hub", balance: 5_000 }), await FakeNwcWallet.start(relay.url)];
    try {
      const alice = await peer("nwc-fake");
      await useTestnet(alice);
      await useNwc(alice, mine.uri());
      const page = alice.page;
      await expect(page.getByTestId("wallet-card-lightning")).toContainText("Via Fake hub");
      await expect(page.getByTestId("wallet-balance")).toContainText("5,000");

      // In: the invoice is the wallet's; the wallet sees it paid, and so does the app.
      await page.getByTestId("wallet-receive").click();
      await page.getByTestId("wallet-receive-amount").fill("12");
      await page.getByTestId("wallet-create-invoice").click();
      const invoice = (await page.getByTestId("wallet-invoice").innerText()).trim();
      expect(invoice).toMatch(/^lnbcrt/);
      const hash = [...mine.incoming.values()].find((i) => i.invoice === invoice)!.paymentHash;
      mine.markPaid(hash);
      await expect(page.getByTestId("wallet-paid")).toContainText("12 sats received", { timeout: 30_000 });

      // Out: someone else's invoice, paid by the wallet.
      const bill = other.makeInvoice(30, "fake bill");
      await page.getByTestId("wallet-send").click();
      await page.getByTestId("wallet-pay-input").fill(bill.invoice);
      await page.getByRole("button", { name: "Pay 30 sats" }).click();
      await page.getByRole("button", { name: "Pay", exact: true }).click();
      await expect(page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 30_000 });
      expect(other.balance).toBe(100_030);
      expect(mine.balance).toBe(5_000 + 12 - 30);
      await expect(page.getByTestId("wallet-balance")).toContainText("4,982", { timeout: 30_000 });
      expect(mine.requests.every((r) => r.encryption === "nip44_v2")).toBe(true);
    } finally { await mine.close(); await other.close(); }
  });

  test("a URI that is not one, or a wallet on real Bitcoin, is refused before anything is saved", { tag: ["@feature:wallet.lightning.nwc.connect"] }, async ({ peer }) => {
    const mainnet = await FakeNwcWallet.start(relay.url, { network: "mainnet" });
    try {
      const alice = await peer("nwc-refused");
      await useTestnet(alice);
      await openWallet(alice, "lightning");
      const source = alice.page.getByTestId("lightning-source");
      await choose(source.getByTestId("lightning-source-select"), "nwc");
      const form = source.getByTestId("provider-form-nwc");
      await form.getByLabel("Connection URI").fill("lnbc1notauri");
      await source.getByTestId("provider-save").click();
      await expect(source.getByTestId("lightning-source-error")).toContainText("not a Nostr Wallet Connect URI");
      await form.getByLabel("Connection URI").fill(mainnet.uri());
      await source.getByTestId("provider-save").click();
      await expect(source.getByTestId("lightning-source-error")).toContainText("real money", { timeout: 30_000 });
      await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
    } finally { await mainnet.close(); }
  });
});

test.describe("NWC on regtest Lightning", () => {
  test.skip(process.env.GHOSTLY_NWC_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_NWC_REGTEST=1");
  test.describe.configure({ timeout: 180_000 });

  test("two people on their own NWC wallets: a request in the chat is paid over the channel", { tag: ["@gated", "@feature:wallet.lightning.nwc.connect", "@feature:wallet.lightning.nwc.pay", "@feature:payments.lightning.request"] }, async ({ peer }) => {
    const regtest = await import("../support/nwc-regtest/regtest.mjs");
    await regtest.ready();
    const [aliceUri, bobUri] = [await regtest.nwcUri("alice", { fresh: true }), await regtest.nwcUri("bob", { fresh: true })];

    const [alice, bob] = await Promise.all([peer("nwc-alice"), peer("nwc-bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const [p, uri] of [[alice, aliceUri], [bob, bobUri]] as const) { await useTestnet(p); await useNwc(p, uri); }
    const before = { alice: await lightningBalance(alice), bob: await lightningBalance(bob), channel: regtest.balances() };

    // Bob asks over Lightning only (Cashu off in this chat): the invoice in the request is his own wallet's.
    await openChat(bob);
    await chatPayments(bob.page, { cashu: false });
    await (await composerRow(bob.page, "payment-button")).click();
    await bob.page.getByTestId("payment-card-lightning").click();
    await bob.page.getByTestId("payment-amount").fill("2100");
    await bob.page.getByTestId("payment-request").click();

    // Alice pays it from hers, after reviewing it.
    await openChat(alice);
    const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
    await expect(request).toContainText("2,100");
    await request.getByTestId("payment-pay").click();
    // Reviewed as a Lightning payment through her own NWC wallet, then approved.
    const review = request.getByTestId("payment-review");
    await expect(review).toContainText("Pay 2,100 test sats over Lightning");
    const relay = new URL(regtest.NWC_REGTEST.relay).host.replace(/\./g, "\\.");
    await expect(review).toContainText(new RegExp(`Through .* via ${relay}`));
    await review.getByRole("button", { name: "Approve payment" }).click();
    await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
    // Bob's app sees it paid through his own wallet, not on Alice's word.
    await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });

    const after = regtest.balances();
    expect(after.alice.local).toBe(before.channel.alice.local - 2_100);
    expect(after.bob.local).toBe(before.channel.bob.local + 2_100);
    await expect.poll(() => lightningBalance(alice), { timeout: 60_000 }).toBe(before.alice - 2_100);
    await expect.poll(() => lightningBalance(bob), { timeout: 60_000 }).toBe(before.bob + 2_100);
    console.log(`NWC regtest e2e: alice paid bob's 2100-sat chat request; app balances alice ${before.alice} → ${before.alice - 2_100}, bob ${before.bob} → ${before.bob + 2_100}; channel alice ${before.channel.alice.local} → ${after.alice.local}, bob ${before.channel.bob.local} → ${after.bob.local}`);
  });
});
