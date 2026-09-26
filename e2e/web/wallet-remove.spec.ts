import { chat, connect, createWallet, expect, link, openChat, openWallet, showNetwork, test, useFakeProviders, useTestnet, walletCard, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { mockMainnetMints } from "../support/mint";
import { paymentCard } from "../support/payments";

/**
 * A wallet is removed from its details: Remove, a dialog that says what it holds and on which network, and a
 * confirmation. Real money and test money sit under their own tabs. Test coins only: Mainnet runs against the suite's
 * own mint (mockMainnetMints), whose sats are worthless.
 */

test("the Wallets page keeps real money and test money apart, and an empty network says so with New", { tag: ["@feature:wallet.instances.sections"] }, async ({ peer }) => {
  const alice = await peer("remove-sections");
  await createWallet(alice, "cashu", "testnet");
  const page = alice.page;
  const mainnet = page.getByTestId("wallet-network-mainnet"), testnet = page.getByTestId("wallet-network-testnet");
  // Test money only: its tab is the one open, with its two cards; Mainnet's says it has none.
  await expect(mainnet).toHaveText(/Real money\s*Mainnet\s*· 0/);
  await expect(testnet).toHaveText(/Test money\s*Testnet\s*· 2/);
  await expect(testnet).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Testnet wallets" }).getByRole("tab")).toHaveCount(2);
  await mainnet.click();
  const empty = page.getByTestId("wallet-network-mainnet-empty");
  await expect(empty).toHaveText(/No Mainnet wallets yet\./);
  await expect(page.getByTestId("wallet-panel")).toHaveCount(0);
  // New in the empty tab opens on its network.
  await empty.getByTestId("wallet-network-mainnet-new").click();
  const dialog = page.getByTestId("new-wallet");
  await expect(dialog.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
  await expect(dialog.getByTestId("new-wallet-network-mainnet")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("an empty Testnet wallet goes on one confirm, and is still gone after a reload; the other network's stays", { tag: ["@feature:wallet.instances.remove", "@feature:wallet.instances.sections"] }, async ({ peer }) => {
  const alice = await peer("remove-empty");
  await mockMainnetMints(alice.context);
  await useFakeProviders(alice);
  await createWallet(alice, "cashu", "mainnet");
  await createWallet(alice, "bitcoin", "testnet", { provider: "fake-onchain", fill: async (form) => {
    await form.getByLabel("Access token").fill("token");
    await form.getByTestId("provider-save").click();
  } });
  const page = alice.page;
  await openWallet(alice, "bitcoin-testnet");
  await page.getByTestId("wallet-remove").click();
  const dialog = page.getByTestId("wallet-remove-dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Remove your Testnet Bitcoin wallet?");
  await expect(dialog.getByTestId("wallet-remove-network")).toHaveText("Test money");
  // Its money is with its source, not on this device: nothing to back up here, nothing to confirm in words.
  await expect(dialog.getByTestId("wallet-remove-held")).toContainText("Ghostly only forgets how to reach it");
  await expect(dialog.getByTestId("wallet-remove-understood")).toHaveCount(0);
  await dialog.getByTestId("wallet-remove-confirm").click();
  await expect(dialog).toHaveCount(0);
  await expect(walletCard(page, "bitcoin-testnet")).toHaveCount(0);
  // Its tab stays open, saying it has none now.
  await expect(page.getByTestId("wallet-network-testnet")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("wallet-network-testnet-empty")).toBeVisible();

  // After a reload the page opens where the wallets are: Mainnet's card, and Testnet still empty.
  await page.reload();
  await openWallet(alice);
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible();
  await showNetwork(page, "testnet");
  await expect(walletCard(page, "bitcoin-testnet")).toHaveCount(0);
  await expect(page.getByTestId("wallet-network-testnet-empty")).toBeVisible();
  // It can be made again.
  await page.getByTestId("wallet-add").click();
  await page.getByTestId("new-wallet").getByRole("radio", { name: "Testnet" }).click();
  await expect(page.getByTestId("new-wallet-type-bitcoin-status")).toHaveText("Connect…");
});

test("a funded wallet says how much and on which network, offers its ecash, and goes only once the loss is confirmed", { tag: ["@network", "@feature:wallet.instances.remove"] }, async ({ peer }) => {
  const alice = await peer("remove-funded");
  await mockMainnetMints(alice.context);
  await createWallet(alice, "cashu", "testnet");
  await createWallet(alice, "cashu", "mainnet");
  const page = alice.page;
  // Sats in over Lightning, from the suite's own mint (worthless, self-settling), into the Mainnet card.
  await openWallet(alice, "cashu-mainnet");
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("50");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-paid")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await page.getByTestId("wallet-balance").innerText()).trim(), { timeout: 15_000 }).toMatch(/^50\s*sats/);

  await page.getByTestId("wallet-remove").click();
  const dialog = page.getByTestId("wallet-remove-dialog");
  await expect(dialog.getByTestId("wallet-remove-network")).toHaveText("Real money");
  await expect(dialog.getByTestId("wallet-remove-held")).toHaveText("It holds 50 sats on Mainnet, real money.");
  await expect(dialog.getByTestId("wallet-remove-copy-tokens")).toBeVisible();
  await expect(dialog.getByTestId("wallet-remove-consent")).toHaveText("I understand: these 50 sats are real money, and they become unreachable without this wallet's backup.");
  const confirm = dialog.getByTestId("wallet-remove-confirm");
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId("wallet-remove-understood").check();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(walletCard(page, "cashu-mainnet")).toHaveCount(0);
  await expect(walletCard(page, "lightning-mainnet"), "Lightning through those mints went with them").toHaveCount(0);

  await page.reload();
  await openWallet(alice);
  // The page opens where the wallets are now: Testnet, whose Cashu wallet is untouched; Mainnet has none.
  await expect(walletCard(page, "cashu-testnet")).toBeVisible();
  await showNetwork(page, "mainnet");
  await expect(walletCard(page, "cashu-mainnet")).toHaveCount(0);
  await expect(page.getByTestId("wallet-network-mainnet-empty")).toBeVisible();
});

test("a wallet holding nothing with an open chat request lists it, asks in words, and the request closes on both sides", { tag: ["@network", "@feature:wallet.instances.remove"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("remove-request-a"), peer("remove-request-b")]);
  for (const p of [alice, bob]) await useTestnet(p);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await openChat(p);

  // Bob asks for 10 test sats: the invoice is a quote at his Testnet Cashu mint, and his wallet holds nothing.
  await (await composerRow(bob.page, "payment-button")).click();
  await paymentCard(bob.page, "cashu-testnet").click();
  await bob.page.getByTestId("payment-amount").fill("10");
  await bob.page.getByTestId("payment-request").click();
  const bubble = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "10" });
  await expect(bubble(alice).getByTestId("payment-state")).toHaveText("Waiting for payment");

  await openWallet(bob, "cashu-testnet");
  await bob.page.getByTestId("wallet-remove").click();
  const dialog = bob.page.getByTestId("wallet-remove-dialog");
  await expect(dialog.getByTestId("wallet-remove-held")).toHaveText("It holds nothing.");
  // Its money could still arrive: the request is listed, and removing needs the loss confirmed in words.
  await expect(dialog.getByTestId("wallet-remove-awaiting-item")).toHaveText(["A request for 10 test sats in a chat, still open"]);
  await expect(dialog.getByTestId("wallet-remove-awaiting-note")).toHaveText("Removing the wallet closes its open requests, and your contacts are told. Anything paid to them afterwards is lost. To keep it, wait until they are paid or have expired.");
  await expect(dialog.getByTestId("wallet-remove-consent")).toHaveText("I understand: anything paid to its open requests and invoices after it is removed is lost.");
  const confirm = dialog.getByTestId("wallet-remove-confirm");
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId("wallet-remove-understood").check();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(walletCard(bob.page, "cashu-testnet")).toHaveCount(0);

  // Closed on both sides: Alice is told, and her bubble offers nothing to pay it with, not even another wallet.
  await openChat(bob);
  await expect(bubble(bob).getByTestId("payment-state")).toHaveText("Closed · you removed the Testnet Cashu wallet it was paid to");
  await expect(bubble(alice).getByTestId("payment-state")).toHaveText("Closed · your contact removed the wallet it was paid to");
  await expect(bubble(alice).getByTestId("payment-pay")).toHaveCount(0);
  await expect(bubble(alice).getByTestId("payment-external")).toHaveCount(0);
});
