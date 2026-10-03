import { readFileSync } from "node:fs";
import { SPARK_REGTEST, sparkCounterpart, type SparkCounterpart } from "../support/spark";
import { chat, connect, createWallet, expect, link, openChat, openProfilePage, openWallet, test, walletCard, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { paymentCard } from "../support/payments";

/**
 * Spark as its own way of paying: Spark to Spark, with Spark addresses and invoices, through the Breez SDK (the
 * same WebAssembly the Breez Lightning source loads). A Testnet Spark wallet, made with New, runs on Breez and
 * Lightspark's hosted regtest, with no API key; a Mainnet one needs the person's Breez API key, which New asks for.
 *
 * Money moving: GHOSTLY_SPARK_REGTEST=1 and GHOSTLY_SPARK_COUNTERPART (a funded regtest wallet's phrase, see
 * e2e/support/spark.ts and e2e/README.md).
 */
const PASSPHRASE = "a spark copy backup passphrase";
const panel = (p: Peer) => p.page.getByTestId("spark-wallet");
const balance = (p: Peer) => panel(p).getByTestId("spark-balance");
const sats = async (p: Peer) => Number((await balance(p).innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);
const composer = async (p: Peer, amount: string) => {
  await (await composerRow(p.page, "payment-button")).click();
  await paymentCard(p.page, "spark-testnet").click();
  await p.page.getByTestId("payment-amount").fill(amount);
};

test("Spark on Mainnet: New asks for a Breez API key first, and makes nothing without one", { tag: ["@feature:wallet.spark.mainnet-key", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("spark-mainnet", { offlineMainnet: true });
  await openWallet(alice);
  await alice.page.getByTestId("wallet-add").click();
  const dialog = alice.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  const spark = dialog.getByTestId("new-wallet-type-spark");
  await expect(dialog.getByTestId("new-wallet-type-spark-status")).toHaveText("Create…");
  await expect(spark).toContainText("with your Breez API key");
  await spark.click();
  await expect(dialog.getByTestId("new-wallet-progress")).toHaveCount(0);
  const key = dialog.getByTestId("new-wallet-api-key");
  await expect(key).toHaveAttribute("type", "password");
  await expect(dialog.getByTestId("new-wallet-create")).toBeDisabled();
  await key.fill("breez-key");
  await expect(dialog.getByTestId("new-wallet-create")).toBeEnabled();
  await dialog.getByTestId("new-wallet-back").click();
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await expect(dialog.getByTestId("new-wallet-type-spark-status")).toHaveText("Create");
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-spark-]")).toHaveCount(0);
});

test.describe("on Breez's regtest", { tag: "@network" }, () => {
  test("New makes a Testnet Spark wallet in one click: a sparkrt1 address, a balance, a recovery phrase", { tag: ["@feature:wallet.spark.create", "@feature:wallet.spark.backup", "@feature:wallet.instances.create"] }, async ({ peer }) => {
    test.setTimeout(3 * 60_000);
    const alice = await peer("spark-create", { offlineMainnet: true });
    await createWallet(alice, "spark", "testnet", { timeout: 120_000 });
    await openWallet(alice, "spark-testnet");
    await expect(walletCard(alice.page, "spark-testnet").getByTestId("wallet-card-network")).toHaveText("Testnet");
    await expect(balance(alice)).toContainText("Regtest", { timeout: 120_000 });
    await expect(balance(alice)).toHaveText(/^0\s*test sats/);
    await expect(panel(alice).getByTestId("spark-address")).toContainText(/sparkrt1[a-z0-9]{50,}/);
    await panel(alice).getByRole("button", { name: "Show" }).click();
    await expect(panel(alice).getByTestId("spark-recovery")).toHaveText(/^(\w+ ){11}\w+$/);
  });

  test("a profile restored as a copy on the same device opens a Breez database of its own, and deleting the copy deletes that one only", { tag: ["@feature:wallet.spark.storage", "@feature:backup.profile.same-device", "@feature:profiles.delete"] }, async ({ peer }) => {
    test.setTimeout(6 * 60_000);
    const alice = await peer("spark-copy", { offlineMainnet: true });
    const { page } = alice;
    /** Every database name on this device. */
    const all = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
    /** The Breez wallets on this device, by storage name: the SDK keeps `<name>/regtest/<identity>` and its `-tree`. */
    const breez = async () => [...new Set((await all()).map((name) => name.match(/^(ghostly-breez-regtest-[0-9a-f]{16})\/regtest\/[0-9a-f]+$/)?.[1]).filter((name): name is string => !!name))].sort();
    const rows = page.getByTestId("profile-row");
    const rename = async (name: string) => { await page.getByTestId("profile-name").fill(name); await page.getByTestId("profile-name").press("Enter"); await expect(page.getByTestId("account-profile")).toHaveAttribute("title", new RegExp(name)); };

    await openProfilePage(page);
    await rename("Original");
    await createWallet(alice, "spark", "testnet", { timeout: 120_000 });
    await openWallet(alice, "spark-testnet");
    await expect(balance(alice)).toContainText("Regtest", { timeout: 120_000 });
    const address = (await panel(alice).getByTestId("spark-address").innerText()).trim();
    await expect.poll(breez, { timeout: 30_000 }).toHaveLength(1);
    const [original] = await breez();
    expect(original, "the original's wallet has its database").toBeTruthy();

    // The whole profile to a file, restored on this same device as a copy anyway.
    await openProfilePage(page);
    const backups = page.getByTestId("profile-backups");
    await backups.getByTestId("backup-open").click();
    await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
    await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
    const downloading = page.waitForEvent("download");
    await backups.getByTestId("backup-download").click();
    const file = await downloading;
    await backups.getByTestId("restore-open").click();
    await backups.getByTestId("restore-file").setInputFiles({ name: file.suggestedFilename(), mimeType: "application/octet-stream", buffer: readFileSync((await file.path())!) });
    await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
    await backups.getByTestId("restore-go").click();
    await backups.getByTestId("restore-same-device").getByTestId("restore-copy").click();
    await expect(page.getByTestId("profile-restored-tag")).toHaveText("Restored", { timeout: 60_000 });
    await rename("Copy");

    // The copy's Spark wallet: the same phrase, so the same address, from a database of its own.
    await openWallet(alice, "spark-testnet");
    await expect(balance(alice)).toContainText("Regtest", { timeout: 120_000 });
    await expect(panel(alice).getByTestId("spark-address")).toHaveText(address);
    await expect.poll(breez, { timeout: 30_000 }).toHaveLength(2);
    const copy = (await breez()).find((name) => name !== original)!;
    expect(await breez(), "the original's is still there, untouched").toContain(original);

    // Back to the original, which still opens its own, then the copy deleted: its database goes, the original's stays.
    await openProfilePage(page);
    await rows.filter({ hasText: "Original" }).getByTestId("profile-switch").click();
    await expect(page.getByTestId("profile-name")).toHaveValue("Original", { timeout: 30_000 });
    await openWallet(alice, "spark-testnet");
    await expect(panel(alice).getByTestId("spark-address")).toHaveText(address, { timeout: 120_000 });
    await openProfilePage(page);
    await rows.filter({ hasText: "Copy" }).getByTestId("profile-delete").click();
    const dialog = page.getByTestId("delete-profile");
    await dialog.getByTestId("delete-profile-confirm").fill("Copy");
    await dialog.getByTestId("delete-profile-go").click();
    await expect(dialog).toBeHidden();
    await expect(rows).toHaveCount(1);
    await expect.poll(breez).toEqual([original]);
    expect((await all()).filter((name) => name.startsWith(`${copy}/`)), "the SDK's -tree database went too").toEqual([]);
  });

  test.describe("Spark to Spark", () => {
    test.skip(!SPARK_REGTEST, "GHOSTLY_SPARK_REGTEST=1 and a funded GHOSTLY_SPARK_COUNTERPART run it (see e2e/README.md)");
    let funder: SparkCounterpart;
    test.beforeAll(async () => { test.setTimeout(3 * 60_000); funder = await sparkCounterpart(); });
    test.afterAll(async () => { await funder?.close(); });

    test("in on the address, a Send from the wallet, a Send and a Request in the chat, with both balances", { tag: ["@gated", "@feature:wallet.spark.send", "@feature:payments.spark.send", "@feature:payments.spark.offer", "@feature:wallet.instances.create"] }, async ({ peer }) => {
      test.setTimeout(10 * 60_000);
      const [alice, bob] = await Promise.all([peer("spark-alice", { offlineMainnet: true }), peer("spark-bob", { offlineMainnet: true })]);
      await link(alice, bob);
      await connect(alice, bob);
      const address: Record<string, string> = {};
      for (const p of [alice, bob]) {
        await createWallet(p, "spark", "testnet", { timeout: 120_000 });
        await openWallet(p, "spark-testnet");
        await expect(balance(p)).toContainText("Regtest", { timeout: 120_000 });
        address[p.name] = (await panel(p).getByTestId("spark-address").innerText()).trim();
        expect(address[p.name]).toMatch(/^sparkrt1/);
      }
      expect(address[alice.name]).not.toBe(address[bob.name]);

      // In: the funder pays Alice's Spark address, Spark to Spark.
      const funded = await funder.pay(address[alice.name], 10_000);
      await expect(balance(alice)).toHaveText(/^10,000\s*test sats/, { timeout: 120_000 });

      // A Send from the wallet page, to Bob's address.
      const send = async (from: Peer, to: string, amount: number) => {
        await openWallet(from, "spark-testnet");
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
      await openWallet(bob, "spark-testnet");
      await expect.poll(() => sats(bob), { timeout: 120_000 }).toBe(3_000);
      await expect(panel(bob).getByTestId("spark-history-row").first()).toContainText("+3,000Spark");

      // A Send in the chat: Bob's app asks Alice's for a Spark invoice, Bob approves; Alice's own wallet settles it.
      for (const p of [alice, bob]) await openChat(p);
      await composer(bob, "1500");
      await bob.page.getByTestId("payment-send").click();
      const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
      await expect(direct).toContainText("sparkrt1", { timeout: 60_000 });
      await direct.getByRole("button", { name: "Approve payment" }).click();
      // Gone out: the sheet closes, back to the chat, whose bubbles tell the rest.
      await expect(bob.page.getByTestId("payment-composer")).toHaveCount(0, { timeout: 90_000 });
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
      await openWallet(alice, "spark-testnet");
      await expect.poll(() => sats(alice), { timeout: 120_000 }).toBe(7_800);
      await openWallet(bob, "spark-testnet");
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
