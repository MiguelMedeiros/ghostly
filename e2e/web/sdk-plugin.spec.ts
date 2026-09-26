import { schnorr } from "@noble/curves/secp256k1.js";
import { createWallet, expect, openWallet, test, walletCard } from "../support/fixtures";
import { choose, optionsOf, close } from "../support/select";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Adapters written outside the app, against @ghostly/sdk alone (examples/sdk-adapter), compiled into
 * this build with GHOSTLY_PLUGINS (playwright.config.ts). The gate of docs/wisps/ADAPTER-ROADMAP.md:
 * an independently authored adapter, in the pickers, doing its job. Nothing here reaches a network.
 */
test("a plugin's Lightning source and identity proof show in the pickers and work", { tag: ["@feature:sdk.plugin.lightning", "@feature:sdk.plugin.identity", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("sdk-plugin");
  const page = alice.page;
  await openWallet(alice);
  await page.getByTestId("wallet-add").click();
  const dialog = page.getByTestId("new-wallet");
  // Regtest only: not a Mainnet Lightning source, whatever the plugin says.
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  await dialog.getByTestId("new-wallet-type-lightning").click();
  const sources = dialog.getByTestId("new-wallet-provider-select");
  await expect((await optionsOf(sources)).filter({ hasText: "Paper Lightning" })).toHaveCount(0);
  await close(sources);
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await dialog.getByTestId("new-wallet-type-lightning").click();
  await choose(sources, "paper-lightning");
  await expect(dialog.getByTestId("new-wallet-provider")).toContainText("An example source built with the SDK");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // New → Testnet → Lightning with the plugin's source: the form is all it asks.
  await createWallet(alice, "lightning", "testnet", { provider: "paper-lightning", fill: async (form) => {
    await form.getByLabel("Name").fill("Paper node");
    await form.getByLabel("Ticket").fill("twenty-one-characters");
    await form.getByTestId("provider-save").click();
  } });
  await expect(walletCard(page, "lightning-testnet")).toContainText("Via Paper node");
  await expect(walletCard(page, "lightning-testnet").getByTestId("wallet-card-network")).toHaveText("Testnet");
  await openWallet(alice, "lightning-testnet");
  const source = page.getByTestId("lightning-source");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Paper Lightning (SDK example)");
  await expect(source.getByTestId("lightning-source-status")).toContainText("Connected");
  // 1,000 sats per character of the ticket, and the ticket itself is sealed in the engine: never back in the page.
  await expect(page.getByTestId("wallet-balance")).toContainText("21,000");
  expect(await page.content()).not.toContain("twenty-one-characters");

  // An invoice of the plugin's source, seen paid through it.
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("21");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbcrt/);
  await expect(page.getByTestId("wallet-paid")).toContainText("21 sats received", { timeout: 30_000 });
  await expect(page.getByTestId("wallet-balance")).toContainText("21,021");

  // The identity proof: signed outside Ghostly with a BIP-340 key held by this test, pasted back.
  const secret = schnorr.utils.randomSecretKey();
  await page.evaluate(() => { location.hash = "#/identities"; });
  await page.getByTestId("identities-new").click();
  const add = page.getByTestId("add-identity");
  await add.getByTestId("add-identity-example-schnorr").click();
  await choose(add.getByTestId("add-identity-signer"), "paste");
  await add.getByTestId("add-identity-subject").fill(hex(schnorr.getPublicKey(secret)));
  await add.getByTestId("add-identity-start").click();
  const statement = await add.getByTestId("add-identity-copy-0").textContent();
  expect(statement).toMatch(/^Ghostly identity proof v1: I control example-schnorr:[a-f0-9]{64} and authorize the Ghostly key /);
  await add.getByTestId("add-identity-paste").fill(hex(schnorr.sign(new TextEncoder().encode(`${statement}\n`), secret)));
  await add.getByTestId("add-identity-finish").click();
  await expect(add.getByTestId("add-identity-error")).toHaveText(/does not match/);
  await add.getByTestId("add-identity-paste").fill(hex(schnorr.sign(new TextEncoder().encode(statement!), secret)));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
  await expect(page.getByTestId("identity-proof")).toHaveCount(1);
  await expect(page.getByTestId("identity-proof")).toContainText("Schnorr key (SDK example)");
});
