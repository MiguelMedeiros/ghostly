import { createWallet, expect, openWallet, test, useFakeProviders, walletCard } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";

/**
 * A wallet is removed from its details: Remove, a dialog that says what it holds and on which network, and a
 * confirmation. Real money and test money sit in their own decks. Test coins only: Mainnet runs against the suite's
 * own mint (mockMainnetMints), whose sats are worthless.
 */

test("the Wallets page keeps real money and test money apart, and an empty network says so with New", { tag: ["@feature:wallet.instances.sections"] }, async ({ peer }) => {
  const alice = await peer("remove-sections");
  await createWallet(alice, "cashu", "testnet");
  const page = alice.page;
  const mainnet = page.getByTestId("wallet-section-mainnet"), testnet = page.getByTestId("wallet-section-testnet");
  await expect(mainnet.getByRole("heading")).toHaveText(/Real money\s*· Mainnet/);
  await expect(testnet.getByRole("heading")).toHaveText(/Test money\s*· Testnet/);
  await expect(mainnet.getByTestId("wallet-section-mainnet-empty")).toHaveText(/No Mainnet wallets yet\./);
  await expect(testnet.getByRole("tablist", { name: "Testnet wallets" }).getByRole("tab")).toHaveCount(2);
  // New in the empty section opens on its network.
  await mainnet.getByTestId("wallet-section-mainnet-new").click();
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
  await expect(page.getByTestId("wallet-section-testnet-empty")).toBeVisible();

  await page.reload();
  await openWallet(alice);
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible();
  await expect(walletCard(page, "bitcoin-testnet")).toHaveCount(0);
  await expect(page.getByTestId("wallet-section-testnet-empty")).toBeVisible();
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
  await expect(walletCard(page, "cashu-mainnet")).toHaveCount(0);
  await expect(page.getByTestId("wallet-section-mainnet-empty")).toBeVisible();
  // The Testnet Cashu wallet is untouched.
  await expect(walletCard(page, "cashu-testnet")).toBeVisible();
});
