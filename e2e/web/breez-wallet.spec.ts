import { BREEZ_TESTNET, counterpart, type Counterpart } from "../support/breez";
import { chat, connect, createWallet, expect, link, openChat, openWallet, test, type Peer } from "../support/fixtures";
import { choose, optionsOf, close } from "../support/select";
import { composerRow } from "../support/composer";
import { paymentCard } from "../support/payments";

/**
 * Breez (the nodeless Breez SDK, on Spark) as the Lightning source. Its wallet is Ghostly's to make: a
 * new one gets a recovery phrase shown once, an existing one is restored from its phrase. New offers it for a
 * Testnet Lightning wallet only for now (Breez's regtest); Mainnet needs an API key and is not offered yet.
 *
 * Money moving, on Breez's hosted regtest (no API key, worthless sats): GHOSTLY_BREEZ_TESTNET=1, with a
 * counterpart wallet run from Node (e2e/support/breez.ts). See e2e/README.md.
 */
const source = (p: Peer) => p.page.getByTestId("lightning-source");

test("Breez is offered for Testnet Lightning only, and its form makes or restores a wallet", { tag: ["@feature:wallet.lightning.breez.connect", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("breez-form");
  await openWallet(alice);
  await alice.page.getByTestId("wallet-add").click();
  const dialog = alice.page.getByTestId("new-wallet");
  const sources = dialog.getByTestId("new-wallet-provider-select");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  await dialog.getByTestId("new-wallet-type-lightning").click();
  await expect((await optionsOf(sources)).filter({ hasText: /Breez/ })).toHaveCount(0);
  await close(sources);

  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await dialog.getByTestId("new-wallet-type-lightning").click();
  await choose(sources, "breez");
  await expect(dialog.getByTestId("new-wallet-provider")).toContainText("self-custodial");
  const form = dialog.getByTestId("provider-form-breez");

  // A new wallet: twelve words, to be written down before it is used.
  await expect(form.getByTestId("breez-new-phrase").locator("li")).toHaveCount(12);
  const save = form.getByTestId("provider-save");
  await expect(save).toBeDisabled();
  await form.getByTestId("breez-phrase-written").check();
  await expect(save).toBeEnabled();
  await expect(form.getByLabel("Breez API key")).toHaveAttribute("type", "password");

  // Restoring: a phrase that is not BIP 39 is refused before anything is contacted.
  await form.getByRole("radio", { name: "Restore" }).click();
  await expect(save).toBeDisabled();
  await form.getByLabel("Recovery phrase").fill("ghost ghost ghost ghost ghost ghost ghost ghost ghost ghost ghost ghost");
  await expect(form.getByTestId("breez-phrase-invalid")).toBeVisible();
  await expect(save).toBeDisabled();
  await form.getByLabel("Recovery phrase").fill("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  await expect(form.getByTestId("breez-phrase-invalid")).toHaveCount(0);
  await expect(save).toBeEnabled();
  // Nothing was made: closing leaves no Lightning wallet.
  await alice.page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-lightning-]")).toHaveCount(0);
});

test.describe("on Breez's regtest", { tag: "@network" }, () => {
  test.skip(!BREEZ_TESTNET, "GHOSTLY_BREEZ_TESTNET=1 runs it (Breez's hosted regtest, see e2e/README.md)");
  let other: Counterpart;
  test.beforeAll(async () => { test.setTimeout(5 * 60_000); other = await counterpart(); });
  test.afterAll(async () => { await other?.close(); });

  const balance = (p: Peer) => p.page.getByTestId("wallet-balance");
  const sats = async (p: Peer) => Number((await balance(p).innerText()).replace(/[^\d]/g, "").match(/^\d+/)?.[0] ?? NaN);
  /** New → Testnet → Lightning with Breez, a new wallet: the phrase written down, then saved. */
  async function useBreez(p: Peer) {
    await createWallet(p, "lightning", "testnet", { provider: "breez", timeout: 120_000, fill: async (form) => {
      await form.getByTestId("breez-phrase-written").check();
      await form.getByTestId("provider-save").click();
    } });
    await openWallet(p, "lightning-testnet");
    await expect(source(p).getByTestId("lightning-source-status")).toContainText("Connected", { timeout: 90_000 });
    await expect(source(p).getByTestId("lightning-source-status")).toContainText("regtest");
    await expect(balance(p)).toHaveText(/^0\s*sats/, { timeout: 30_000 });
  }

  test("in from another wallet, out to it from Send, and a Request paid in the chat, with both balances", { tag: ["@feature:wallet.lightning.breez.pay", "@feature:wallet.lightning.breez.connect", "@feature:wallet.instances.create", "@gated"] }, async ({ peer }) => {
    test.setTimeout(8 * 60_000);
    const [alice, bob] = await Promise.all([peer("breez-alice"), peer("breez-bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) await useBreez(p);
    // Nothing of the recovery phrase is left in the page once it is sealed.
    expect(await alice.page.getByTestId("breez-new-phrase").count()).toBe(0);

    // In: an invoice of Alice's Breez wallet, paid by the counterpart.
    await alice.page.getByTestId("wallet-receive").click();
    await alice.page.getByTestId("wallet-receive-amount").fill("1000");
    await alice.page.getByTestId("wallet-create-invoice").click();
    const invoice = (await alice.page.getByTestId("wallet-invoice").innerText()).trim();
    expect(invoice).toMatch(/^lnbcrt10u1/);
    await other.pay(invoice);
    await expect(alice.page.getByTestId("wallet-paid")).toContainText("1,000 sats received", { timeout: 90_000 });
    await expect(balance(alice)).toHaveText(/^1,000\s*sats/, { timeout: 60_000 });

    // Out: Alice pays one of the counterpart's invoices from Send.
    const before = await other.balance();
    await alice.page.getByTestId("wallet-send").click();
    await alice.page.getByTestId("wallet-pay-input").fill(await other.invoice(200));
    await alice.page.getByRole("button", { name: "Pay 200 sats" }).click();
    await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
    await expect(alice.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 90_000 });
    await expect.poll(() => other.balance(), { timeout: 60_000 }).toBe(before + 200);
    await expect.poll(() => sats(alice), { timeout: 60_000 }).toBeLessThan(800);
    const afterSend = await sats(alice);
    expect(afterSend, "1,000 in, 200 out and a small fee").toBeGreaterThanOrEqual(780);

    // A Request in the chat: Bob's invoice comes from his Breez wallet. Alice pays it from her Lightning
    // card (the bubble's "Copy invoice"): her Breez wallet pays, Bob's sees it paid and settles the request.
    for (const p of [alice, bob]) await openChat(p);
    await (await composerRow(bob.page, "payment-button")).click();
    await expect(paymentCard(bob.page, "lightning-testnet")).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await paymentCard(bob.page, "lightning-testnet").click();
    await bob.page.getByTestId("payment-amount").fill("150");
    await bob.page.getByTestId("payment-request").click();
    const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" });
    await alice.page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Object.assign(window, { copiedInvoice: text }); } } }));
    await request.getByTitle("Pay it from another Lightning wallet").click();
    const requested = await alice.page.evaluate(() => (window as unknown as { copiedInvoice: string }).copiedInvoice);
    expect(requested).toMatch(/^lnbcrt1500n1/);
    await openWallet(alice, "lightning-testnet");
    await alice.page.getByTestId("wallet-send").click();
    await alice.page.getByTestId("wallet-pay-input").fill(requested);
    await alice.page.getByRole("button", { name: "Pay 150 sats" }).click();
    await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
    await expect(alice.page.getByTestId("wallet-notice")).toHaveText("Paid.", { timeout: 90_000 });
    await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).getByTestId("payment-state")).toHaveText("Paid", { timeout: 120_000 });

    // Both sides: Bob holds the 150, Alice has paid them and a small fee.
    await openWallet(bob, "lightning-testnet");
    await expect(balance(bob)).toHaveText(/^150\s*sats/, { timeout: 60_000 });
    await openWallet(alice, "lightning-testnet");
    await expect.poll(() => sats(alice), { timeout: 60_000 }).toBeLessThanOrEqual(afterSend - 150);
    expect(await sats(alice)).toBeGreaterThanOrEqual(afterSend - 150 - 20);
    await expect(source(alice).getByTestId("lightning-source-current")).toContainText("Breez");
    await expect(alice.page.getByTestId("lightning-recent").getByTestId("lightning-op").filter({ hasText: "Payment · 150 sats" })).toContainText("paid");
  });
});
