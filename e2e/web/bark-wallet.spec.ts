import { connect, createWallet, expect, link, openChat, openWallet, test, walletCard, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { chatPayments, closePayments, openPayments, paymentCard } from "../support/payments";

/**
 * Bark (Second's Ark) beside Arkade. New makes no Mainnet Bark wallet yet; a Testnet one starts on Second's public
 * signet server. Bark is its own way of paying: a chat offers it only when both sides allow it, and it never
 * stands in for Arkade (different Ark servers do not pay each other). Money moving: wallet-providers.spec.ts.
 */
const panel = (p: Peer) => p.page.getByTestId("bark-wallet");

test("Bark is not on Mainnet yet: New says so, with its reason, instead of making a wallet", { tag: ["@feature:wallet.bark.mainnet-off", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("bark-mainnet");
  await openWallet(alice);
  await alice.page.getByTestId("wallet-add").click();
  const dialog = alice.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  const bark = dialog.getByTestId("new-wallet-type-bark");
  await expect(bark).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByTestId("new-wallet-type-bark-status")).toHaveText("Not yet");
  await expect(bark).toContainText("Bark on Mainnet is not available yet");
  await expect(bark).toHaveAttribute("title", /not available yet/);
  await bark.click({ force: true });
  await expect(dialog.getByTestId("new-wallet-progress")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // Testnet offers it, in one click.
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await expect(dialog.getByTestId("new-wallet-type-bark-status")).toHaveText("One click");
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-bark-]")).toHaveCount(0);
});

test.describe("on Second's signet server", { tag: "@network" }, () => {
  test.describe.configure({ retries: 1 });

  test("New makes a Testnet Bark wallet on signet in one click: an address to receive, a balance, a recovery phrase", { tag: ["@feature:wallet.bark.create", "@feature:wallet.instances.create"] }, async ({ peer }) => {
    const alice = await peer("bark-signet");
    await createWallet(alice, "bark", "testnet");
    await openWallet(alice, "bark-testnet");
    await expect(panel(alice).getByTestId("bark-balance")).toContainText("Signet", { timeout: 90_000 });
    await expect(panel(alice).getByTestId("bark-balance")).toHaveText(/^0\s*test sats/);
    await expect(panel(alice).getByTestId("bark-address")).toHaveText(/tark1p[a-z0-9]{40,}/);
    await expect(walletCard(alice.page, "bark-testnet")).toContainText("Ready");
    await expect(walletCard(alice.page, "bark-testnet").getByTestId("wallet-card-network")).toHaveText("Testnet");
    await panel(alice).getByRole("button", { name: "Show", exact: true }).click();
    await expect(panel(alice).getByTestId("bark-recovery")).toHaveText(/^(\w+ ){11}\w+$/);
  });

  test("a chat offers Bark only when both sides allow it, and shows each side's choice", { tag: ["@feature:payments.bark.offer", "@feature:payments.chat.methods"] }, async ({ peer }) => {
    test.setTimeout(4 * 60_000);
    const [alice, bob] = await Promise.all([peer("bark-n-alice"), peer("bark-n-bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    // Testnet Bark and Arkade wallets on both sides, made with New after they met: each chat is told.
    for (const p of [alice, bob]) {
      await createWallet(p, "bark", "testnet");
      await createWallet(p, "arkade", "testnet");
      await openWallet(p, "bark-testnet");
      await expect(panel(p).getByTestId("bark-address")).toBeVisible({ timeout: 90_000 });
      await openChat(p);
    }
    const card = (p: Peer) => paymentCard(p.page, "bark-testnet");
    await (await composerRow(bob.page, "payment-button")).click();
    await expect(card(bob)).toBeEnabled({ timeout: 60_000 });
    await bob.page.keyboard.press("Escape");

    // Alice turns Bark off in this chat: Bob's app can no longer pick it, and says why.
    await chatPayments(alice.page, { bark: false });
    await (await composerRow(bob.page, "payment-button")).click();
    await expect(card(bob)).toBeDisabled({ timeout: 60_000 });
    // Soft: the reason is wrong today (it says she has no Testnet Bark wallet), and what follows still runs.
    await expect.soft(card(bob)).toHaveAttribute("title", /does not accept Bark/);
    await expect(paymentCard(bob.page, "arkade-testnet"), "Arkade is its own way of paying, still allowed").toBeEnabled();
    // Bob's Accept side says what Alice has off.
    await openPayments(bob.page, "accept");
    await expect(bob.page.getByTestId("payment-accept-bark-testnet")).toContainText("Contact: has it off");
    await closePayments(bob.page);
  });
});
