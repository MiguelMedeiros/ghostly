import { FakeNwcWallet, TestRelay } from "../../packages/browser/test/helpers/fakeNwc";
import { createWallet, expect, openWallet, test, type Peer } from "../support/fixtures";
import { choose } from "../support/select";

/**
 * Connecting a wallet ends where it started, with no extra click: New closes by itself once the wallet is made and
 * its card is in front of its network's tab, selected, with the focus on it; a card's Source → Change source closes
 * its form and shows the new source as the one in use.
 *  - Always: a fake NWC wallet service on a relay in this test process.
 *  - GHOSTLY_NWC_REGTEST=1: the Alby Hubs of e2e/infra, on regtest Lightning.
 */

/** Wallets → New → Testnet → Lightning → NWC, the URI pasted and submitted; the dialog. */
async function connectWithNew(p: Peer, uri: string) {
  await openWallet(p);
  await p.page.getByTestId("wallet-add").click();
  const dialog = p.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await dialog.getByTestId("new-wallet-type-lightning").click();
  await choose(dialog.getByTestId("new-wallet-provider-select"), "nwc");
  await dialog.getByTestId("provider-form-nwc").getByLabel("Connection URI").fill(uri);
  await dialog.getByTestId("provider-save").click();
  return dialog;
}

/** Closed, the card in front on the Testnet tab and focused, its source the NWC wallet. */
async function expectShown(p: Peer, alias: string | RegExp) {
  const card = p.page.getByTestId("wallet-card-lightning-testnet");
  await expect(p.page.getByTestId("new-wallet")).toHaveCount(0, { timeout: 30_000 });
  await expect(p.page.getByTestId("wallet-network-testnet")).toHaveAttribute("aria-selected", "true");
  await expect(card).toHaveAttribute("aria-selected", "true");
  await expect(card).toBeFocused();
  await expect(p.page.getByTestId("wallet-panel-title")).toContainText("Lightning");
  const source = p.page.getByTestId("lightning-source");
  await expect(source.getByTestId("lightning-source-current")).toContainText("Nostr Wallet Connect");
  await expect(source.getByTestId("lightning-source-status")).toContainText(alias);
}

test.describe("with a fake NWC wallet", () => {
  let relay: TestRelay;
  test.beforeAll(async () => { relay = await TestRelay.start(); });
  test.afterAll(async () => { await relay.close(); });

  test("New closes once the wallet is connected and shows its card selected; a refused one keeps the dialog", { tag: ["@feature:wallet.instances.create", "@feature:wallet.lightning.nwc.connect"] }, async ({ peer }) => {
    const [mainnet, wallet] = [await FakeNwcWallet.start(relay.url, { network: "mainnet" }), await FakeNwcWallet.start(relay.url, { alias: "Fake hub" })];
    try {
      const alice = await peer("connect-close-fake");
      await createWallet(alice, "cashu", "testnet");
      // Refused (a wallet on real Bitcoin as a Testnet source): the dialog stays, with the error and the form.
      const dialog = await connectWithNew(alice, mainnet.uri());
      await expect(dialog.getByTestId("new-wallet-error")).toContainText("Nothing was saved", { timeout: 30_000 });
      await expect(dialog.getByTestId("provider-form-nwc")).toBeVisible();
      // Fixed and sent again from the same form: connected, closed, shown.
      await dialog.getByTestId("provider-form-nwc").getByLabel("Connection URI").fill(wallet.uri());
      await dialog.getByTestId("provider-save").click();
      await expectShown(alice, "Fake hub");
    } finally { await mainnet.close(); await wallet.close(); }
  });
});

test.describe("on regtest Lightning", () => {
  test.skip(process.env.GHOSTLY_NWC_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_NWC_REGTEST=1");
  test.describe.configure({ timeout: 120_000 });

  test("an Alby Hub connected with New, then another from the card's settings: each ends shown as the source in use", { tag: ["@gated", "@feature:wallet.instances.create", "@feature:wallet.lightning.nwc.connect", "@feature:wallet.lightning.sources"] }, async ({ peer }) => {
    const regtest = await import("../support/nwc-regtest/regtest.mjs");
    await regtest.ready();
    const [aliceUri, bobUri] = [await regtest.nwcUri("alice", { fresh: true }), await regtest.nwcUri("bob", { fresh: true })];
    const alice = await peer("connect-close-regtest");
    await connectWithNew(alice, aliceUri);
    await expectShown(alice, /Connected · alice via/);

    // Settings → Change source → another hub: the form closes and the new one is in use, saying so.
    const source = alice.page.getByTestId("lightning-source");
    await choose(source.getByTestId("lightning-source-select"), "nwc");
    await source.getByTestId("provider-form-nwc").getByLabel("Connection URI").fill(bobUri);
    await source.getByTestId("provider-save").click();
    await expect(source.getByTestId("lightning-source-saved")).toHaveText("Nostr Wallet Connect is now your Lightning source.", { timeout: 30_000 });
    await expect(source.getByTestId("lightning-source-config")).toHaveCount(0);
    await expect(source.getByTestId("lightning-source-status")).toContainText(/Connected · bob via/);
    await expect(alice.page.getByTestId("wallet-card-lightning-testnet")).toHaveAttribute("aria-selected", "true");
  });
});
