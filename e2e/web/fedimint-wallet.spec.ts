import { execFileSync } from "node:child_process";
import { chat, connect, createWallet, expect, link, openChat, openWallet, test, walletCard, type Peer } from "../support/fixtures";
import { choose } from "../support/select";
import { composerRow } from "../support/composer";
import { paymentCard } from "../support/payments";

/**
 * Fedimint: federations joined by invite code, their ecash in the wallet and in chats, and Lightning through a
 * federation's gateway. A Fedimint wallet is made with New and an invite code; New makes no Mainnet one yet. Money moving needs e2e/infra's federation (a guardian, an LND
 * gateway and an LND peer with a channel to it: e2e/support/fedimint-regtest) and GHOSTLY_FEDIMINT_REGTEST=1.
 */
const panel = (p: Peer) => p.page.getByTestId("fedimint-wallet");
const sats = async (p: Peer) => Number((await panel(p).getByTestId("fedimint-balance").innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);

test("Fedimint joins nothing on Mainnet yet, and says so; on Testnet New asks for an invite code", { tag: ["@feature:wallet.fedimint.mainnet-off", "@feature:wallet.instances.create"] }, async ({ peer }) => {
  const alice = await peer("fedimint-mainnet");
  await openWallet(alice);
  await alice.page.getByTestId("wallet-add").click();
  const dialog = alice.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: "Mainnet" }).click();
  const fedimint = dialog.getByTestId("new-wallet-type-fedimint");
  await expect(fedimint).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByTestId("new-wallet-type-fedimint-status")).toHaveText("Not yet");
  await expect(fedimint).toContainText("Fedimint on Mainnet is not available yet");
  await fedimint.click({ force: true });
  await expect(dialog.getByTestId("new-wallet-invite")).toHaveCount(0);
  // In Testnet, nothing is joined for anyone: New waits for an invite code, and checks it.
  await dialog.getByRole("radio", { name: "Testnet" }).click();
  await expect(dialog.getByTestId("new-wallet-type-fedimint-status")).toHaveText("Join with invite…");
  await fedimint.click();
  await dialog.getByTestId("new-wallet-invite").fill("lnbc1notaninvite");
  await dialog.getByTestId("new-wallet-create").click();
  await expect(dialog.getByTestId("new-wallet-error")).toContainText("starts with fed1");
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(alice.page.locator("[data-testid^=wallet-card-fedimint-]")).toHaveCount(0);
});

test("Fedimint on regtest: join by invite, ecash in over the gateway, notes out and back, a Send and a Request in the chat, Lightning both ways", {
  tag: ["@gated", "@feature:wallet.instances.create", "@feature:wallet.fedimint.join", "@feature:wallet.fedimint.notes", "@feature:payments.fedimint.chat", "@feature:payments.fedimint.lightning", "@feature:wallet.lightning.fedimint"],
}, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_FEDIMINT_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_FEDIMINT_REGTEST=1");
  test.setTimeout(8 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/fedimint-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const { invite, federation } = JSON.parse(regtest("ready")) as { invite: string; federation: string };

  const [alice, bob] = await Promise.all([peer("fedimint-alice", { offlineMainnet: true }), peer("fedimint-bob", { offlineMainnet: true })]);
  await link(alice, bob);
  await connect(alice, bob);

  // Join: New with the invite code makes the Testnet Fedimint wallet; the federation's facts (name, guardians,
  // network) are then in its settings.
  for (const p of [alice, bob]) {
    await createWallet(p, "fedimint", "testnet", { invite, timeout: 120_000 });
    await openWallet(p, "fedimint-testnet");
    await expect(panel(p).getByTestId("fedimint-balance")).toHaveText(/^0\s*test sats/, { timeout: 90_000 });
    await expect(walletCard(p.page, "fedimint-testnet")).toContainText("Ready");
    const facts = panel(p).getByTestId("fedimint-facts");
    await expect(facts.getByTestId("fedimint-facts-network")).toHaveText("regtest");
    await expect(facts).toContainText(federation);
    // Soft: the joined federation loses the name and guardians its preview gave ("(none given)", "0: "); what
    // follows still runs.
    await expect.soft(facts.getByTestId("fedimint-facts-name")).toHaveText("Ghostly regtest", { timeout: 5_000 });
    await expect.soft(facts.getByTestId("fedimint-facts-guardians")).toContainText("1: ghostly-guardian", { timeout: 5_000 });
  }
  // Another invite, from the wallet's own page: the federation shows itself first (name, guardians, network).
  await panel(alice).getByTestId("fedimint-invite").fill(invite);
  await panel(alice).getByTestId("fedimint-preview").click();
  const preview = panel(alice).getByTestId("fedimint-preview-facts");
  await expect(preview.getByTestId("fedimint-preview-facts-name")).toHaveText("Ghostly regtest", { timeout: 90_000 });
  await expect(preview.getByTestId("fedimint-preview-facts-network")).toHaveText("regtest");
  await expect(preview.getByTestId("fedimint-preview-facts-guardians")).toContainText("1: ghostly-guardian");
  await expect(preview).toContainText(federation);
  await panel(alice).getByRole("button", { name: "Cancel", exact: true }).click();
  await panel(alice).getByTestId("fedimint-invite").fill("");

  // Ecash in over Lightning: the federation's gateway takes the peer's payment and issues it as ecash to Alice.
  await alice.page.getByTestId("wallet-receive").click();
  await panel(alice).getByTestId("fedimint-receive-amount").fill("20000");
  await panel(alice).getByTestId("fedimint-receive-invoice").click();
  const invoice = (await panel(alice).getByTestId("fedimint-invoice").innerText()).trim();
  expect(invoice).toMatch(/^lnbcrt200u/);
  const paidIn = JSON.parse(regtest("pay", invoice));
  expect(paidIn.status).toBe("SUCCEEDED");
  // The federation charges its fee on the way in (a few sats of 20,000).
  await expect.poll(() => sats(alice), { timeout: 90_000 }).toBeGreaterThan(19_900);
  const funded = await sats(alice);
  expect(funded).toBeLessThanOrEqual(20_000);

  // Notes out of the wallet page, redeemed by Bob from his; and notes taken back.
  await alice.page.getByTestId("wallet-send").click();
  await panel(alice).getByTestId("fedimint-send-amount").fill("1000");
  await panel(alice).getByTestId("fedimint-spend").click();
  const notes = (await panel(alice).getByTestId("fedimint-notes-out").innerText()).trim();
  expect(notes.length).toBeGreaterThan(100);
  await bob.page.getByTestId("wallet-receive").click();
  await panel(bob).getByTestId("fedimint-notes-in").fill(notes);
  await panel(bob).getByTestId("fedimint-redeem").click();
  await expect(panel(bob).getByTestId("fedimint-redeemed")).toHaveText("Redeemed 1,000 test sats.", { timeout: 90_000 });
  // Redeeming costs the federation's fee: the notes' face value, less a few sats.
  await expect.poll(() => sats(bob), { timeout: 30_000 }).toBeGreaterThan(990);
  await panel(alice).getByTestId("fedimint-send-amount").fill("500");
  await panel(alice).getByTestId("fedimint-spend").click();
  await expect(panel(alice).getByTestId("fedimint-notes-out")).toBeVisible();
  await expect.poll(() => sats(alice), { timeout: 30_000 }).toBe(funded - 1_500);
  await panel(alice).getByTestId("fedimint-take-back").click();
  // Taken back is reissued to Alice: the federation's fee on that, a few sats.
  await expect.poll(() => sats(alice), { timeout: 60_000 }).toBeGreaterThan(funded - 1_500);
  const afterNotes = await sats(alice);
  expect(afterNotes).toBeGreaterThanOrEqual(funded - 1_010);
  expect(afterNotes).toBeLessThanOrEqual(funded - 1_000);

  // A Send in the chat: Alice's app asks Bob's which federations it takes; they share this one, so she reviews ecash.
  for (const p of [alice, bob]) await openChat(p);
  await (await composerRow(alice.page, "payment-button")).click();
  // Both joined after they met: each chat is told, and the card meets the other's.
  await expect(paymentCard(alice.page, "fedimint-testnet")).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await paymentCard(alice.page, "fedimint-testnet").click();
  await alice.page.getByTestId("payment-amount").fill("3000");
  await alice.page.getByTestId("payment-send").click();
  const review = alice.page.getByTestId("payment-composer").getByTestId("payment-review");
  await expect(review).toContainText("fedimint", { timeout: 60_000 });
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "Sent you" }).last().getByTestId("payment-state")).toHaveText("Received", { timeout: 90_000 });
  await expect(review.getByTestId("review-status")).toHaveText("settled", { timeout: 60_000 });
  await alice.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();
  // The request Bob's app made for that ask is paid by the ecash his wallet redeemed.
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 60_000 });

  // Lightning through the federation: both make it their Lightning source, Bob requests on the Lightning card and
  // Alice pays his invoice (of the same federation's gateway: swapped inside the federation, no gateway fee).
  for (const p of [alice, bob]) {
    await openWallet(p, "fedimint-testnet");
    await panel(p).getByTestId("fedimint-use-lightning").click();
    await openWallet(p, "lightning-testnet");
    await expect(p.page.getByTestId("lightning-source").getByTestId("lightning-source-current")).toContainText("Fedimint", { timeout: 60_000 });
    await expect(p.page.getByTestId("lightning-source").getByTestId("lightning-source-status")).toContainText("Connected", { timeout: 60_000 });
    await openChat(p);
  }
  // No Cashu wallet on either side: the request carries the invoice alone.
  await (await composerRow(bob.page, "payment-button")).click();
  await expect(paymentCard(bob.page, "lightning-testnet")).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await paymentCard(bob.page, "lightning-testnet").click();
  await bob.page.getByTestId("payment-amount").fill("2000");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click({ timeout: 60_000 });
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });

  // Lightning out of the federation: Alice pays the LND peer's invoice from the Lightning card, the gateway routes it.
  const outside = JSON.parse(regtest("invoice", "3000")) as { payment_request: string; r_hash: string };
  await openWallet(alice, "lightning-testnet");
  await alice.page.getByTestId("wallet-send").click();
  await alice.page.getByTestId("wallet-pay-input").fill(outside.payment_request);
  await alice.page.getByRole("button", { name: "Pay 3,000 sats" }).click();
  await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(alice.page.getByTestId("wallet-notice")).toContainText(/Paid|pending/, { timeout: 90_000 });
  const hash = outside.r_hash;
  await expect.poll(() => JSON.parse(regtest("lookup", hash)).state, { timeout: 90_000 }).toBe("SETTLED");

  // Balances on both sides: after the notes, Alice paid 3,000 (chat) + 2,000 (request) + 3,000 (out) + the gateway's
  // fee on the last; Bob received 1,000 + 3,000 + 2,000, less the federation's fee on each redeem.
  await openWallet(alice, "fedimint-testnet");
  await expect.poll(() => sats(alice), { timeout: 60_000 }).toBeLessThan(afterNotes - 8_000);
  const aliceEnd = await sats(alice);
  expect(aliceEnd, "the gateway's fee on 3,000 sats is a few sats").toBeGreaterThan(afterNotes - 8_100);
  await openWallet(bob, "fedimint-testnet");
  await expect.poll(() => sats(bob), { timeout: 60_000 }).toBeGreaterThan(5_950);
  const bobEnd = await sats(bob);
  expect(bobEnd).toBeLessThanOrEqual(6_000);
  console.log("Fedimint regtest evidence:", JSON.stringify({ federation, invoiceIn: invoice.slice(0, 24), paidIn: paidIn.hash, funded, aliceEnd, bobEnd, afterNotes, out: { hash, fee: afterNotes - 8_000 - aliceEnd } }));
});

test.describe("choosing the Fedimint Lightning source", () => {
  test("New's Lightning source form lists joined federations only", { tag: ["@feature:wallet.lightning.fedimint", "@feature:wallet.instances.create"] }, async ({ peer }) => {
    const alice = await peer("fedimint-source", { offlineMainnet: true });
    await openWallet(alice);
    await alice.page.getByTestId("wallet-add").click();
    const dialog = alice.page.getByTestId("new-wallet");
    await dialog.getByRole("radio", { name: "Testnet" }).click();
    await dialog.getByTestId("new-wallet-type-lightning").click();
    const form = dialog.getByTestId("new-wallet-provider");
    await choose(form.getByTestId("new-wallet-provider-select"), "fedimint");
    await expect(form.getByTestId("provider-form-fedimint")).toContainText("Join a federation with a Lightning gateway on the Fedimint card first");
  });
});
