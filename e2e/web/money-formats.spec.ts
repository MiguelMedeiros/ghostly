import { execFileSync } from "node:child_process";
import { BDK_REGTEST } from "../support/bdk-regtest/regtest.mjs";
import { chat, connect, expect, link, openChat, openWallet, say, test, useTestnet, type Peer } from "../support/fixtures";
import { choose } from "../support/select";
import { BARK_TESTNET, arkadeAddress, bcrt1q, bolt12Offer } from "../../src/test/payments/moneyFormatFixtures";

/**
 * Money formats pasted into a chat (parser v2, card 4), test coins only:
 *  - offline: a regtest Bitcoin address, a BOLT 12 offer and Ark addresses each show their card, saying Test money
 *    in words; with no wallet of that network the card says so and Create leads to the Wallets page;
 *  - GHOSTLY_BDK_REGTEST=1 (e2e/infra's regtest chain): a pasted `bitcoin:` link to a regtest address is paid from
 *    the reader's BDK regtest wallet, through the review, and the transaction pays the link's address and amount.
 */

const card = (p: Peer, testId: string) => chat(p).getByTestId(testId).last();

test("a pasted regtest address, BOLT 12 offer and Ark addresses show their cards as Test money", { tag: ["@feature:payments.money.onchain-card", "@feature:payments.money.bolt12-card", "@feature:payments.money.ark-card", "@feature:payments.money.network"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("money-cards-a"), peer("money-cards-b")]);
  await link(alice, bob);
  await connect(alice, bob);

  await say(bob, `my regtest address ${bcrt1q(9)}`);
  const onchain = card(alice, "onchain-bubble");
  await expect(onchain.getByTestId("money-network")).toHaveText(/Test money\s*· regtest/);
  await expect(onchain.getByTestId("money-detail")).toHaveText(bcrt1q(9));
  // No Testnet Bitcoin wallet here: said, not offered from another network, and one click away.
  await expect(onchain.getByTestId("money-no-wallet")).toContainText("You have no Testnet Bitcoin wallet to pay this test money.");
  await expect(onchain.getByTestId("onchain-pay")).toHaveCount(0);

  await say(bob, bolt12Offer({ chains: ["regtest"], amountMsat: 21_000_000, description: "Coffee" }));
  const offer = card(alice, "bolt12-bubble");
  await expect(offer.getByTestId("money-network")).toHaveText(/Test money\s*· regtest/);
  await expect(offer.getByTestId("money-amount")).toHaveText("21,000");
  await expect(offer).toContainText("Pay it with a wallet that supports BOLT 12 offers");

  await say(bob, `bark: ${BARK_TESTNET}`);
  await expect(card(alice, "ark-bubble")).toContainText("Ark address (Bark)");
  await expect(card(alice, "ark-bubble").getByTestId("money-network")).toHaveText(/Test money/);
  await say(bob, arkadeAddress("tark"));
  await expect(card(alice, "ark-bubble")).toContainText("Ark address (Arkade)");

  // The chat list says what the last message is, in words.
  await expect(alice.page.getByTestId("chat-row").first()).toContainText("Ark address · Test money");

  await card(alice, "onchain-bubble").getByTestId("money-create-wallet").click();
  await expect(alice.page.getByTestId("wallet")).toBeVisible();
});

test("BDK on regtest: a pasted bitcoin: link is paid from the regtest wallet after the review", { tag: ["@gated", "@feature:payments.money.onchain-card", "@feature:payments.money.network", "@feature:payments.chat.review"] }, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_BDK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_BDK_REGTEST=1");
  test.setTimeout(5 * 60_000);
  const regtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bdk-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  regtest("ready");
  const [alice, bob] = await Promise.all([peer("money-bdk-a"), peer("money-bdk-b")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Alice: a BDK wallet on regtest, funded by the miner.
  const panel = alice.page.getByTestId("bitcoin-wallet");
  await useTestnet(alice);
  await openWallet(alice, "bitcoin");
  await choose(panel.getByTestId("onchain-source-select"), "bdk");
  const form = panel.getByTestId("provider-form-bdk");
  await panel.getByTestId("bdk-written").check();
  await choose(form.getByLabel("Network"), "regtest");
  await form.getByLabel("Esplora server").fill(BDK_REGTEST.esplora);
  await form.getByTestId("provider-save").click();
  await expect(panel.getByTestId("onchain-source-status")).toContainText(/Connected · BDK BIP84 · [0-9a-f]{8} · regtest/, { timeout: 60_000 });
  await panel.getByTestId("bitcoin-new-address").click();
  regtest("send", (await panel.getByTestId("bitcoin-address").innerText()).trim(), "100000");
  await expect.poll(async () => { await panel.getByRole("button", { name: "Refresh now" }).click(); return panel.getByTestId("bitcoin-balance").innerText(); }, { timeout: 90_000, intervals: [3_000] }).toContain("100,000");
  await openChat(alice);

  // Bob pastes a payment link to an address of the miner's (someone outside the chat).
  const payee = regtest("address");
  expect(payee).toMatch(/^bcrt1/);
  await say(bob, `please pay bitcoin:${payee}?amount=0.00025&message=Lunch`);
  const onchain = card(alice, "onchain-bubble");
  await expect(onchain.getByTestId("money-network")).toHaveText(/Test money\s*· regtest/);
  await expect(onchain.getByTestId("money-amount")).toHaveText("25,000");
  await expect(onchain).toContainText("test sats");
  await expect(onchain).toContainText("Lunch");

  // Pay → the fee limit → the usual review. Nothing leaves before Approve.
  await onchain.getByTestId("onchain-pay").click();
  await onchain.getByTestId("money-review").click();
  const review = onchain.getByTestId("payment-review");
  await expect(review).toContainText("bitcoin · regtest", { timeout: 60_000 });
  await expect(review).toContainText(payee);
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(review.getByTestId("review-status")).toHaveText(/submitted|settled/, { timeout: 60_000 });
  await review.getByText("Payment details").click();
  const txid = (await review.locator("dt:text-is('Transaction') + dd").innerText()).trim();
  expect(txid).toMatch(/^[0-9a-f]{64}$/);
  const onChain = JSON.parse(regtest("tx", txid)) as { vout: { sats: number; address: string }[] };
  expect(onChain.vout).toContainEqual({ sats: 25_000, address: payee });
  regtest("mine", "1");
  await expect(review.getByTestId("review-status")).toHaveText("settled", { timeout: 90_000 });
  console.log("money-formats BDK evidence:", JSON.stringify({ payee, txid }));
});
