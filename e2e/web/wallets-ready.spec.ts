import { expect, openWallet, test } from "../support/fixtures";

// A brand-new profile, no setup: every wallet can receive right away. Talks to the real default
// providers (a Cashu mint, arkade.computer, an Ethereum RPC) but never moves funds.
test("a new profile has every wallet ready to receive, and they reopen without asking anything", async ({ peer }, testInfo) => {
  const alice = await peer("wallets-ready");
  const page = alice.page;
  const card = (id: string) => page.getByTestId(`wallet-card-${id}`);
  await openWallet(alice);

  await expect(card("cashu")).toContainText("Ready");
  await expect(card("arkade")).toContainText("0 sats", { timeout: 60000 });
  await expect(card("arkade")).toContainText("Ready");
  await expect(card("usdt")).toContainText("0 USDT", { timeout: 60000 });
  await expect(card("usdt")).toContainText("Ready");

  // Cashu / Lightning: the default mint issues an invoice to receive on.
  await card("cashu").click();
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("100");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-invoice")).toHaveText(/^lnbc/, { timeout: 30000 });

  // Ark on Bitcoin and USDT on Ethereum: an address to receive on, no password, no form.
  await card("arkade").click();
  const ark = page.getByTestId("ark-wallet");
  await expect(card("arkade")).toContainText("Bitcoin");
  await expect(ark.getByTestId("ark-address")).toHaveText(/^\s*ark1/, { timeout: 30000 });
  const arkAddress = (await ark.getByTestId("ark-address").innerText()).trim();
  expect(arkAddress).toMatch(/^ark1/);
  await page.getByTestId("wallet-send").click();
  await expect(ark.getByRole("button", { name: "No balance to send yet" })).toBeDisabled();
  await card("usdt").click();
  const usdt = page.getByTestId("usdt-wallet");
  await expect(usdt.getByTestId("usdt-address")).toHaveText(/^\s*0x/, { timeout: 30000 });
  const usdtAddress = (await usdt.getByTestId("usdt-address").innerText()).trim();
  expect(usdtAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await expect(usdt.getByTestId("usdt-balance")).toHaveText("0 USDT");
  await page.screenshot({ path: testInfo.outputPath("wallets-ready.png"), fullPage: true });

  // Reopening the app brings back the same wallets, still without a prompt.
  await page.reload();
  await openWallet(alice);
  await card("arkade").click();
  // Reconnecting to the public Ark server can take a while when it is busy.
  await expect(ark.getByTestId("ark-balance")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("wallet-receive").click();
  await expect(ark.getByTestId("ark-address")).toHaveText(arkAddress, { timeout: 60000 });
  await card("usdt").click();
  await expect(usdt.getByTestId("usdt-address")).toHaveText(usdtAddress, { timeout: 60000 });
  await expect(page.getByLabel("Ark wallet password")).toHaveCount(0);
  await expect(page.getByLabel("USDT wallet password")).toHaveCount(0);
});
