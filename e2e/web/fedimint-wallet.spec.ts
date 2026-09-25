import { execFileSync } from "node:child_process";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { choose } from "../support/select";

/**
 * Fedimint: federations joined by invite code, their ecash in the wallet and in chats, and Lightning through a
 * federation's gateway. Mainnet joins nothing yet. Money moving needs e2e/infra's federation (a guardian, an LND
 * gateway and an LND peer with a channel to it: e2e/support/fedimint-regtest) and GHOSTLY_FEDIMINT_REGTEST=1.
 */
const panel = (p: Peer) => p.page.getByTestId("fedimint-wallet");
const sats = async (p: Peer) => Number((await panel(p).getByTestId("fedimint-balance").innerText()).trim().match(/^[\d,]*/)![0].replace(/,/g, "") || NaN);

test("Fedimint joins nothing on Mainnet yet, and says so", { tag: ["@feature:wallet.fedimint.mainnet-off"] }, async ({ peer }) => {
  const alice = await peer("fedimint-mainnet");
  await openWallet(alice, "fedimint");
  await expect(alice.page.getByTestId("wallet-card-fedimint")).toContainText("Testnet only");
  await expect(panel(alice).getByTestId("fedimint-unavailable")).toContainText("not available yet");
  await expect(panel(alice).getByTestId("fedimint-invite")).toHaveCount(0);
  // In Testnet, nothing is joined for anyone: the card waits for an invite code.
  await useTestnet(alice);
  await openWallet(alice, "fedimint");
  await expect(alice.page.getByTestId("wallet-card-fedimint")).toContainText("No federation");
  await expect(panel(alice).getByTestId("fedimint-empty")).toBeVisible();
  await panel(alice).getByTestId("fedimint-invite").fill("lnbc1notaninvite");
  await panel(alice).getByTestId("fedimint-preview").click();
  await expect(panel(alice).getByRole("alert")).toContainText("starts with fed1");
});

test("Fedimint on regtest: join by invite, ecash in over the gateway, notes out and back, a Send and a Request in the chat, Lightning both ways", {
  tag: ["@gated", "@feature:wallet.fedimint.join", "@feature:wallet.fedimint.notes", "@feature:payments.fedimint.chat", "@feature:payments.fedimint.lightning", "@feature:wallet.lightning.fedimint"],
}, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_FEDIMINT_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_FEDIMINT_REGTEST=1");
  test.setTimeout(8 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/fedimint-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const { invite, federation } = JSON.parse(regtest("ready")) as { invite: string; federation: string };

  const [alice, bob] = await Promise.all([peer("fedimint-alice", { offlineMainnet: true }), peer("fedimint-bob", { offlineMainnet: true })]);
  await link(alice, bob);
  await connect(alice, bob);

  // Join: the federation shows itself first (name, guardians, network), then the person joins.
  for (const p of [alice, bob]) {
    await useTestnet(p);
    await openWallet(p, "fedimint");
    await panel(p).getByTestId("fedimint-invite").fill(invite);
    await panel(p).getByTestId("fedimint-preview").click();
    const facts = panel(p).getByTestId("fedimint-preview-facts");
    await expect(facts.getByTestId("fedimint-preview-facts-name")).toHaveText("Ghostly regtest", { timeout: 90_000 });
    await expect(facts.getByTestId("fedimint-preview-facts-network")).toHaveText("regtest");
    await expect(facts.getByTestId("fedimint-preview-facts-guardians")).toContainText("1: ghostly-guardian");
    await expect(facts).toContainText(federation);
    await panel(p).getByTestId("fedimint-join").click();
    await expect(panel(p).getByTestId("fedimint-balance")).toHaveText(/^0\s*sats/, { timeout: 90_000 });
    await expect(p.page.getByTestId("wallet-card-fedimint")).toContainText("Ready");
  }

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
  await expect(panel(bob).getByTestId("fedimint-redeemed")).toHaveText("Redeemed 1,000 sats.", { timeout: 90_000 });
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
  await alice.page.getByTestId("payment-button").click();
  await alice.page.getByTestId("payment-card-fedimint").click();
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
    await openWallet(p, "fedimint");
    await panel(p).getByTestId("fedimint-use-lightning").click();
    await openWallet(p, "lightning");
    await expect(p.page.getByTestId("lightning-source").getByTestId("lightning-source-current")).toContainText("Fedimint", { timeout: 60_000 });
    await expect(p.page.getByTestId("lightning-source").getByTestId("lightning-source-status")).toContainText("Connected", { timeout: 60_000 });
    await openChat(p);
  }
  // Cashu off in this chat: both have the public test mint, and a request would carry ecash beside the invoice.
  await bob.page.getByTitle("Options").click();
  await bob.page.getByTestId("chat-payments-open").click();
  await bob.page.getByTestId("chat-payments").getByTestId("chat-payments-cashu").click();
  await bob.page.getByTestId("chat-payments-save").click();
  await bob.page.getByTestId("payment-button").click();
  await bob.page.getByTestId("payment-card-lightning").click();
  await bob.page.getByTestId("payment-amount").fill("2000");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click({ timeout: 60_000 });
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });

  // Lightning out of the federation: Alice pays the LND peer's invoice from the Lightning card, the gateway routes it.
  const outside = JSON.parse(regtest("invoice", "3000")) as { payment_request: string; r_hash: string };
  await openWallet(alice, "lightning");
  await alice.page.getByTestId("wallet-send").click();
  await alice.page.getByTestId("wallet-pay-input").fill(outside.payment_request);
  await alice.page.getByRole("button", { name: "Pay 3,000 sats" }).click();
  await alice.page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(alice.page.getByTestId("wallet-notice")).toContainText(/Paid|pending/, { timeout: 90_000 });
  const hash = outside.r_hash;
  await expect.poll(() => JSON.parse(regtest("lookup", hash)).state, { timeout: 90_000 }).toBe("SETTLED");

  // Balances on both sides: after the notes, Alice paid 3,000 (chat) + 2,000 (request) + 3,000 (out) + the gateway's
  // fee on the last; Bob received 1,000 + 3,000 + 2,000, less the federation's fee on each redeem.
  await openWallet(alice, "fedimint");
  await expect.poll(() => sats(alice), { timeout: 60_000 }).toBeLessThan(afterNotes - 8_000);
  const aliceEnd = await sats(alice);
  expect(aliceEnd, "the gateway's fee on 3,000 sats is a few sats").toBeGreaterThan(afterNotes - 8_100);
  await openWallet(bob, "fedimint");
  await expect.poll(() => sats(bob), { timeout: 60_000 }).toBeGreaterThan(5_950);
  const bobEnd = await sats(bob);
  expect(bobEnd).toBeLessThanOrEqual(6_000);
  console.log("Fedimint regtest evidence:", JSON.stringify({ federation, invoiceIn: invoice.slice(0, 24), paidIn: paidIn.hash, funded, aliceEnd, bobEnd, afterNotes, out: { hash, fee: afterNotes - 8_000 - aliceEnd } }));
});

test.describe("choosing the Fedimint Lightning source", () => {
  test("the source form lists joined federations only", { tag: ["@feature:wallet.lightning.fedimint"] }, async ({ peer }) => {
    const alice = await peer("fedimint-source", { offlineMainnet: true });
    await useTestnet(alice);
    await openWallet(alice, "lightning");
    const source = alice.page.getByTestId("lightning-source");
    await choose(source.getByTestId("lightning-source-select"), "fedimint");
    await expect(source.getByTestId("provider-form-fedimint")).toContainText("Join a federation with a Lightning gateway on the Fedimint card first");
  });
});
