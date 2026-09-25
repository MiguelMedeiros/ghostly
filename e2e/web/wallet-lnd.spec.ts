import { decodeBolt11 } from "@ghostly/core";
import { balance, credentials, invoice, lookupInvoice, settled } from "../support/lnd-regtest/regtest.mjs";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { choose } from "../support/select";
import { composerRow } from "../support/composer";
import { chatPayments } from "../support/payments";

/**
 * The LND provider against real nodes: GHOSTLY_LND_REGTEST=1 with e2e/infra up (npm run e2e:infra:up) and this
 * build served on E2E_WEB_PORT (47100), the origin the nodes allow (restcors). Alice's app
 * uses Alice's node and Bob's app Bob's, each over the node's REST API from the page, with a macaroon scoped to
 * invoices and off-chain payments. Worthless regtest sats; no macaroon is ever printed.
 *
 * LND's certificate is self-signed: the contexts trust it the way a browser trusts a node set up with a real
 * one (a reverse proxy, `letsencryptdomain`). Everything else is what a person does: the form, the card, the chat.
 */
test.skip(process.env.GHOSTLY_LND_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_LND_REGTEST=1");
test.describe.configure({ mode: "serial" });

async function useNode(p: Peer, node: "alice" | "bob") {
  const { url, macaroon, cert } = credentials(node);
  await openWallet(p, "lightning");
  const source = p.page.getByTestId("lightning-source");
  await choose(source.getByTestId("lightning-source-select"), "lnd");
  const form = source.getByTestId("provider-form-lnd");
  await form.getByLabel("REST address").fill(url);
  await form.getByLabel("Macaroon (hex)").fill(macaroon);
  await form.getByLabel("TLS certificate").fill(cert);
  await form.getByTestId("provider-save").click();
  await expect(source.getByTestId("lightning-source-saved")).toBeVisible({ timeout: 30_000 });
  await expect(source.getByTestId("lightning-source-status")).toContainText(`ghostly-${node}`);
  await expect(source.getByTestId("lightning-source-status")).toContainText("regtest");
  // The credentials are sealed in the engine, never back in the page.
  expect(await p.page.content()).not.toContain(macaroon);
}

/** The node's channel balance once no HTLC is left on it, after the Lightning card shows the same. */
async function cardBalance(p: Peer, node: "alice" | "bob") {
  await expect.poll(() => settled(node), { timeout: 30_000 }).toBe(true);
  await openWallet(p, "lightning");
  const shown = p.page.getByTestId("wallet-balance");
  await expect.poll(async () => Number(/[\d,]+/.exec(await shown.innerText())?.[0].replace(/,/g, "")), { timeout: 30_000 }).toBe(balance(node));
  return balance(node);
}

async function payFromCard(p: Peer, request: string, sats: number) {
  await openWallet(p, "lightning");
  await p.page.getByTestId("wallet-send").click();
  await p.page.getByTestId("wallet-pay-input").fill(request);
  await p.page.getByRole("button", { name: `Pay ${sats.toLocaleString()} sats` }).click();
  await p.page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(p.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
}

test("LND: a node per person, invoices in and out through the card, a chat request paid, balances on both nodes", { tag: ["@gated", "@feature:wallet.lightning.lnd.connect", "@feature:wallet.lightning.lnd.pay", "@feature:payments.lightning.request"] }, async ({ peer }) => {
  test.setTimeout(240_000);
  const [alice, bob] = await Promise.all([peer("lnd-alice", { ignoreHTTPSErrors: true }), peer("lnd-bob", { ignoreHTTPSErrors: true })]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await useTestnet(p);
  await useNode(alice, "alice");
  await useNode(bob, "bob");
  await expect(alice.page.getByTestId("wallet-card-lightning")).toContainText("ghostly-alice");
  let [a, b] = [await cardBalance(alice, "alice"), await cardBalance(bob, "bob")];

  // In: Alice's card asks her node for an invoice; Bob's app pays it through his node.
  await openWallet(alice, "lightning");
  await alice.page.getByTestId("wallet-receive").click();
  await alice.page.getByTestId("wallet-receive-amount").fill("1000");
  await alice.page.getByTestId("wallet-create-invoice").click();
  const aliceInvoice = (await alice.page.getByTestId("wallet-invoice").innerText()).trim();
  expect(aliceInvoice).toMatch(/^lnbcrt10u1/);
  await payFromCard(bob, aliceInvoice, 1000);
  await expect(alice.page.getByTestId("wallet-paid")).toContainText("1,000 sats received", { timeout: 30_000 });
  expect(await cardBalance(alice, "alice")).toBe(a + 1000);
  const bobAfter = await cardBalance(bob, "bob");
  expect(b - bobAfter, "1,000 out and a fee within the cap").toBeGreaterThanOrEqual(1000);
  expect(b - bobAfter).toBeLessThanOrEqual(1030);
  [a, b] = [a + 1000, bobAfter];

  // Out: Alice's app pays an invoice of Bob's node (made outside Ghostly) through hers.
  const bobInvoice = invoice("bob", 500, "from the node");
  await payFromCard(alice, bobInvoice, 500);
  expect(await cardBalance(bob, "bob")).toBe(b + 500);
  const aliceAfter = await cardBalance(alice, "alice");
  expect(a - aliceAfter).toBeGreaterThanOrEqual(500);
  [a, b] = [aliceAfter, b + 500];

  // A chat request: Bob asks over Lightning, the invoice comes from his node; Alice pays it from the bubble.
  for (const p of [alice, bob]) await openChat(p);
  // Lightning only in this chat for Bob, so the request is paid over Lightning and not as ecash.
  await chatPayments(bob.page, { cashu: false });
  await (await composerRow(bob.page, "payment-button")).click();
  await bob.page.getByTestId("payment-card-lightning").click();
  await bob.page.getByTestId("payment-amount").fill("2100");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  const review = request.getByTestId("payment-review");
  await expect(review).toContainText("Pay 2,100 test sats over Lightning");
  await expect(review).toContainText("Through ghostly-alice");
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  expect(await cardBalance(bob, "bob")).toBe(b + 2100);
  const aliceEnd = await cardBalance(alice, "alice");
  expect(a - aliceEnd).toBeGreaterThanOrEqual(2100);
  expect(a - aliceEnd).toBeLessThanOrEqual(2100 + 63);

  // The journal says so, and Alice's node agrees the invoice her card made was settled.
  await openWallet(bob, "lightning");
  await expect(bob.page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("paid");
  expect(lookupInvoice("alice", decodeBolt11(aliceInvoice)!.paymentHash!).state).toBe("SETTLED");
  console.log(`  LND regtest: Alice ${aliceEnd} sats, Bob ${await cardBalance(bob, "bob")} sats after 1000 in, 500 out and a 2100 request`);
});
