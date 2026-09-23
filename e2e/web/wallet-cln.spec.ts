import { CLN_REGTEST, channelBalance, invoice, nodeId, pay, rune } from "../support/cln-regtest/regtest.mjs";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";

/**
 * Core Lightning as the Lightning source, against the regtest stack in e2e/support/cln-regtest (two nodes,
 * alice and bob, with a channel between them). Each person's Ghostly connects to a node over Commando
 * with a rune restricted to what Ghostly calls; the rune is made fresh, typed into the form, and must
 * never come back into the page. Worthless regtest coins only. GHOSTLY_CLN_REGTEST=1 to run.
 */
type Node = "alice" | "bob";

test.skip(process.env.GHOSTLY_CLN_REGTEST !== "1", "Requires the local Core Lightning regtest stack (e2e/support/cln-regtest)");
test.setTimeout(3 * 60_000);

/** Makes the node this peer's Lightning source in Testnet, through the source picker's form. */
async function useNode(p: Peer, node: Node) {
  const secret: string = rune(node);
  await useTestnet(p);
  await openWallet(p, "lightning");
  const source = p.page.getByTestId("lightning-source");
  await source.getByTestId("lightning-source-select").selectOption("core-lightning");
  const form = source.getByTestId("provider-form-core-lightning");
  await form.getByLabel("Node id").fill(nodeId(node));
  await form.getByLabel("WebSocket address").fill(CLN_REGTEST[node].websocket);
  await form.getByLabel("Rune").fill(secret);
  await form.getByTestId("provider-save").click();
  await expect(source.getByTestId("lightning-source-current")).toContainText("Core Lightning", { timeout: 30_000 });
  await expect(source.getByTestId("lightning-source-status")).toContainText("Connected");
  // The rune is sealed in the engine: never back in the page.
  expect(await p.page.content()).not.toContain(secret);
}

const balance = async (p: Peer) => {
  const text = await p.page.getByTestId("wallet-balance").locator("span").first().innerText();
  return Number(text.replace(/[^\d]/g, "") || NaN);
};

test("a Core Lightning node as the Lightning source: an invoice paid into it, and an invoice paid from it", async ({ peer }) => {
  const alice = await peer("cln-source");
  await useNode(alice, "alice");
  const page = alice.page;
  await expect.poll(() => balance(alice), { timeout: 30_000 }).toBe(channelBalance("alice"));
  const start = await balance(alice);

  // Receive: the invoice is the node's (regtest); the other node pays it; the card sees it paid.
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("150");
  await page.getByTestId("wallet-create-invoice").click();
  const bolt11 = (await page.getByTestId("wallet-invoice").innerText()).trim();
  expect(bolt11).toMatch(/^lnbcrt1500n/);
  pay("bob", bolt11);
  await expect(page.getByTestId("wallet-paid")).toContainText("150 test sats received", { timeout: 30_000 });
  await expect(page.getByTestId("lightning-recent").getByTestId("lightning-op").first()).toContainText("paid");
  await expect.poll(() => balance(alice), { timeout: 30_000 }).toBe(start + 150);

  // Send: an invoice of the other node, paid by this one under the fee cap.
  await openWallet(alice, "lightning");
  await page.getByTestId("wallet-send").click();
  await page.getByTestId("wallet-pay-input").fill(invoice("bob", 70, "from the e2e"));
  await page.getByRole("button", { name: "Pay 70 sats" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
  // A direct channel: no routing fee.
  await expect.poll(() => balance(alice), { timeout: 30_000 }).toBe(start + 150 - 70);
});

test("a chat request paid over Lightning, from one person's node to the other's", async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("cln-chat-alice"), peer("cln-chat-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await useNode(alice, "alice");
  await useNode(bob, "bob");
  const before = { alice: channelBalance("alice") as number, bob: channelBalance("bob") as number };

  // Lightning only in this chat, on both sides: the request carries bob's node's invoice, alice's node pays it.
  for (const p of [alice, bob]) {
    await openChat(p);
    await p.page.getByTitle("Options").click();
    await p.page.getByTestId("chat-payments-open").click();
    await p.page.getByTestId("chat-payments").getByTestId("chat-payments-cashu").click();
    await p.page.getByTestId("chat-payments-save").click();
  }
  await bob.page.getByTestId("payment-button").click();
  await bob.page.getByTestId("payment-card-lightning").click();
  await bob.page.getByTestId("payment-amount").fill("210");
  await bob.page.getByTestId("payment-request").click();

  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  const review = request.getByTestId("payment-review");
  if (await review.isVisible().catch(() => false)) await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  // Bob's node saw its invoice paid, and told bob's chat.
  await expect(chat(bob).getByTestId("payment-bubble").last().getByTestId("payment-state")).toHaveText(/Paid|Received/, { timeout: 60_000 });

  // Both nodes moved by the amount (a direct channel: no fee), and both cards say so.
  await expect.poll(() => channelBalance("bob") - before.bob, { timeout: 30_000 }).toBe(210);
  expect(before.alice - channelBalance("alice")).toBe(210);
  for (const [p, node] of [[alice, "alice"], [bob, "bob"]] as const) {
    await openWallet(p, "lightning");
    await expect.poll(() => balance(p), { timeout: 30_000 }).toBe(channelBalance(node));
  }
});
