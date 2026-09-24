import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chat, expect, openChat, openWallet, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

test("paired chat: files, real WebRTC, local mint send/request and persistence", { tag: ["@feature:chat.paired.pair", "@feature:transport.webrtc", "@feature:files.paired.send", "@feature:files.persistence", "@feature:chat.paired.storage", "@feature:wallet.cashu.receive-lightning", "@feature:payments.chat.review", "@feature:payments.cashu.send", "@feature:payments.cashu.request", "@feature:wallet.history"] }, async ({ peer }) => {
  test.skip(!process.env.E2E_MINT_URL?.startsWith("http://127.0.0.1:"), "Requires an explicitly local fake mint");
  const [alice, bob] = await Promise.all([peer("paired-alice"), peer("paired-bob")]);
  await pair(alice, bob);
  const bytes = Buffer.alloc(1024 * 1024 + 13, 73);
  await alice.page.getByTestId("file-input").setInputFiles({ name: "paired.bin", mimeType: "application/octet-stream", buffer: bytes });
  const bubble = bob.page.getByTestId("file-bubble").filter({ hasText: "paired.bin" });
  await expect(bubble.getByTestId("file-save")).toBeVisible();
  const downloading = bob.page.waitForEvent("download"); await bubble.getByTestId("file-save").click();
  const received = readFileSync(await (await downloading).path());
  expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  for (const p of [alice, bob]) {
    await openWallet(p, "cashu");
    await p.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
    await expect(p.page.getByTestId("wallet-test-balance")).toBeVisible();
  }
  await alice.page.getByTestId("wallet-receive").click(); await alice.page.getByTestId("wallet-receive-amount").fill("100");
  await alice.page.getByTestId("wallet-create-invoice").click();
  await expect(alice.page.getByTestId("wallet-test-balance")).toHaveText(/^100 test sats/);
  for (const p of [alice, bob]) await openChat(p);
  await alice.page.getByTestId("payment-button").click(); await alice.page.getByTestId("payment-card-cashu").click(); await alice.page.getByTestId("payment-amount").fill("21");
  await alice.page.getByTestId("payment-send").click();
  // Every send is reviewed first: nothing leaves before the approval.
  await alice.page.getByTestId("payment-composer").getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  const payment = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state");
  for (const p of [alice, bob]) await expect(payment(p)).toHaveText(/Received/);
  await openWallet(bob, "cashu");
  await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^21 test sats/);
  await alice.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();
  await openChat(bob);
  // Ecash only: the fake mint pays a request's own Lightning invoice by itself and would race Alice.
  await bob.page.getByTitle("Options").click();
  await bob.page.getByTestId("chat-payments-open").click();
  await bob.page.getByTestId("chat-payments").getByTestId("chat-payments-lightning").click();
  await bob.page.getByTestId("chat-payments-save").click();
  await bob.page.getByTestId("payment-button").click(); await bob.page.getByTestId("payment-card-cashu").click(); await bob.page.getByTestId("payment-amount").fill("10"); await bob.page.getByTestId("payment-request").click();
  await alice.page.getByTestId("payment-pay").click();
  await chat(alice).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "equest" }).getByTestId("payment-state")).toHaveText(/Paid/);
  await openWallet(bob, "cashu");
  await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^31 test sats/);
  await openChat(bob);
  await alice.page.reload(); await bob.page.reload();
  for (const p of [alice, bob]) { await expect(payment(p)).toHaveText(/Received/); await expect(p.page.getByPlaceholder("Message…")).toBeEnabled(); }
  await expect(bubble.getByTestId("file-save")).toBeVisible();
  await openWallet(bob, "cashu");
  await expect(bob.page.getByTestId("wallet-test-balance")).toHaveText(/^31 test sats/);
  await bob.page.getByTestId("wallet-history").click();
  await expect(bob.page.getByTestId("wallet-tx").filter({ hasText: "Received ecash" })).toHaveCount(2);
  await openChat(bob);
  await expect(chat(bob).getByTestId("payment-bubble")).toHaveCount(3);
});
