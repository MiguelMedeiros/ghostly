import { connect, createWallet, expect, link, openChat, openWallet, test, walletCard, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";
import { chatPayments, closePayments, openPayments, paymentCard } from "../support/payments";

/**
 * Bark (Second's Ark) beside Arkade. A Mainnet wallet is made on Second's Bitcoin server (never reached from here: it
 * is routed), a Testnet one on their public signet server. Bark is its own way of paying: a chat offers it only when both sides allow it, and it never
 * stands in for Arkade (different Ark servers do not pay each other). Money moving: wallet-providers.spec.ts.
 */
const panel = (p: Peer) => p.page.getByTestId("bark-wallet");

/**
 * Second's Bitcoin server and its Esplora, never reached from a test: each request is counted and `answer` decides
 * (refused, or passed to Second's signet server, which answers as signet).
 */
async function guardMainnetBark(p: Peer, answer: "refuse" | "signet") {
  const seen: string[] = [];
  await p.context.route(/^https:\/\/(ark|mempool)\.second\.tech\//, async (route) => {
    const url = new URL(route.request().url());
    seen.push(`${url.host}${url.pathname}`);
    if (answer === "refuse") return route.abort("connectionrefused");
    const to = url.host === "ark.second.tech" ? `https://ark.signet.2nd.dev${url.pathname}` : `https://esplora.signet.2nd.dev${url.pathname.replace(/^\/api/, "")}${url.search}`;
    return route.fulfill({ response: await route.fetch({ url: to }) });
  });
  return seen;
}
/** New → Mainnet → Bark, one click; what the dialog says after. */
async function createMainnetBark(p: Peer) {
  await openWallet(p);
  await p.page.getByTestId("wallet-add").click();
  const dialog = p.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  await expect(dialog.getByTestId("new-wallet-type-bark-status")).toHaveText("Create");
  await expect(dialog.getByTestId("new-wallet-type-bark")).toContainText("Second's Ark on Bitcoin. Second's terms apply; start small.");
  await dialog.getByTestId("new-wallet-type-bark").click();
  return dialog;
}

test("Bark on Mainnet: New offers it in one click and checks Second's server first; one that does not answer leaves nothing", { tag: ["@feature:wallet.bark.mainnet", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("bark-mainnet");
  const seen = await guardMainnetBark(alice, "refuse");
  const dialog = await createMainnetBark(alice);
  await expect(dialog.getByTestId("new-wallet-error")).toBeVisible({ timeout: 90_000 });
  await expect(dialog.getByTestId("new-wallet-retry")).toBeVisible();
  expect(seen.some((s) => s.startsWith("ark.second.tech/")), "the SDK asked for the server").toBe(true);
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-bark-]")).toHaveCount(0);
});

test("a Mainnet Bark wallet refuses a server on another network: a signet server where Second's Bitcoin one should be", { tag: ["@network", "@feature:wallet.bark.mainnet"] }, async ({ peer }) => {
  test.slow();
  const alice = await peer("bark-mainnet-signet");
  const seen = await guardMainnetBark(alice, "signet");
  const dialog = await createMainnetBark(alice);
  await expect(dialog.getByTestId("new-wallet-error")).toContainText(/network|bitcoin/i, { timeout: 90_000 });
  expect(seen.length).toBeGreaterThan(0);
  await alice.page.keyboard.press("Escape");
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
