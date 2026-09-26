import { execFileSync } from "node:child_process";
import { Interface } from "ethers";
import { USDT_LOCAL } from "../support/usdt-local.mjs";
import { strangerInvoice } from "../support/bolt11";
import { TEST_COINS, chat, connect, createWallet, expect, getTestCoins, link, openChat, openWallet, test, type Peer, type PeerOptions, type WalletKind } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { chatPayments, paymentCard } from "../support/payments";

/**
 * Every wallet provider receiving and sending, on test networks only: each person makes the Testnet wallets the test
 * needs with New (nothing is made by itself), then moves an Ark, Bark or USDT one to the local test chain.
 *  - Cashu and Lightning: the public test mint, or the local one E2E_MINT_URL answers for (@network).
 *  - Ark: arkd on e2e/infra's regtest chain (GHOSTLY_ARK_REGTEST=1). New makes it on Mutinynet first (@network).
 *  - Bark (Second's Ark): captaind on e2e/infra's regtest chain (GHOSTLY_BARK_REGTEST=1). New makes it on signet first (@network).
 *  - USDT: e2e/infra's local EVM chain with a test token (GHOSTLY_USDT_LOCAL=1). New makes it on Sepolia first (@network).
 * For each: money in, a Send in the chat (reviewed, approved), a Request paid in the chat, and a Send
 * from the wallet page where the provider has one. Balances are checked on both sides.
 */

/** Two people in a chat, each with these Testnet wallets, made with New (a new profile has none). */
async function twoInTestnet(peer: (name: string, options?: PeerOptions) => Promise<Peer>, names: [string, string], kinds: WalletKind[] = ["cashu"]): Promise<[Peer, Peer]> {
  const [alice, bob] = await Promise.all([peer(names[0]), peer(names[1])]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) {
    for (const kind of kinds) await createWallet(p, kind, "testnet");
    await openChat(p);
  }
  return [alice, bob];
}
/** The payment composer on one Testnet card (`cashu`: the Testnet Cashu wallet's), with an amount. */
const composer = async (p: Peer, card: string, amount: string) => {
  await (await composerRow(p.page, "payment-button")).click();
  await paymentCard(p.page, `${card}-testnet`).click();
  await p.page.getByTestId("payment-amount").fill(amount);
};
/** Lightning off in this chat for the payee: its requests are paid in ecash only. */
async function ecashOnly(p: Peer) {
  await chatPayments(p.page, { lightning: false });
}
const testSats = (p: Peer) => p.page.getByTestId("wallet-balance");

test.describe("Cashu and Lightning", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  test("Cashu: test coins in, a Send in the chat, and a Request paid in the chat", { tag: ["@feature:wallet.test-coins", "@feature:payments.cashu.send", "@feature:payments.cashu.request", "@feature:payments.chat.review"] }, async ({ peer }) => {
    const [alice, bob] = await twoInTestnet(peer, ["cashu-alice", "cashu-bob"]);
    await getTestCoins(alice);
    await expect(testSats(alice)).toHaveText(/^10,000\s*test sats/);

    await openChat(alice);
    await composer(alice, "cashu", "21");
    await alice.page.getByTestId("payment-send").click();
    const review = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
    await review.getByRole("button", { name: "Approve payment" }).click();
    await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "Sent you" }).getByTestId("payment-state")).toHaveText("Received", { timeout: 60_000 });
    // The sheet closed once the payment went out.
    await expect(alice.page.getByTestId("payment-composer")).toHaveCount(0);

    await ecashOnly(bob);
    await composer(bob, "cashu", "10");
    await bob.page.getByTestId("payment-request").click();
    const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" });
    await request.getByTestId("payment-pay").click();
    await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
    await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
    await openWallet(bob, "cashu-testnet");
    await expect(testSats(bob)).toHaveText(/^31\s*test sats/, { timeout: 30_000 });
  });

  // A test mint marks its own invoices paid by itself, so its "paid" is nobody paying: Receive only makes the
  // invoice, and the balance stays where it was (the wallet waits for a payer's word, which a chat carries). Out,
  // the wallet pays an invoice the mint does not own.
  test("Lightning: Receive only makes an invoice, out by paying someone else's invoice from Send", { tag: ["@feature:wallet.lightning.cashu-mint.receive", "@feature:wallet.lightning.cashu-mint.pay", "@feature:wallet.cashu.receive-lightning", "@feature:wallet.testnet.receive-held"] }, async ({ peer }) => {
    const [alice, bob] = await twoInTestnet(peer, ["ln-alice", "ln-bob"]);
    await getTestCoins(alice);
    await expect(testSats(alice)).toHaveText(/^10,000\s*test sats/);

    await openWallet(bob, "lightning-testnet");
    await bob.page.getByTestId("wallet-receive").click();
    await bob.page.getByTestId("wallet-receive-amount").fill("25");
    await bob.page.getByTestId("wallet-create-invoice").click();
    await expect(bob.page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbc/);
    await expect(bob.page.getByTestId("wallet-panel")).toContainText("counts only once a contact pays it in a chat");
    // The mint reads it paid within a poll or two (4 s each): nothing comes of it.
    await bob.page.waitForTimeout(12_000);
    await expect(bob.page.getByTestId("wallet-paid")).toHaveCount(0);
    await expect(bob.page.getByTestId("wallet-invoice")).toBeVisible();
    await openWallet(bob, "cashu-testnet");
    await expect(testSats(bob)).toHaveText(/^0\s*test sats/);

    await openWallet(alice, "lightning-testnet");
    await alice.page.getByTestId("wallet-send").click();
    await alice.page.getByTestId("wallet-pay-input").fill(strangerInvoice(25));
    await alice.page.getByRole("button", { name: "Pay 25 sats" }).click();
    await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
    await expect(alice.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 60_000 });
    await openWallet(alice, "cashu-testnet");
    // The balance counts down to its new value (useCountUp, 0.7 s): read once, it can be anywhere on the way.
    await expect(async () => {
      const left = Number((await testSats(alice).innerText()).replace(/,/g, "").match(/^(\d+)/)![1]);
      expect(left, "test coins in, 25 out and at most the fee reserve").toBeLessThanOrEqual(TEST_COINS - 25);
      expect(left).toBeGreaterThanOrEqual(TEST_COINS - 30);
    }).toPass({ timeout: 15_000 });
  });
});

test("Ark: in, a Send from the wallet, a Send in the chat and a Request paid in the chat", { tag: ["@network", "@gated", "@feature:wallet.ark.send", "@feature:payments.arkade.send", "@feature:payments.arkade.request"] }, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_ARK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_ARK_REGTEST=1");
  test.setTimeout(6 * 60_000);
  const mnemonic = execFileSync(process.execPath, ["--experimental-eventsource", "e2e/support/fund-ark.mjs"], { encoding: "utf8", stdio: "pipe" }).trim();
  const [alice, bob] = await twoInTestnet(peer, ["ark-p-alice", "ark-p-bob"], ["arkade"]);
  const panel = (p: Peer) => p.page.getByTestId("ark-wallet");
  const balance = (p: Peer) => panel(p).getByTestId("ark-balance");
  for (const p of [alice, bob]) {
    await openWallet(p, "arkade-testnet");
    // New made it on Mutinynet; an empty wallet moves to the local regtest server.
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
  // Gone out: the sheet closes, back to the chat, whose bubbles tell the rest.
  await expect(bob.page.getByTestId("payment-composer")).toHaveCount(0, { timeout: 60_000 });

  // A Request paid in the chat.
  await composer(bob, "arkade", "100");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  await openWallet(bob, "arkade-testnet");
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

test("Bark: in over Ark and on-chain, a Send from the wallet, a Send in the chat and a Request paid in the chat", { tag: ["@network", "@gated", "@feature:wallet.bark.send", "@feature:payments.bark.send"] }, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_BARK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_BARK_REGTEST=1");
  test.setTimeout(6 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bark-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  regtest("ready");
  const [alice, bob] = await twoInTestnet(peer, ["bark-p-alice", "bark-p-bob"], ["bark"]);
  const panel = (p: Peer) => p.page.getByTestId("bark-wallet");
  const balance = (p: Peer) => panel(p).getByTestId("bark-balance");
  const address: Record<string, string> = {};
  for (const p of [alice, bob]) {
    await openWallet(p, "bark-testnet");
    // New made it on signet; an empty wallet makes way for the local regtest server.
    await panel(p).getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 90_000 });
    await expect(balance(p)).toContainText("Regtest", { timeout: 90_000 });
    address[p.name] = (await panel(p).getByTestId("bark-address").innerText()).trim();
    expect(address[p.name]).toMatch(/^tark1p/);
  }
  // In over Ark: a Bark wallet of the same server (the funder) pays Alice's address.
  const funded = JSON.parse(regtest("pay", address[alice.name], "20000"));
  expect(funded).toMatchObject({ status: "successful", kind: "send", sat: -20000 });
  await expect(balance(alice)).toHaveText(/^20,000\s*test sats/, { timeout: 60_000 });

  // In on-chain: coins to Bob's on-chain address, then moved into Ark (a board, confirmed on regtest).
  await panel(bob).getByRole("radio", { name: "Bitcoin on-chain" }).click();
  const onchain = (await panel(bob).getByTestId("bark-onchain-address").innerText()).trim();
  const onchainTxid = regtest("send-onchain", onchain, "30000");
  await expect(panel(bob).getByTestId("bark-onchain")).toContainText("30,000", { timeout: 60_000 });
  await panel(bob).getByTestId("bark-board").click();
  const sats = async (p: Peer) => Number((await balance(p).innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);
  // The board is an on-chain transaction: its fee comes off, the rest lands in Ark once it confirms. The fee is
  // what the chain's estimates say — on e2e/infra's shared chain the other suites' channels teach bitcoind about
  // 10 sat/vB, so around a thousand sats, not the floor rate of an empty chain.
  await expect.poll(async () => { regtest("mine", "1"); return sats(bob); }, { timeout: 120_000, intervals: [3_000] }).toBeGreaterThan(27_000);
  const boarded = await sats(bob);
  expect(boarded).toBeLessThan(30_000);
  await panel(bob).getByRole("radio", { name: "Bark (instant)" }).click();

  // A Send from the wallet page, to Bob's address.
  await alice.page.getByTestId("wallet-send").click();
  await panel(alice).getByLabel("Bark recipient address").fill(address[bob.name]);
  await panel(alice).getByLabel(/^Amount in/).fill("5000");
  await panel(alice).getByRole("button", { name: "Review payment" }).click();
  await panel(alice).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(panel(alice).getByTestId("review-status")).toHaveText("settled", { timeout: 60_000 });
  await panel(alice).getByTestId("payment-review").getByText("Payment details").click();
  const walletSend = (await panel(alice).getByTestId("payment-review").locator("dt:text-is('Transaction') + dd").innerText()).trim();
  expect(walletSend, "the Ark transaction of the send").toMatch(/^[a-f0-9]{64}$/);
  await expect.poll(() => sats(bob), { timeout: 60_000 }).toBe(boarded + 5_000);

  // A Send in the chat: Bob's app asks Alice's for a fresh Bark address, Bob approves.
  for (const p of [alice, bob]) await openChat(p);
  await composer(bob, "bark", "2000");
  await bob.page.getByTestId("payment-send").click();
  const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
  await direct.getByRole("button", { name: "Approve payment" }).click({ timeout: 60_000 });
  // Gone out: the sheet closes, back to the chat, whose bubbles tell the rest.
  await expect(bob.page.getByTestId("payment-composer")).toHaveCount(0, { timeout: 60_000 });
  // Alice's app settles the request it made for that from her own wallet, not from Bob's word.
  await expect(chat(alice).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });

  // A Request paid in the chat.
  await composer(bob, "bark", "1000");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });

  // Payments between Bark wallets cost nothing on this server: 20,000 in, 5,000 out, 2,000 in, 1,000 out;
  // what was boarded, 5,000 in, 2,000 out, 1,000 in.
  await openWallet(alice, "bark-testnet");
  await expect(balance(alice)).toHaveText(/^16,000\s*test sats/, { timeout: 60_000 });
  await openWallet(bob, "bark-testnet");
  await expect.poll(() => sats(bob), { timeout: 60_000 }).toBe(boarded + 4_000);
  console.log("Bark regtest evidence:", JSON.stringify({ funded, onchainTxid, boarded, walletSend, alice: await sats(alice), bob: await sats(bob), funder: JSON.parse(regtest("balance")).spendable_sat }));
});

test("USDT: in, a Send from the wallet, a Send in the chat and a Request paid in the chat", { tag: ["@network", "@gated", "@feature:wallet.usdt.send", "@feature:payments.usdt.send"] }, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_USDT_LOCAL !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_USDT_LOCAL=1");
  test.setTimeout(6 * 60_000);
  const config = USDT_LOCAL;
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(config.provider, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const result = await response.json(); if (result.error) throw new Error("Local EVM operation failed"); return result.result;
  };
  expect(await rpc("eth_chainId")).toBe("0x7a69");
  const [alice, bob] = await twoInTestnet(peer, ["usdt-p-alice", "usdt-p-bob"], ["usdt"]);
  const panel = (p: Peer) => p.page.getByTestId("usdt-wallet");
  const tokens = (p: Peer) => panel(p).getByTestId("usdt-balance");
  const address: Record<string, string> = {};
  for (const p of [alice, bob]) {
    await openWallet(p, "usdt-testnet");
    await panel(p).getByRole("radio", { name: "Local test chain", exact: true }).click({ timeout: 60_000 });
    await panel(p).getByLabel("Token contract", { exact: true }).fill(config.token);
    await panel(p).getByRole("button", { name: "Switch network", exact: true }).click();
    // New made it on Sepolia, also "TEST-USDT": wait for the local chain itself before reading the address.
    await expect(p.page.getByTestId("wallet-card-usdt-testnet")).toContainText("EVM local", { timeout: 60_000 });
    await expect(tokens(p)).toHaveText("0 TEST-USDT", { timeout: 60_000 });
    address[p.name] = (await panel(p).getByTestId("usdt-address").innerText()).trim();
    await rpc("anvil_setBalance", [address[p.name], "0xde0b6b3a7640000"]);
  }
  // In: 10 test tokens arrive at Alice's address and show up by themselves.
  const accounts = await rpc("eth_accounts");
  await rpc("eth_sendTransaction", [{ from: accounts[0], to: config.token, data: new Interface(["function mint(address,uint256)"]).encodeFunctionData("mint", [address[alice.name], 10_000_000n]) }]);
  await rpc("evm_mine");
  await openWallet(alice, "usdt-testnet");
  await expect(tokens(alice)).toHaveText("10 TEST-USDT", { timeout: 30_000 });

  // A Send from the wallet page, to Bob's address.
  await alice.page.getByTestId("wallet-send").click();
  await panel(alice).getByLabel("USDT recipient address").fill(address[bob.name]);
  await panel(alice).getByLabel(/^Amount in/).fill("2");
  await panel(alice).getByRole("button", { name: "Review payment" }).click();
  await panel(alice).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(panel(alice).getByTestId("review-status")).toHaveText("confirmed", { timeout: 60_000 });
  await openWallet(bob, "usdt-testnet");
  await expect(tokens(bob)).toHaveText("2 TEST-USDT", { timeout: 30_000 });

  // A Send in the chat: Bob's app asks Alice's for her address, Bob approves.
  for (const p of [alice, bob]) await openChat(p);
  await composer(bob, "usdt", "0.5");
  await bob.page.getByTestId("payment-send").click();
  const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
  await direct.getByRole("button", { name: "Approve payment" }).click({ timeout: 60_000 });
  // Gone out: the sheet closes, back to the chat, whose bubbles tell the rest.
  await expect(bob.page.getByTestId("payment-composer")).toHaveCount(0, { timeout: 60_000 });

  // A Request paid in the chat.
  await composer(alice, "usdt", "1");
  await alice.page.getByTestId("payment-request").click();
  // The chat Send above left the request Alice's app made for it; this is the new one, for 1.
  const request = chat(bob).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click();
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });
  await openWallet(alice, "usdt-testnet");
  await expect(tokens(alice), "10 in, 2 out, 0.5 in, 1 in").toHaveText("9.5 TEST-USDT", { timeout: 30_000 });
  await openWallet(bob, "usdt-testnet");
  await expect(tokens(bob), "2 in, 0.5 out, 1 out").toHaveText("0.5 TEST-USDT", { timeout: 30_000 });
});
