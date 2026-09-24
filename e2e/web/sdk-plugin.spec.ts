import { schnorr } from "@noble/curves/secp256k1.js";
import { expect, openWallet, test, useTestnet } from "../support/fixtures";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Adapters written outside the app, against @ghostly/sdk alone (examples/sdk-adapter), compiled into
 * this build with GHOSTLY_PLUGINS (playwright.config.ts). The gate of docs/wisps/ADAPTER-ROADMAP.md:
 * an independently authored adapter, in the pickers, doing its job. Nothing here reaches a network.
 */
test("a plugin's Lightning source and identity proof show in the pickers and work", { tag: ["@feature:sdk.plugin.lightning", "@feature:sdk.plugin.identity"] }, async ({ peer }) => {
  const alice = await peer("sdk-plugin");
  const page = alice.page;
  await openWallet(alice, "lightning");
  const source = page.getByTestId("lightning-source");
  // Regtest only: not offered in Mainnet, whatever the plugin says.
  await expect(source.getByTestId("lightning-source-select").locator("option").filter({ hasText: "Paper Lightning" })).toHaveCount(0);

  await useTestnet(alice);
  await openWallet(alice, "lightning");
  await source.getByTestId("lightning-source-select").selectOption("paper-lightning");
  const form = source.getByTestId("provider-form-paper-lightning");
  await expect(source.getByTestId("lightning-source-config")).toContainText("An example source built with the SDK");
  await form.getByLabel("Name").fill("Paper node");
  await form.getByLabel("Ticket").fill("twenty-one-characters");
  await form.getByTestId("provider-save").click();
  await expect(source.getByTestId("lightning-source-saved")).toBeVisible();
  await expect(source.getByTestId("lightning-source-current")).toContainText("Paper Lightning (SDK example)");
  await expect(source.getByTestId("lightning-source-status")).toContainText("Connected");
  await expect(page.getByTestId("wallet-card-lightning")).toContainText("Via Paper node");
  // 1,000 sats per character of the ticket, and the ticket itself is sealed in the engine: never back in the page.
  await expect(page.getByTestId("wallet-balance")).toContainText("21,000");
  expect(await page.content()).not.toContain("twenty-one-characters");

  // An invoice of the plugin's source, seen paid through it.
  await page.getByTestId("wallet-receive").click();
  await page.getByTestId("wallet-receive-amount").fill("21");
  await page.getByTestId("wallet-create-invoice").click();
  await expect(page.getByTestId("wallet-invoice")).toHaveText(/^\s*lnbcrt/);
  await expect(page.getByTestId("wallet-paid")).toContainText("21 test sats received", { timeout: 30_000 });
  await expect(page.getByTestId("wallet-balance")).toContainText("21,021");

  // The identity proof: signed outside Ghostly with a BIP-340 key held by this test, pasted back.
  const secret = schnorr.utils.randomSecretKey();
  await page.evaluate(() => { location.hash = "#/identities"; });
  await page.getByTestId("identity-add").click();
  const add = page.getByTestId("add-identity");
  await add.getByTestId("add-identity-example-schnorr").click();
  await add.getByTestId("add-identity-signer").selectOption("paste");
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
