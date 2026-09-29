import { createWallet, expect, openWallet, test, walletCard } from "../support/fixtures";

// Wallets made with New, on Testnet, can receive right away, and come back by themselves after a reload: the same
// address, no password, no form. Talks to the public test servers (Mutinynet's Ark server, a Sepolia RPC) and the
// suite's test mint, and never moves funds.
test("a wallet made with New is ready to receive, and opens again by itself after a reload", { tag: ["@network", "@feature:wallet.ready", "@feature:wallet.instances.create", "@feature:wallet.ark.create", "@feature:wallet.usdt.create"] }, async ({ peer }, testInfo) => {
  // Sepolia's public RPC can take a minute to answer a new wallet.
  test.setTimeout(4 * 60_000);
  const alice = await peer("wallets-ready");
  const page = alice.page;
  const card = (id: Parameters<typeof walletCard>[1]) => walletCard(page, id);
  for (const kind of ["cashu", "arkade", "usdt"] as const) await createWallet(alice, kind, "testnet", { timeout: 120_000 });

  await expect(card("cashu-testnet")).toContainText("Ready");
  await expect(card("arkade-testnet")).toContainText("0 test sats", { timeout: 60_000 });
  await expect(card("arkade-testnet")).toContainText("Ready");
  await expect(card("usdt-testnet")).toContainText("0 TEST-USDT", { timeout: 60_000 });
  await expect(card("usdt-testnet")).toContainText("Ready");
  for (const id of ["cashu-testnet", "arkade-testnet", "usdt-testnet"] as const) await expect(card(id).getByTestId("wallet-card-network"), id).toHaveText("Testnet");

  // Cashu / Lightning: the test mint issues an invoice to receive on.
  await card("cashu-testnet").click();
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("100");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-invoice")).toHaveText(/^lnbc/, { timeout: 30_000 });

  // Ark on Mutinynet and USDT on Sepolia: an address to receive on, no password, no form.
  await card("arkade-testnet").click();
  const ark = page.getByTestId("ark-wallet");
  await expect(card("arkade-testnet")).toContainText("mutinynet");
  await expect(ark.getByTestId("ark-address")).toHaveText(/^\s*tark1/, { timeout: 30_000 });
  const arkAddress = (await ark.getByTestId("ark-address").innerText()).trim();
  await page.getByTestId("wallet-send").click();
  await expect(ark.getByRole("button", { name: "No balance to send yet" })).toBeDisabled();
  await card("usdt-testnet").click();
  const usdt = page.getByTestId("usdt-wallet");
  await expect(usdt.getByTestId("usdt-address")).toHaveText(/^\s*0x/, { timeout: 30_000 });
  const usdtAddress = (await usdt.getByTestId("usdt-address").innerText()).trim();
  expect(usdtAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await expect(usdt.getByTestId("usdt-balance")).toHaveText("0 TEST-USDT");
  await page.screenshot({ path: testInfo.outputPath("wallets-ready.png"), fullPage: true });

  // Reopening the app brings back the same wallets, still without a prompt, and New has nothing to make again.
  await page.reload();
  await openWallet(alice);
  await expect(page.getByTestId("wallet-first")).toHaveCount(0);
  await card("arkade-testnet").click();
  // Reconnecting to the public Ark server can take a while when it is busy.
  await expect(ark.getByTestId("ark-balance")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("wallet-receive").click();
  await expect(ark.getByTestId("ark-address")).toHaveText(arkAddress, { timeout: 60_000 });
  await card("usdt-testnet").click();
  await expect(usdt.getByTestId("usdt-address")).toHaveText(usdtAddress, { timeout: 60_000 });
  await expect(page.getByLabel("Ark wallet password")).toHaveCount(0);
  await expect(page.getByLabel("USDT wallet password")).toHaveCount(0);
  await page.getByTestId("wallet-add").click();
  const dialog = page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  for (const kind of ["cashu", "arkade", "usdt"]) await expect(dialog.getByTestId(`new-wallet-type-${kind}-status`), kind).toHaveText("Added");
});
