import { execFileSync } from "node:child_process";
import type { BrowserContext, Route } from "@playwright/test";
import { BDK_REGTEST } from "../support/bdk-regtest/regtest.mjs";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { choose } from "../support/select";
import { FakeEsplora } from "../../packages/browser/test/helpers/fakeEsplora";

/**
 * The BDK wallet (bitcoindevkit in WebAssembly) as the on-chain Bitcoin source, Testnet only:
 *  - offline: the picker offers it in Testnet only, a new wallet shows its 12 words once, a bad phrase or an
 *    unreachable Esplora server is refused before anything is saved, and the chat shows the Bitcoin card;
 *  - offline, against an in-memory Esplora the test switches on and off: a saved wallet whose server is down
 *    when the app starts shows Connecting… with its last balance and connects by itself once the server is
 *    back; Change server moves it to another server, the same wallet;
 *  - GHOSTLY_BDK_REGTEST=1: two wallets on e2e/infra's regtest chain (e2e/support/bdk-regtest) — funded, a Send
 *    from the wallet page, a Send and a Request paid in the chat, balances and txids checked on both sides.
 */

const ESPLORA = BDK_REGTEST.esplora;
const panel = (p: Peer) => p.page.getByTestId("bitcoin-wallet");

async function chooseBdk(p: Peer) {
  await openWallet(p, "bitcoin");
  await choose(panel(p).getByTestId("onchain-source-select"), "bdk");
  return panel(p).getByTestId("provider-form-bdk");
}

test("the BDK wallet is offered in Testnet only, shows a new wallet's words once, and refuses what it cannot use", { tag: ["@feature:wallet.onchain.bdk.create"] }, async ({ peer }) => {
  const alice = await peer("bdk-offline");
  await openWallet(alice, "bitcoin");
  // Mainnet: not offered (no provider runs there yet).
  await expect(panel(alice).getByTestId("onchain-source-none-offered")).toBeVisible();
  await useTestnet(alice);
  const form = await chooseBdk(alice);
  const words = (await panel(alice).getByTestId("bdk-new-phrase").innerText()).trim().split(/\s+/).filter((w) => !/^\d+$/.test(w));
  expect(words).toHaveLength(12);
  // Not before the words are written down.
  await form.getByTestId("provider-save").click();
  await expect(panel(alice)).toContainText("Write the 12 words down first");
  await panel(alice).getByTestId("bdk-written").check();
  await choose(form.getByLabel("Network"), "regtest");
  // Regtest has no public server.
  await form.getByTestId("provider-save").click();
  await expect(panel(alice).getByTestId("onchain-source-error")).toContainText("Regtest needs the address of your own Esplora server");
  // A server that does not answer (nothing listens on port 1): nothing is saved, and it says why.
  await form.getByLabel("Esplora server").fill("http://127.0.0.1:1");
  await form.getByTestId("provider-save").click();
  await expect(panel(alice).getByTestId("onchain-source-error")).toContainText("nothing answers at 127.0.0.1:1: the local Esplora server is not running", { timeout: 30_000 });
  await expect(panel(alice).getByTestId("onchain-source-current")).toContainText("No source");

  // Restoring: a phrase that is not BIP39 is refused.
  await panel(alice).getByRole("radio", { name: "Restore" }).click();
  const restore = panel(alice).getByTestId("provider-form-bdk");
  await restore.getByLabel("Recovery phrase").fill("these are not twelve valid words at all no no no");
  await restore.getByTestId("provider-save").click();
  await expect(panel(alice).getByTestId("onchain-source-error")).toContainText("not valid");
  // The phrase is not echoed back in the error.
  await expect(panel(alice).getByTestId("onchain-source-error")).not.toContainText("twelve valid");
});

/**
 * Esplora servers answered from `esplora` (one regtest chain) under made-up hosts, each of which the test can
 * take down: a refused connection, as when the server is not running.
 */
async function serveEsplora(context: BrowserContext, esplora: FakeEsplora, hosts: string[]) {
  const up = new Map(hosts.map((host) => [host, true]));
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*" };
  for (const host of hosts) {
    await context.route(`https://${host}/**`, async (route: Route) => {
      if (!up.get(host)) return route.abort("connectionrefused");
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const response = await esplora.fetch(request.url(), { method: request.method(), body: request.postData() ?? undefined });
      await route.fulfill({ status: response.status, headers: { ...cors, "content-type": response.headers.get("content-type") ?? "text/plain" }, body: await response.text() });
    });
  }
  return { set: (host: string, answering: boolean) => up.set(host, answering) };
}

test("a BDK wallet whose Esplora is down at start-up shows Connecting…, connects by itself when it is back, and Change server keeps the wallet", { tag: ["@feature:wallet.onchain.sources", "@feature:wallet.onchain.bdk.create"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const esplora = new FakeEsplora();
  const alice = await peer("bdk-reconnect");
  const servers = await serveEsplora(alice.context, esplora, ["esplora-a.ghostly.test", "esplora-b.ghostly.test"]);
  const status = panel(alice).getByTestId("onchain-source-status");
  await useTestnet(alice);
  const form = await chooseBdk(alice);
  await panel(alice).getByTestId("bdk-written").check();
  await choose(form.getByLabel("Network"), "regtest");
  await form.getByLabel("Esplora server").fill("https://esplora-a.ghostly.test/api");
  await form.getByTestId("provider-save").click();
  await expect(status).toContainText(/Connected · BDK BIP84 · [0-9a-f]{8} · regtest/, { timeout: 60_000 });
  const wallet = (await status.innerText()).match(/BDK BIP84 · [0-9a-f]{8}/)![0];
  await panel(alice).getByTestId("bitcoin-new-address").click();
  esplora.fund((await panel(alice).getByTestId("bitcoin-address").innerText()).trim(), 50_000);
  await expect.poll(async () => { await panel(alice).getByRole("button", { name: "Refresh now" }).click(); return panel(alice).getByTestId("bitcoin-balance").innerText(); }, { timeout: 30_000 }).toContain("50,000");

  // Quit and reopen while the server is down: not "Unavailable", but Connecting… with the last balance read.
  servers.set("esplora-a.ghostly.test", false);
  await alice.page.reload();
  await openWallet(alice, "bitcoin");
  const connecting = panel(alice).getByTestId("bitcoin-connecting");
  await expect(connecting).toHaveAttribute("data-status", "connecting");
  await expect(connecting).toContainText("Connecting to BDK wallet…");
  await expect(panel(alice).getByTestId("bitcoin-last-balance")).toContainText("Last known balance: 50,000 sats");
  await expect(panel(alice).getByTestId("bitcoin-connect-error")).toContainText("the Esplora server at esplora-a.ghostly.test did not answer", { timeout: 30_000 });
  await expect(status).toContainText("trying again by itself");
  await expect(panel(alice).getByTestId("bitcoin-retry")).toBeVisible();
  await expect(connecting).toHaveAttribute("data-status", "connecting");
  // The wallet card says so too: the last balance, Connecting…
  await expect(alice.page.getByTestId("wallet-card-bitcoin")).toContainText("50,000");

  // The server comes back: connected by itself, nothing pressed.
  servers.set("esplora-a.ghostly.test", true);
  await expect(status).toContainText(`Connected · ${wallet} · regtest`, { timeout: 60_000 });
  await expect(panel(alice).getByTestId("bitcoin-balance")).toContainText("50,000");

  // Change server: server A goes away for good, B serves the same chain. Same wallet, same coins.
  servers.set("esplora-a.ghostly.test", false);
  await panel(alice).getByTestId("onchain-source-change-server").click();
  const change = panel(alice).getByTestId("onchain-source-server-form");
  await expect(change.getByLabel("Esplora server")).toHaveValue("https://esplora-a.ghostly.test/api");
  await change.getByLabel("Esplora server").fill("https://esplora-b.ghostly.test/api");
  await change.getByTestId("onchain-source-server-save").click();
  await expect(panel(alice).getByTestId("onchain-source-saved")).toContainText("BDK wallet now uses that server.", { timeout: 60_000 });
  await expect(status).toContainText(`Connected · ${wallet} · regtest`);
  await expect.poll(async () => { await panel(alice).getByRole("button", { name: "Refresh now" }).click(); return panel(alice).getByTestId("bitcoin-balance").innerText(); }, { timeout: 30_000 }).toContain("50,000");

  // And it is what the next start uses.
  await alice.page.reload();
  await openWallet(alice, "bitcoin");
  await expect(status).toContainText(`Connected · ${wallet} · regtest`, { timeout: 60_000 });
});

test("the chat offers on-chain Bitcoin, off until a source is set up", { tag: ["@feature:payments.bitcoin.offer"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("bdk-chat-a"), peer("bdk-chat-b")]);
  await link(alice, bob);
  await connect(alice, bob);
  await alice.page.getByTestId("payment-button").click({ timeout: 60_000 });
  await expect(alice.page.getByTestId("payment-card-bitcoin")).toBeDisabled();
  await expect(alice.page.getByTestId("payment-card-bitcoin")).toHaveAttribute("title", /Bitcoin is not set up yet/);
});

test("BDK on regtest: funded, a Send from the wallet, a Send and a Request paid in the chat", { tag: ["@gated", "@feature:wallet.onchain.bdk.send", "@feature:payments.bitcoin.send", "@feature:wallet.onchain.sources"] }, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_BDK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_BDK_REGTEST=1");
  test.setTimeout(8 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bdk-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  regtest("ready");
  const [alice, bob] = await Promise.all([peer("bdk-alice"), peer("bdk-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const balance = (p: Peer) => panel(p).getByTestId("bitcoin-balance");
  const sats = async (p: Peer) => Number((await balance(p).innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);
  /** Mines until the wallet shows `n` confirmed sats (electrs indexes a block a moment after its tip). */
  const confirmed = (p: Peer, n: number) => expect.poll(async () => { regtest("mine", "1"); await panel(p).getByRole("button", { name: "Refresh now" }).click(); return sats(p); }, { timeout: 90_000, intervals: [3_000] }).toBe(n);
  const address: Record<string, string> = {};
  for (const p of [alice, bob]) {
    await useTestnet(p);
    const form = await chooseBdk(p);
    await panel(p).getByTestId("bdk-written").check();
    await choose(form.getByLabel("Network"), "regtest");
    await form.getByLabel("Esplora server").fill(ESPLORA);
    await form.getByTestId("provider-save").click();
    await expect(panel(p).getByTestId("onchain-source-saved")).toBeVisible({ timeout: 60_000 });
    await expect(panel(p).getByTestId("onchain-source-status")).toContainText(/Connected · BDK BIP84 · [0-9a-f]{8} · regtest/);
    await expect(balance(p)).toContainText("0");
    await panel(p).getByTestId("bitcoin-new-address").click();
    address[p.name] = (await panel(p).getByTestId("bitcoin-address").innerText()).trim();
    expect(address[p.name]).toMatch(/^bcrt1q/);
  }

  // In: the regtest miner pays Alice's address.
  const fundTxid = regtest("send", address[alice.name], "100000");
  await confirmed(alice, 100_000);

  // A Send from the wallet page, to Bob's address: signed at review, broadcast at approval.
  await alice.page.getByTestId("wallet-send").click();
  await panel(alice).getByLabel("Bitcoin recipient address").fill(address[bob.name]);
  await panel(alice).getByTestId("bitcoin-amount").fill("20000");
  await panel(alice).getByRole("button", { name: "Review payment" }).click();
  const review = panel(alice).getByTestId("payment-review");
  await expect(review).toContainText("bitcoin · regtest");
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(review.getByTestId("review-status")).toHaveText("submitted", { timeout: 60_000 });
  await review.getByText("Payment details").click();
  const walletSend = (await review.locator("dt:text-is('Transaction') + dd").innerText()).trim();
  expect(walletSend).toMatch(/^[0-9a-f]{64}$/);
  const onChain = JSON.parse(regtest("tx", walletSend)) as { vout: { sats: number; address: string }[] };
  expect(onChain.vout).toContainEqual({ sats: 20_000, address: address[bob.name] });
  await confirmed(bob, 20_000);
  await expect(review.getByTestId("review-status")).toHaveText("settled", { timeout: 60_000 });
  // Alice's change confirmed in the same block: her balance is what is left after the fee.
  const refreshed = async (p: Peer) => { await panel(p).getByRole("button", { name: "Refresh now" }).click(); return sats(p); };
  await expect.poll(() => refreshed(alice), { timeout: 60_000 }).toBeGreaterThan(78_000);
  const fee1 = 100_000 - 20_000 - await sats(alice);
  expect(fee1).toBeGreaterThan(0);
  expect(fee1).toBeLessThan(2_000);

  // A Send in the chat: Bob's app asks Alice's for a fresh address, Bob approves.
  for (const p of [alice, bob]) await openChat(p);
  await bob.page.getByTestId("payment-button").click();
  await bob.page.getByTestId("payment-card-bitcoin").click();
  await bob.page.getByTestId("payment-amount").fill("5000");
  await bob.page.getByTestId("payment-send").click();
  const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
  await expect(direct).toContainText("bitcoin · regtest", { timeout: 60_000 });
  await direct.getByRole("button", { name: "Approve payment" }).click();
  await expect(direct.getByTestId("review-status")).toHaveText(/submitted|settled/, { timeout: 60_000 });
  await direct.getByText("Payment details").click();
  const chatSend = (await direct.locator("dt:text-is('Transaction') + dd").innerText()).trim();
  await bob.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();
  const alicesRequest = chat(alice).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last();
  // Not paid before it confirms, whatever Bob's app says.
  await expect(alicesRequest.getByTestId("payment-state")).toHaveText("Waiting for payment");
  await expect.poll(async () => { regtest("mine", "1"); return alicesRequest.getByTestId("payment-state").innerText(); }, { timeout: 90_000, intervals: [3_000] }).toBe("Paid");

  // A Request paid in the chat: Bob asks, Alice pays from the bubble.
  await bob.page.getByTestId("payment-button").click();
  await bob.page.getByTestId("payment-card-bitcoin").click();
  await bob.page.getByTestId("payment-amount").fill("3000");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await expect(request).toContainText("Bitcoin on-chain · regtest", { timeout: 60_000 });
  await expect(request).toContainText("test sats");
  await request.getByTestId("payment-pay").click();
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-review").getByTestId("review-status")).toHaveText(/submitted|settled/, { timeout: 60_000 });
  await request.getByTestId("payment-review").getByText("Payment details").click();
  const chatRequest = (await request.getByTestId("payment-review").locator("dt:text-is('Transaction') + dd").innerText()).trim();
  const bobsRequest = chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last();
  await expect.poll(async () => { regtest("mine", "1"); return bobsRequest.getByTestId("payment-state").innerText(); }, { timeout: 90_000, intervals: [3_000] }).toBe("Paid");
  // The payer's side is paid once its own review settles: the engine reconciles reviews every 10 s.
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 150_000 });

  // Balances on both sides, and each txid on the chain paying what was asked.
  for (const txid of [chatSend, chatRequest]) expect(JSON.parse(regtest("tx", txid)).confirmations).toBeGreaterThan(0);
  // Everything confirmed: nothing left in the mempool on either side.
  await openWallet(bob, "bitcoin");
  await expect.poll(async () => [await refreshed(bob), await balance(bob).innerText()], { timeout: 60_000 }).toEqual([expect.any(Number), expect.not.stringContaining("unconfirmed")]);
  const bobSats = await sats(bob);
  await openWallet(alice, "bitcoin");
  await expect.poll(async () => [await refreshed(alice), await balance(alice).innerText()], { timeout: 60_000 }).toEqual([expect.any(Number), expect.not.stringContaining("unconfirmed")]);
  const aliceSats = await sats(alice);
  // Bob: 20,000 in, 5,000 out (plus its fee), 3,000 in. Alice: the rest, less her two fees.
  const bobFee = 20_000 - 5_000 + 3_000 - bobSats;
  expect(bobFee).toBeGreaterThan(0);
  expect(bobFee).toBeLessThan(2_000);
  const aliceFee2 = 100_000 - 20_000 - fee1 + 5_000 - 3_000 - aliceSats;
  expect(aliceFee2).toBeGreaterThan(0);
  expect(aliceFee2).toBeLessThan(2_000);
  await panel(alice).getByTestId("wallet-history").click();
  for (const txid of [fundTxid, walletSend, chatSend, chatRequest]) await expect(panel(alice).getByTestId("bitcoin-history")).toContainText(txid);
  console.log("BDK regtest evidence:", JSON.stringify({ fundTxid, walletSend, chatSend, chatRequest, alice: aliceSats, bob: bobSats, fees: { walletSend: fee1, chatSend: bobFee, chatRequest: aliceFee2 } }));
});
