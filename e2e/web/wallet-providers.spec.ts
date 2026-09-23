import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import { strangerInvoice } from "../support/bolt11";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";

/**
 * Every wallet provider receiving and sending, on test networks only (the Testnet mode):
 *  - Cashu and Lightning: the public test mint, or the local one E2E_MINT_URL answers for (@network).
 *  - Ark: a local regtest server (GHOSTLY_ARK_REGTEST=1).
 *  - USDT: a local EVM chain with a test token (GHOSTLY_USDT_LOCAL=1).
 * For each: money in, a Send in the chat (reviewed, approved), a Request paid in the chat, and a Send
 * from the wallet page where the provider has one. Balances are checked on both sides.
 */

async function twoInTestnet(peer: (name: string) => Promise<Peer>, names: [string, string]): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer(names[0]), peer(names[1])]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) { await useTestnet(p); await openChat(p); }
  return [alice, bob];
}
const composer = async (p: Peer, card: string, amount: string) => {
  await p.page.getByTestId("payment-button").click();
  await p.page.getByTestId(`payment-card-${card}`).click();
  await p.page.getByTestId("payment-amount").fill(amount);
};
/** Lightning off in this chat for the payee: the test mint pays a request's own invoice by itself. */
async function ecashOnly(p: Peer) {
  await p.page.getByTitle("Options").click();
  await p.page.getByTestId("chat-payments-open").click();
  await p.page.getByTestId("chat-payments").getByTestId("chat-payments-lightning").click();
  await p.page.getByTestId("chat-payments-save").click();
}
async function receiveOverLightning(p: Peer, sats: number) {
  await openWallet(p, "cashu");
  await p.page.getByTestId("wallet-receive").click();
  await p.page.getByTestId("wallet-receive-amount").fill(String(sats));
  await p.page.getByTestId("wallet-create-invoice").click();
  await expect(p.page.getByTestId("wallet-paid")).toContainText(`${sats} test sats received`, { timeout: 60_000 });
}
const testSats = (p: Peer) => p.page.getByTestId("wallet-test-balance");

test.describe("Cashu and Lightning", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  test("Cashu: in over Lightning, a Send in the chat, and a Request paid in the chat", async ({ peer }) => {
    const [alice, bob] = await twoInTestnet(peer, ["cashu-alice", "cashu-bob"]);
    await receiveOverLightning(alice, 100);
    await expect(testSats(alice)).toHaveText(/^100 test sats/);

    await openChat(alice);
    await composer(alice, "cashu", "21");
    await alice.page.getByTestId("payment-send").click();
    const review = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
    await review.getByRole("button", { name: "Approve payment" }).click();
    await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "Sent you" }).getByTestId("payment-state")).toHaveText("Received", { timeout: 60_000 });
    await alice.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();

    await ecashOnly(bob);
    await composer(bob, "cashu", "10");
    await bob.page.getByTestId("payment-request").click();
    const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" });
    await request.getByTestId("payment-pay").click();
    await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
    await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
    await openWallet(bob, "cashu");
    await expect(testSats(bob)).toHaveText(/^31 test sats/, { timeout: 30_000 });
  });

  // A test mint marks its own invoices paid by itself: one peer paying the other's invoice at the same
  // mint proves nothing (the mint refuses it as already paid). So each side is tested on its own: in, an
  // invoice of this wallet paid by the test mint; out, the wallet paying an invoice the mint does not own.
  test("Lightning: in through an invoice, out by paying someone else's invoice from Send", async ({ peer }) => {
    const [alice, bob] = await twoInTestnet(peer, ["ln-alice", "ln-bob"]);
    await receiveOverLightning(alice, 100);
    await expect(testSats(alice)).toHaveText(/^100 test sats/);

    await openWallet(bob, "lightning");
    await bob.page.getByTestId("wallet-receive").click();
    await bob.page.getByTestId("wallet-receive-amount").fill("25");
    await bob.page.getByTestId("wallet-create-invoice").click();
    await expect(bob.page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbc/);
    await expect(bob.page.getByTestId("wallet-paid")).toContainText("25 test sats received", { timeout: 60_000 });
    await openWallet(bob, "cashu");
    await expect(testSats(bob)).toHaveText(/^25 test sats/);

    await openWallet(alice, "lightning");
    await alice.page.getByTestId("wallet-send").click();
    await alice.page.getByTestId("wallet-pay-input").fill(strangerInvoice(25));
    await alice.page.getByRole("button", { name: "Pay 25 sats" }).click();
    await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
    await expect(alice.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
    await openWallet(alice, "cashu");
    const left = Number((await testSats(alice).innerText()).match(/^(\d+)/)![1]);
    expect(left, "100 in, 25 out and at most the fee reserve").toBeLessThanOrEqual(75);
    expect(left).toBeGreaterThanOrEqual(70);
  });
});

test("Ark: in, a Send from the wallet, a Send in the chat and a Request paid in the chat", async ({ peer }) => {
  test.skip(process.env.GHOSTLY_ARK_REGTEST !== "1", "Requires the local Ark regtest stack");
  test.setTimeout(6 * 60_000);
  const mnemonic = execFileSync(process.execPath, ["--experimental-eventsource", "e2e/support/fund-ark.mjs"], { encoding: "utf8", stdio: "pipe" }).trim();
  const [alice, bob] = await twoInTestnet(peer, ["ark-p-alice", "ark-p-bob"]);
  const panel = (p: Peer) => p.page.getByTestId("ark-wallet");
  const balance = (p: Peer) => panel(p).getByTestId("ark-balance");
  for (const p of [alice, bob]) {
    await openWallet(p, "arkade");
    await panel(p).getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 60_000 });
    await expect(balance(p)).toContainText("Regtest", { timeout: 60_000 });
    if (p === alice) {
      await panel(p).getByRole("button", { name: "Restore", exact: true }).click();
      await panel(p).getByLabel("Recovery phrase", { exact: true }).fill(mnemonic);
      await panel(p).getByRole("button", { name: "Restore from phrase", exact: true }).click();
    }
    await expect(panel(p).getByTestId("ark-address")).toBeVisible();
  }
  // In: the funded wallet shows its sats.
  await expect(balance(alice)).toHaveText(/^9,900\s*test sats/, { timeout: 30_000 });

  // A Send from the wallet page, to Bob's address.
  const bobAddress = (await panel(bob).getByTestId("ark-address").innerText()).trim();
  await alice.page.getByTestId("wallet-send").click();
  await panel(alice).getByLabel("Ark recipient address").fill(bobAddress);
  await panel(alice).getByLabel(/^Amount in/).fill("500");
  await panel(alice).getByRole("button", { name: "Review payment" }).click();
  await panel(alice).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(panel(alice).getByTestId("review-status")).toHaveText("settled", { timeout: 60_000 });
  await expect(balance(bob)).toHaveText(/^500\s*test sats/, { timeout: 60_000 });

  // A Send in the chat: Bob's app asks Alice's for an address, Bob approves.
  for (const p of [alice, bob]) await openChat(p);
  await composer(bob, "arkade", "200");
  await bob.page.getByTestId("payment-send").click();
  const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
  await direct.getByRole("button", { name: "Approve payment" }).click({ timeout: 60_000 });
  await expect(direct.getByTestId("review-status")).toHaveText("settled", { timeout: 60_000 });
  await bob.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();

  // A Request paid in the chat.
  await composer(bob, "arkade", "100");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  await openWallet(bob, "arkade");
  // On regtest a batch expires within minutes: what outlived its batch is recovered, never lost.
  const recoverable = panel(bob).getByTestId("ark-recoverable");
  await expect.poll(async () => (await recoverable.isVisible()) || /^400/.test(await balance(bob).innerText()), { timeout: 60_000 }).toBe(true);
  let recovered = false;
  if (await recoverable.isVisible()) {
    await panel(bob).getByTestId("ark-recover").click();
    await expect(recoverable).toHaveCount(0, { timeout: 120_000 });
    recovered = true;
  }
  // 500 in, 200 out, 100 in; a recovery goes through a batch, which costs a few sats.
  const sats = async () => Number((await balance(bob).innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);
  await expect.poll(sats, { timeout: 60_000 }).toBeGreaterThanOrEqual(recovered ? 390 : 400);
  expect(await sats()).toBeLessThanOrEqual(400);
});

test("USDT: in, a Send from the wallet, a Send in the chat and a Request paid in the chat", async ({ peer }) => {
  test.skip(process.env.GHOSTLY_USDT_LOCAL !== "1", "Requires a disposable local EVM chain 31337");
  test.setTimeout(6 * 60_000);
  const config = JSON.parse(readFileSync("/tmp/ghostly-usdt-local.json", "utf8"));
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(config.provider, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const result = await response.json(); if (result.error) throw new Error("Local EVM operation failed"); return result.result;
  };
  expect(await rpc("eth_chainId")).toBe("0x7a69");
  const [alice, bob] = await twoInTestnet(peer, ["usdt-p-alice", "usdt-p-bob"]);
  const panel = (p: Peer) => p.page.getByTestId("usdt-wallet");
  const tokens = (p: Peer) => panel(p).getByTestId("usdt-balance");
  const address: Record<string, string> = {};
  for (const p of [alice, bob]) {
    await openWallet(p, "usdt");
    await panel(p).getByRole("radio", { name: "Local test chain", exact: true }).click({ timeout: 60_000 });
    await panel(p).getByLabel("Token contract", { exact: true }).fill(config.token);
    await panel(p).getByRole("button", { name: "Switch network", exact: true }).click();
    // Testnet starts on Sepolia, also "TEST-USDT": wait for the local chain itself before reading the address.
    await expect(p.page.getByTestId("wallet-card-usdt")).toContainText("EVM local", { timeout: 60_000 });
    await expect(tokens(p)).toHaveText("0 TEST-USDT", { timeout: 60_000 });
    address[p.name] = (await panel(p).getByTestId("usdt-address").innerText()).trim();
    await rpc("anvil_setBalance", [address[p.name], "0xde0b6b3a7640000"]);
  }
  // In: 10 test tokens arrive at Alice's address and show up by themselves.
  const accounts = await rpc("eth_accounts");
  await rpc("eth_sendTransaction", [{ from: accounts[0], to: config.token, data: new Interface(["function mint(address,uint256)"]).encodeFunctionData("mint", [address[alice.name], 10_000_000n]) }]);
  await rpc("evm_mine");
  await openWallet(alice, "usdt");
  await expect(tokens(alice)).toHaveText("10 TEST-USDT", { timeout: 30_000 });

  // A Send from the wallet page, to Bob's address.
  await alice.page.getByTestId("wallet-send").click();
  await panel(alice).getByLabel("USDT recipient address").fill(address[bob.name]);
  await panel(alice).getByLabel(/^Amount in/).fill("2");
  await panel(alice).getByRole("button", { name: "Review payment" }).click();
  await panel(alice).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(panel(alice).getByTestId("review-status")).toHaveText("confirmed", { timeout: 60_000 });
  await openWallet(bob, "usdt");
  await expect(tokens(bob)).toHaveText("2 TEST-USDT", { timeout: 30_000 });

  // A Send in the chat: Bob's app asks Alice's for her address, Bob approves.
  for (const p of [alice, bob]) await openChat(p);
  await composer(bob, "usdt", "0.5");
  await bob.page.getByTestId("payment-send").click();
  const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
  await direct.getByRole("button", { name: "Approve payment" }).click({ timeout: 60_000 });
  await expect(direct.getByTestId("review-status")).toHaveText("confirmed", { timeout: 60_000 });
  await bob.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();

  // A Request paid in the chat.
  await composer(alice, "usdt", "1");
  await alice.page.getByTestId("payment-request").click();
  // The chat Send above left the request Alice's app made for it; this is the new one, for 1.
  const request = chat(bob).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  await openWallet(alice, "usdt");
  await expect(tokens(alice), "10 in, 2 out, 0.5 in, 1 in").toHaveText("9.5 TEST-USDT", { timeout: 30_000 });
  await openWallet(bob, "usdt");
  await expect(tokens(bob), "2 in, 0.5 out, 1 out").toHaveText("0.5 TEST-USDT", { timeout: 30_000 });
});
