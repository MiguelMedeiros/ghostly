import { chat, connect, createWallet, expect, lightningCard, link, openChat, openWallet, test, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";

/**
 * Two Lightning cards on one network, on real regtest nodes: Alice's LND node (the LND suite's) and her Alby Hub
 * (the NWC suite's), each added with New. She pays from each card an invoice of that suite's other node; then makes
 * the hub's card her default for receiving, and a chat request of hers carries that card's invoice, which Bob pays
 * from his own hub. Worthless regtest sats; no macaroon or NWC secret is ever printed.
 *
 * GHOSTLY_LND_REGTEST=1 and GHOSTLY_NWC_REGTEST=1, with e2e/infra up (or `e2e:infra:use -- --host …`) and this build
 * served on E2E_WEB_PORT (the origin the LND nodes allow).
 */
test.skip(process.env.GHOSTLY_LND_REGTEST !== "1" || process.env.GHOSTLY_NWC_REGTEST !== "1", "Requires e2e/infra with GHOSTLY_LND_REGTEST=1 and GHOSTLY_NWC_REGTEST=1");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const sats = (text: string) => Number(/[\d,]+/.exec(text)?.[0].replace(/,/g, ""));

/** Adds a Lightning card through the LND node's form; the card comes up selected. */
async function addLnd(p: Peer, lnd: typeof import("../support/lnd-regtest/regtest.mjs")) {
  const { url, macaroon, cert } = lnd.credentials("alice");
  await createWallet(p, "lightning", "testnet", { provider: "lnd", timeout: 30_000, fill: async (area) => {
    const form = area.getByTestId("provider-form-lnd");
    await form.getByLabel("REST address").fill(url);
    await form.getByLabel("Macaroon (hex)").fill(macaroon);
    await form.getByLabel("TLS certificate").fill(cert);
    await form.getByTestId("provider-save").click();
  } });
  expect(await p.page.content()).not.toContain(macaroon);
}

/** Adds a Lightning card through an Alby Hub's NWC URI; the card comes up selected. */
async function addNwc(p: Peer, uri: string) {
  await createWallet(p, "lightning", "testnet", { provider: "nwc", timeout: 30_000, fill: async (form) => {
    await form.getByTestId("provider-form-nwc").getByLabel("Connection URI").fill(uri);
    await form.getByTestId("provider-save").click();
  } });
  expect(await p.page.content()).not.toContain(new URLSearchParams(uri.split("?")[1]).get("secret")!);
}

/** Pays `invoice` from the selected card's Send, through Ghostly's own review. */
async function payFromCard(p: Peer, invoice: string, amount: number) {
  await p.page.getByTestId("wallet-send").click();
  await p.page.getByTestId("wallet-pay-input").fill(invoice);
  await p.page.getByRole("button", { name: `Pay ${amount.toLocaleString()} sats` }).click();
  await p.page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(p.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
}

test("two Lightning cards on Testnet: each pays through its own node; the default one receives a chat request", { tag: ["@gated", "@feature:wallet.lightning.cards", "@feature:wallet.lightning.lnd.pay", "@feature:wallet.lightning.nwc.pay", "@feature:payments.lightning.request"] }, async ({ peer }) => {
  const lnd = await import("../support/lnd-regtest/regtest.mjs");
  const nwc = await import("../support/nwc-regtest/regtest.mjs");
  await nwc.ready();
  const [aliceHub, bobHub] = [await nwc.nwcUri("alice", { fresh: true }), await nwc.nwcUri("bob", { fresh: true })];

  const [alice, bob] = await Promise.all([peer("ln-cards-alice", { ignoreHTTPSErrors: true }), peer("ln-cards-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const page = alice.page;

  // Alice: her LND node first (it becomes her default for receiving), then her hub, one more card.
  await addLnd(alice, lnd);
  await expect(page.getByTestId("lightning-source").getByTestId("lightning-source-status")).toContainText("ghostly-alice");
  await addNwc(alice, aliceHub);
  const node = lightningCard(page, "testnet", "(LND)"), hub = lightningCard(page, "testnet", "(NWC)");
  await expect(lightningCard(page, "testnet")).toHaveCount(2);
  await expect(hub).toHaveAttribute("aria-selected", "true");
  await expect(node.getByTestId("wallet-card-tag")).toHaveText("Default");
  await expect(hub.getByTestId("wallet-card-tag")).toHaveCount(0);
  // Bob: his own hub, his one Lightning wallet.
  await addNwc(bob, bobHub);

  // Paying from each card: the node's pays an invoice of the LND suite's other node, the hub's one of the NWC suite's.
  const nodeBefore = lnd.balance("bob");
  await node.click();
  await payFromCard(alice, lnd.invoice("bob", 300, "from Alice's node card"), 300);
  await expect.poll(() => lnd.settled("bob") && lnd.balance("bob"), { timeout: 30_000 }).toBe(nodeBefore + 300);
  const hubBefore = nwc.balances().bob.local;
  await hub.click();
  await payFromCard(alice, nwc.invoice("bob", 200, "from Alice's hub card").invoice, 200);
  await expect.poll(() => nwc.balances().bob.local, { timeout: 30_000 }).toBeGreaterThanOrEqual(hubBefore + 200);
  // Each card's own history.
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("200");
  await node.click();
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("300");

  // The hub's card becomes the default for receiving, from its settings.
  await hub.click();
  await page.getByTestId("lightning-card-default").click();
  await expect(hub.getByTestId("wallet-card-tag")).toHaveText("Default");
  await expect(node.getByTestId("wallet-card-tag")).toHaveCount(0);

  // A chat request starts on the default card: its invoice is the hub's, and Bob's hub pays it over the NWC suite's channel.
  for (const p of [alice, bob]) await openChat(p);
  await (await composerRow(page, "payment-button")).click();
  const start = page.locator('[data-testid^="payment-card-lightning-testnet-"]', { hasText: "(NWC)" });
  await expect(start).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("payment-use").click();
  await page.getByTestId("payment-amount").fill("1000");
  await page.getByTestId("payment-request").click();
  const request = chat(bob).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click({ timeout: 60_000 });
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
  await expect(chat(alice).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });

  // It came in on the hub's card, not the node's.
  await openWallet(alice);
  await hub.click();
  const received = page.getByTestId("lightning-recent").getByTestId("lightning-op").filter({ hasText: "Invoice" }).first();
  await expect(received).toContainText("1,000");
  await expect(received).toContainText("paid");
  await node.click();
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").filter({ hasText: "Invoice" })).toHaveCount(0);
  console.log(`  two Lightning cards: node pays 300, hub pays 200, hub receives 1000 (Alice's hub card shows ${sats(await hub.innerText())} sats)`);
});
