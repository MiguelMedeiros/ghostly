import { SPARK_REGTEST, sparkCounterpart, type SparkCounterpart } from "../support/spark";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";

/**
 * Spark as its own way of paying: Spark to Spark, with Spark addresses and invoices, through the Breez SDK (the
 * same WebAssembly the Breez Lightning source loads). Testnet runs on Breez and Lightspark's hosted regtest, with
 * no API key; Mainnet asks for a Breez API key before it makes anything.
 *
 * Money moving: GHOSTLY_SPARK_REGTEST=1 and GHOSTLY_SPARK_COUNTERPART (a funded regtest wallet's phrase, see
 * e2e/support/spark.ts and e2e/README.md).
 */
const panel = (p: Peer) => p.page.getByTestId("spark-wallet");
const balance = (p: Peer) => panel(p).getByTestId("spark-balance");
const sats = async (p: Peer) => Number((await balance(p).innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);
const composer = async (p: Peer, amount: string) => {
  await p.page.getByTestId("payment-button").click();
  await p.page.getByTestId("payment-card-spark").click();
  await p.page.getByTestId("payment-amount").fill(amount);
};

test("Spark on Mainnet asks for a Breez API key, says it is real bitcoin, and makes nothing without one", { tag: ["@feature:wallet.spark.mainnet-key"] }, async ({ peer }) => {
  const alice = await peer("spark-mainnet", { offlineMainnet: true });
  await openWallet(alice, "spark");
  await expect(alice.page.getByTestId("wallet-card-spark")).toContainText("Needs a key");
  await expect(panel(alice).getByTestId("spark-needs-key")).toContainText("Mainnet moves real bitcoin");
  await expect(panel(alice).getByLabel("Breez API key")).toHaveAttribute("type", "password");
  await expect(panel(alice).getByTestId("spark-mainnet-create")).toBeDisabled();
});

test.describe("on Breez's regtest", { tag: "@network" }, () => {
  test("Testnet opens a Spark wallet by itself: a sparkrt1 address, a balance, a recovery phrase", { tag: ["@feature:wallet.spark.create", "@feature:wallet.spark.backup"] }, async ({ peer }) => {
    test.setTimeout(3 * 60_000);
    const alice = await peer("spark-create", { offlineMainnet: true });
    await useTestnet(alice);
    await openWallet(alice, "spark");
    await expect(balance(alice)).toContainText("Regtest", { timeout: 120_000 });
    await expect(balance(alice)).toHaveText(/^0\s*sats/);
    await expect(panel(alice).getByTestId("spark-address")).toContainText(/sparkrt1[a-z0-9]{50,}/);
    await panel(alice).getByRole("button", { name: "Show" }).click();
    await expect(panel(alice).getByTestId("spark-recovery")).toHaveText(/^(\w+ ){11}\w+$/);
  });

  test.describe("Spark to Spark", () => {
    test.skip(!SPARK_REGTEST, "GHOSTLY_SPARK_REGTEST=1 and a funded GHOSTLY_SPARK_COUNTERPART run it (see e2e/README.md)");
    let funder: SparkCounterpart;
    test.beforeAll(async () => { test.setTimeout(3 * 60_000); funder = await sparkCounterpart(); });
    test.afterAll(async () => { await funder?.close(); });

    test("in on the address, a Send from the wallet, a Send and a Request in the chat, with both balances", { tag: ["@gated", "@feature:wallet.spark.send", "@feature:payments.spark.send", "@feature:payments.spark.offer"] }, async ({ peer }) => {
      test.setTimeout(10 * 60_000);
      const [alice, bob] = await Promise.all([peer("spark-alice", { offlineMainnet: true }), peer("spark-bob", { offlineMainnet: true })]);
      await link(alice, bob);
      await connect(alice, bob);
      const address: Record<string, string> = {};
      for (const p of [alice, bob]) {
        await useTestnet(p);
        await openWallet(p, "spark");
        await expect(balance(p)).toContainText("Regtest", { timeout: 120_000 });
        address[p.name] = (await panel(p).getByTestId("spark-address").innerText()).trim();
        expect(address[p.name]).toMatch(/^sparkrt1/);
      }
      expect(address[alice.name]).not.toBe(address[bob.name]);

      // In: the funder pays Alice's Spark address, Spark to Spark.
      const funded = await funder.pay(address[alice.name], 10_000);
      await expect(balance(alice)).toHaveText(/^10,000\s*sats/, { timeout: 120_000 });

      // A Send from the wallet page, to Bob's address.
      const send = async (from: Peer, to: string, amount: number) => {
        await openWallet(from, "spark");
        await from.page.getByTestId("wallet-send").click();
        await panel(from).getByLabel("Spark address or invoice").fill(to);
        await panel(from).getByTestId("spark-amount").fill(String(amount));
        await panel(from).getByTestId("spark-review").click();
        const review = panel(from).getByTestId("payment-review");
        await expect(review).toContainText("Spark to Spark");
        await review.getByRole("button", { name: "Approve payment" }).click();
        await expect(panel(from).getByTestId("review-status")).toHaveText("settled", { timeout: 90_000 });
        await review.getByText("Payment details").click();
        const id = (await review.locator("dt:text-is('Transaction') + dd").innerText()).trim();
        await review.getByRole("button", { name: "Close" }).click();
        return id;
      };
      const walletSend = await send(alice, address[bob.name], 3_000);
      expect(walletSend, "the transfer is named after the key journaled at review").toMatch(/^[0-9a-f-]{36}$/);
      await openWallet(bob, "spark");
      await expect.poll(() => sats(bob), { timeout: 120_000 }).toBe(3_000);
      await expect(panel(bob).getByTestId("spark-history-row").first()).toContainText("+3,000Spark");

      // A Send in the chat: Bob's app asks Alice's for a Spark invoice, Bob approves; Alice's own wallet settles it.
      for (const p of [alice, bob]) await openChat(p);
      await composer(bob, "1500");
      await bob.page.getByTestId("payment-send").click();
      const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
      await expect(direct).toContainText("sparkrt1", { timeout: 60_000 });
      await direct.getByRole("button", { name: "Approve payment" }).click();
      await expect(direct.getByTestId("review-status")).toHaveText("settled", { timeout: 90_000 });
      await bob.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();
      await expect(chat(alice).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });

      // A Request paid in the chat.
      await composer(bob, "700");
      await bob.page.getByTestId("payment-request").click();
      const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
      await expect(request).toContainText("Spark");
      await request.getByTestId("payment-pay").click();
      await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
      await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
      await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });

      // Spark transfers cost nothing here: 10,000 in, 3,000 out, 1,500 in, 700 out; 3,000 in, 1,500 out, 700 in.
      await openWallet(alice, "spark");
      await expect.poll(() => sats(alice), { timeout: 120_000 }).toBe(7_800);
      await openWallet(bob, "spark");
      await expect.poll(() => sats(bob), { timeout: 120_000 }).toBe(2_200);
      const balances = { alice: await sats(alice), bob: await sats(bob) };

      // Everything back to the funder, so the next run needs no faucet: a Send to a Spark address outside Ghostly.
      const before = await funder.balance();
      const returned = [await send(alice, funder.address, 7_800), await send(bob, funder.address, 2_200)];
      // At least: a leaf the funder had out in a swap with Spark's service provider may come back at the same time.
      await expect.poll(async () => { await funder.wallet.syncWallet({}); return funder.balance(); }, { timeout: 120_000 }).toBeGreaterThanOrEqual(before + 10_000);
      for (const p of [alice, bob]) await expect.poll(() => sats(p), { timeout: 60_000 }).toBe(0);
      console.log("Spark regtest evidence:", JSON.stringify({ funded, walletSend, balances, returned, funder: await funder.balance() }));
    });
  });
});
