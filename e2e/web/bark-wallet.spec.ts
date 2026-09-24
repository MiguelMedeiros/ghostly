import { connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";

/**
 * Bark (Second's Ark) beside Arkade. Mainnet has no Bark wallet yet; Testnet starts one on Second's public
 * signet server. Bark is its own way of paying: a chat offers it only when both sides allow it, and it never
 * stands in for Arkade (different Ark servers do not pay each other). Money moving: wallet-providers.spec.ts.
 */
const panel = (p: Peer) => p.page.getByTestId("bark-wallet");

test("Bark is not on Mainnet yet, and says so instead of making a wallet", { tag: ["@feature:wallet.bark.mainnet-off"] }, async ({ peer }) => {
  const alice = await peer("bark-mainnet");
  await openWallet(alice, "bark");
  await expect(alice.page.getByTestId("wallet-card-bark")).toContainText("Testnet only");
  await expect(panel(alice).getByTestId("bark-unavailable")).toContainText("not available yet");
  await expect(panel(alice).getByTestId("bark-address")).toHaveCount(0);
});

test.describe("on Second's signet server", { tag: "@network" }, () => {
  test.describe.configure({ retries: 1 });

  test("Testnet opens a Bark wallet on signet by itself: an address to receive, a balance, a recovery phrase", { tag: ["@feature:wallet.bark.create"] }, async ({ peer }) => {
    const alice = await peer("bark-signet");
    await useTestnet(alice);
    await openWallet(alice, "bark");
    await expect(panel(alice).getByTestId("bark-balance")).toContainText("Signet", { timeout: 90_000 });
    await expect(panel(alice).getByTestId("bark-balance")).toHaveText(/^0\s*sats/);
    await expect(panel(alice).getByTestId("bark-address")).toHaveText(/tark1p[a-z0-9]{40,}/);
    await expect(alice.page.getByTestId("wallet-card-bark")).toContainText("Ready");
    await panel(alice).getByRole("button", { name: "Show", exact: true }).click();
    await expect(panel(alice).getByTestId("bark-recovery")).toHaveText(/^(\w+ ){11}\w+$/);
  });

  test("a chat offers Bark only when both sides allow it, and shows each side's choice", { tag: ["@feature:payments.bark.offer", "@feature:payments.chat.methods"] }, async ({ peer }) => {
    test.setTimeout(4 * 60_000);
    const [alice, bob] = await Promise.all([peer("bark-n-alice"), peer("bark-n-bob")]);
    await link(alice, bob);
    await connect(alice, bob);
    for (const p of [alice, bob]) {
      await useTestnet(p);
      await openWallet(p, "bark");
      await expect(panel(p).getByTestId("bark-address")).toBeVisible({ timeout: 90_000 });
      await openChat(p);
    }
    const card = (p: Peer) => p.page.getByTestId("payment-card-bark");
    await bob.page.getByTestId("payment-button").click();
    await expect(card(bob)).toBeEnabled({ timeout: 60_000 });
    await bob.page.keyboard.press("Escape");

    // Alice turns Bark off in this chat: Bob's app can no longer pick it, and says why.
    await alice.page.getByTitle("Options").click();
    await alice.page.getByTestId("chat-payments-open").click();
    await alice.page.getByTestId("chat-payments").getByTestId("chat-payments-bark").click();
    await alice.page.getByTestId("chat-payments-save").click();
    await bob.page.getByTestId("payment-button").click();
    await expect(card(bob)).toBeDisabled({ timeout: 60_000 });
    await expect(card(bob)).toHaveAttribute("title", /does not accept Bark/);
    await expect(bob.page.getByTestId("payment-card-arkade"), "Arkade is its own way of paying, still allowed").toBeEnabled();
    await bob.page.keyboard.press("Escape");
    await bob.page.getByTitle("Options").click();
    await bob.page.getByTestId("chat-payments-open").click();
    await expect(bob.page.getByTestId("chat-payments-bark-contact")).toContainText("has it off");
  });
});
