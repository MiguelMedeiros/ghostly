import { decodeBolt11 } from "@ghostly/core";
import { FakeWebln, FakeWeblnLedger } from "../../packages/browser/test/helpers/fakeWebln";
import { lndWebln } from "../../packages/browser/test/helpers/lndWebln";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { connectWebln, installWebln } from "../support/webln";
import { choose, optionsOf } from "../support/select";

/**
 * Lightning through a browser wallet (WebLN, like Alby): the test puts `window.webln` in the page, backed
 * by a wallet in the test process. Without GHOSTLY_WEBLN_REGTEST that wallet is an in-memory fake (regtest
 * invoices, no network); with it, a real regtest LND node per person (e2e/support/webln-regtest).
 */

const lightningCard = async (p: Peer) => { await openWallet(p, "lightning"); return p.page.getByTestId("lightning-source"); };
const invoiceShown = async (p: Peer) => (await p.page.getByTestId("wallet-invoice").innerText()).trim();

async function receive(p: Peer, sats: number) {
  await p.page.getByTestId("wallet-receive").click();
  await p.page.getByTestId("wallet-receive-amount").fill(String(sats));
  await p.page.getByTestId("wallet-create-invoice").click();
  await expect(p.page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbcrt/);
  return invoiceShown(p);
}
async function pay(p: Peer, invoice: string, sats: number) {
  await p.page.getByTestId("wallet-send").click();
  await p.page.getByTestId("wallet-pay-input").fill(invoice);
  await p.page.getByRole("button", { name: `Pay ${sats} sats` }).click();
  // Ghostly's own review comes first: the wallet is asked only once it is approved.
  await p.page.getByRole("button", { name: "Pay", exact: true }).click();
}

/**
 * Bob requests over Lightning only (Cashu off in the chat, so the request carries just his wallet's
 * invoice); Alice reviews it in the bubble and pays it through her source. Both bubbles end up Paid.
 */
async function requestPaidInChat(alice: Peer, bob: Peer, sats: number, aliceSource: string) {
  await openChat(bob);
  await bob.page.getByTitle("Options").click();
  await bob.page.getByTestId("chat-payments-open").click();
  await bob.page.getByTestId("chat-payments").getByTestId("chat-payments-cashu").click();
  await bob.page.getByTestId("chat-payments-save").click();
  await bob.page.getByTestId("payment-button").click();
  await bob.page.getByTestId("payment-card-lightning").click();
  await bob.page.getByTestId("payment-amount").fill(String(sats));
  await bob.page.getByTestId("payment-request").click();
  await openChat(alice);
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await expect(request).toContainText(`${sats} test sats`);
  await request.getByTestId("payment-pay").click();
  // Reviewed in Ghostly (amount, source, fee ceiling) before Alice's wallet is asked.
  const review = request.getByTestId("payment-review");
  await expect(review).toContainText(`Pay ${sats} test sats over Lightning`);
  await expect(review).toContainText(`Through ${aliceSource} · fee up to 10 sats`);
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  // Bob's app sees it paid from his own wallet's answer, not from Alice's word.
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
}

test("the browser wallet is offered on the web, and says when there is none or it refuses", { tag: ["@feature:wallet.lightning.webln.connect"] }, async ({ peer }) => {
  const alice = await peer("webln-missing");
  const source = await lightningCard(alice);
  await expect((await optionsOf(source.getByTestId("lightning-source-select"))).filter({ hasText: "Browser wallet (WebLN)" })).toHaveCount(1);
  await choose(source.getByTestId("lightning-source-select"), "webln");
  await expect(source.getByTestId("webln-missing")).toBeVisible();
  await source.getByRole("button", { name: "Connect browser wallet" }).click();
  await expect(source.getByTestId("lightning-source-error")).toContainText("No WebLN wallet in this browser");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");

  await installWebln(alice, new FakeWebln(undefined, { refuseEnable: true }));
  await lightningCard(alice);
  await choose(source.getByTestId("lightning-source-select"), "webln");
  await expect(source.getByTestId("webln-found")).toBeVisible();
  await source.getByRole("button", { name: "Connect browser wallet" }).click();
  await expect(source.getByTestId("lightning-source-error")).toContainText("refused the connection");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Cashu mints");
});

test("a browser wallet as the Lightning source: invoices, payments reviewed first, and a refused prompt spends nothing", { tag: ["@feature:wallet.lightning.webln.pay"] }, async ({ peer }) => {
  const alice = await peer("webln-fake");
  const ledger = new FakeWeblnLedger();
  const wallet = new FakeWebln(ledger, { alias: "Alice's Alby" }), stranger = new FakeWebln(ledger);
  await stranger.enable();
  await installWebln(alice, wallet);
  await useTestnet(alice);
  const source = await lightningCard(alice);
  await connectWebln(alice);
  await expect(source.getByTestId("lightning-source-status")).toContainText("Alice's Alby · regtest");
  const page = alice.page;
  await expect(page.getByTestId("wallet-card-lightning")).toContainText("Via Alice's Alby");
  await expect(page.getByTestId("wallet-balance")).toContainText("100,000");

  // In: the wallet's own invoice, seen paid by asking the wallet.
  const invoice = await receive(alice, 12);
  wallet.receive(decodeBolt11(invoice)!.paymentHash!);
  await expect(page.getByTestId("wallet-paid")).toContainText("12 sats received", { timeout: 30_000 });

  // Out: reviewed in Ghostly, then paid by the wallet.
  await pay(alice, (await stranger.makeInvoice({ amount: 30 })).paymentRequest, 30);
  await expect(page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 30_000 });
  expect(stranger.balance).toBe(100_030);

  // The person turns the wallet's own prompt down: nothing left, and it can be tried again.
  wallet.send = "reject";
  await pay(alice, (await stranger.makeInvoice({ amount: 5 })).paymentRequest, 5);
  await expect(page.getByTestId("wallet-error")).toContainText("User rejected");
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("failed");
  expect(stranger.balance).toBe(100_030);
});

test("a chat request paid between two browser wallets: Lightning only, reviewed in the bubble", { tag: ["@feature:wallet.lightning.webln.pay", "@feature:payments.lightning.request"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("webln-chat-alice"), peer("webln-chat-bob")]);
  const ledger = new FakeWeblnLedger();
  const aliceWallet = new FakeWebln(ledger, { alias: "Alice's wallet" }), bobWallet = new FakeWebln(ledger, { alias: "Bob's wallet" });
  await installWebln(alice, aliceWallet);
  await installWebln(bob, bobWallet);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) { await useTestnet(p); await lightningCard(p); await connectWebln(p); }
  await requestPaidInChat(alice, bob, 40, "Alice's wallet");
  expect([aliceWallet.balance, bobWallet.balance]).toEqual([99_960, 100_040]);
});

test.describe("on a regtest Lightning network", () => {
  test.skip(process.env.GHOSTLY_WEBLN_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_WEBLN_REGTEST=1");
  test.describe.configure({ timeout: 240_000 });

  test("each person's browser wallet in front of their own node: pay, receive, and a request paid in the chat", { tag: ["@gated", "@feature:wallet.lightning.webln.pay", "@feature:payments.lightning.request"] }, async ({ peer }) => {
    const [alice, bob] = await Promise.all([peer("webln-alice"), peer("webln-bob")]);
    const aliceNode = lndWebln("alice"), bobNode = lndWebln("bob");
    const balances = async () => ({ alice: await aliceNode.lnd.channelBalance(), bob: await bobNode.lnd.channelBalance() });
    const start = await balances();
    console.log(`  regtest channel balances before: ${JSON.stringify(start)}`);
    await installWebln(alice, aliceNode);
    await installWebln(bob, bobNode);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) {
      await useTestnet(p);
      await lightningCard(p);
      await connectWebln(p);
      await expect(p.page.getByTestId("lightning-source-status")).toContainText(`ghostly-webln-${p === alice ? "alice" : "bob"} · regtest`);
    }
    const shown = (p: Peer, sats: number) => expect(p.page.getByTestId("wallet-balance")).toContainText(sats.toLocaleString("en-US"), { timeout: 45_000 });
    await shown(alice, start.alice);
    await shown(bob, start.bob);

    // Alice receives: Bob's node pays her wallet's invoice, from outside any browser.
    const invoice = await receive(alice, 1_000);
    await bobNode.lnd.pay(invoice);
    await expect(alice.page.getByTestId("wallet-paid")).toContainText("1,000 sats received", { timeout: 30_000 });

    // Alice pays an invoice of Bob's node from the Lightning card.
    await pay(alice, await bobNode.lnd.invoice(400, "from the card"), 400);
    await expect(alice.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });

    // A request in the chat: Bob asks with an invoice from his wallet, Alice pays it through hers.
    await requestPaidInChat(alice, bob, 250, "ghostly-webln-alice");

    // Both nodes moved exactly that (a direct channel: no routing fee), and both apps show it.
    const expected = { alice: start.alice + 1_000 - 400 - 250, bob: start.bob - 1_000 + 400 + 250 };
    await expect.poll(balances, { timeout: 15_000 }).toEqual(expected);
    const end = await balances();
    console.log(`  regtest channel balances after: ${JSON.stringify(end)}`);
    await lightningCard(alice);
    await shown(alice, end.alice);
    await lightningCard(bob);
    await shown(bob, end.bob);
  });
});
