import { execFileSync } from "node:child_process";
import { chat, connect, expect, link, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { composerRow } from "../support/composer";

// Opt-in, local regtest only. Every profile and seed belongs to this test.
test("Ark request, explicit approval and receipt in the chat", { tag: ["@feature:payments.arkade.request", "@feature:payments.arkade.send", "@feature:payments.chat.review", "@gated"] }, async ({ peer }, testInfo) => {
  test.skip(process.env.GHOSTLY_ARK_REGTEST !== "1", "Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_ARK_REGTEST=1");
  const mnemonic = execFileSync(process.execPath, ["--experimental-eventsource", "e2e/support/fund-ark.mjs"], { encoding: "utf8", stdio: "pipe" }).trim();

  const [alice, bob] = await Promise.all([peer("ark-alice", { offlineMainnet: true }), peer("ark-bob", { offlineMainnet: true })]);
  await link(alice, bob);
  await connect(alice, bob);
  const panel = (p: Peer) => p.page.getByTestId("ark-wallet");
  const balance = (p: Peer) => panel(p).getByTestId("ark-balance");
  // Test networks belong to the Testnet mode; there an empty wallet may move to the local regtest server.
  for (const p of [alice, bob]) {
    await useTestnet(p);
    await openWallet(p, "arkade");
    await panel(p).getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 60000 });
    await expect(balance(p)).toContainText("Regtest", { timeout: 60000 });
    if (p === alice) {
      await panel(p).getByRole("button", { name: "Restore", exact: true }).click();
      await panel(p).getByLabel("Recovery phrase", { exact: true }).fill(mnemonic);
      await panel(p).getByRole("button", { name: "Restore from phrase", exact: true }).click();
    }
    await expect(panel(p).getByTestId("ark-address")).toBeVisible();
  }
  await expect(balance(alice)).toHaveText(/^9,900\s*sats/, { timeout: 30000 });
  await expect(balance(bob)).toHaveText(/^0\s*sats/);
  // In the chat: pick the Ark card, type the amount, request.
  for (const p of [alice, bob]) await openChat(p);
  await (await composerRow(bob.page, "payment-button")).click();
  await bob.page.getByTestId("payment-card-arkade").click();
  // The card turns over: its back is where the amount goes.
  await expect(bob.page.getByTestId("payment-back")).toContainText("Ark");
  await expect(bob.page.getByTestId("payment-send"), "nothing to send yet").toBeDisabled();
  await bob.page.getByTestId("payment-amount").fill("1000");
  await bob.page.getByTestId("payment-request").click();
  const request = chat(alice).getByTestId("payment-bubble").filter({ hasText: "Requests" });
  await expect(request).toContainText("Ark · regtest");
  await request.getByTestId("payment-pay").click();
  const review = request.getByTestId("payment-review");
  await expect(review).toContainText("arkade · regtest");
  await expect(review).toContainText("pending");
  await review.getByRole("button", { name: "Approve payment" }).click();
  await expect(review).toContainText("settled");
  await expect(request.getByTestId("payment-state")).toHaveText("Paid");
  await expect(review.getByRole("button", { name: "Approve payment" })).toHaveCount(0);
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "You requested" }).getByTestId("payment-state")).toHaveText("Paid");
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "Sent you" }).getByTestId("payment-state")).toHaveText("Received");
  await alice.page.screenshot({ path: testInfo.outputPath("ark-chat-payer.png"), fullPage: true });
  await openWallet(bob, "arkade");
  await expect(balance(bob)).toHaveText(/^1,000\s*sats/, { timeout: 30000 });
  await openWallet(alice, "arkade");
  await expect(balance(alice)).not.toHaveText(/^9,900/);
  await bob.page.screenshot({ path: testInfo.outputPath("ark-wallet-recipient.png"), fullPage: true });

  // Send, with no request: Bob's app asks Alice's for a fresh Ark address, then waits for his approval.
  for (const p of [alice, bob]) await openChat(p);
  await (await composerRow(bob.page, "payment-button")).click();
  await bob.page.getByTestId("payment-card-arkade").click();
  await bob.page.getByTestId("payment-amount").fill("400");
  await bob.page.getByTestId("payment-send").click();
  const direct = bob.page.getByTestId("payment-composer").getByTestId("payment-review");
  await expect(direct).toContainText("arkade · regtest", { timeout: 60000 });
  await direct.getByRole("button", { name: "Approve payment" }).click();
  await expect(direct).toContainText("settled", { timeout: 60000 });
  await expect(chat(alice).getByTestId("payment-bubble").filter({ hasText: "400" }).filter({ hasText: "Sent you" }).getByTestId("payment-state")).toHaveText("Received", { timeout: 60000 });
  await openWallet(bob, "arkade");
  await expect(balance(bob)).toHaveText(/^600\s*sats/, { timeout: 30000 });
});
