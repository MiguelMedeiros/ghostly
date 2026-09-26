import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chat, expect, getTestCoins, openChat, openWallet, test, useTestnet, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { chatPayments, paymentCard } from "../support/payments";

test("paired chat: files, real WebRTC, local mint send/request and persistence", { tag: ["@feature:chat.paired.pair", "@feature:transport.webrtc", "@feature:files.paired.send", "@feature:files.persistence", "@feature:chat.paired.storage", "@feature:wallet.cashu.receive-lightning", "@feature:payments.chat.review", "@feature:payments.cashu.send", "@feature:payments.cashu.request", "@feature:wallet.history"] }, async ({ peer }) => {
  test.skip(!process.env.E2E_MINT_URL?.startsWith("http://127.0.0.1:"), "Requires an explicitly local fake mint");
  const [alice, bob] = await Promise.all([peer("paired-alice"), peer("paired-bob")]);
  // A Testnet Cashu wallet each (a new profile has none), made with New before they pair.
  for (const p of [alice, bob]) await useTestnet(p);
  await pair(alice, bob);
  const bytes = Buffer.alloc(1024 * 1024 + 13, 73);
  await alice.page.getByTestId("file-input").setInputFiles({ name: "paired.bin", mimeType: "application/octet-stream", buffer: bytes });
  const bubble = bob.page.getByTestId("file-bubble").filter({ hasText: "paired.bin" });
  await expect(bubble.getByTestId("file-save")).toBeVisible();
  const downloading = bob.page.waitForEvent("download"); await bubble.getByTestId("file-save").click();
  const received = readFileSync(await (await downloading).path());
  expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  await getTestCoins(alice);
  await expect(alice.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);
  for (const p of [alice, bob]) await openChat(p);
  await (await composerRow(alice.page, "payment-button")).click(); await paymentCard(alice.page, "cashu-testnet").click(); await alice.page.getByTestId("payment-amount").fill("21");
  await alice.page.getByTestId("payment-send").click();
  // Every send is reviewed first: nothing leaves before the approval.
  await alice.page.getByTestId("payment-composer").getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  const payment = (p: Peer) => chat(p).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state");
  for (const p of [alice, bob]) await expect(payment(p)).toHaveText(/Received/);
  await openWallet(bob, "cashu-testnet");
  await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^21\s*test sats/);
  await alice.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();
  await openChat(bob);
  // Ecash only: the request is paid in ecash, reviewed.
  await chatPayments(bob.page, { lightning: false });
  await (await composerRow(bob.page, "payment-button")).click(); await paymentCard(bob.page, "cashu-testnet").click(); await bob.page.getByTestId("payment-amount").fill("10"); await bob.page.getByTestId("payment-request").click();
  await alice.page.getByTestId("payment-pay").click();
  await chat(alice).getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: "equest" }).getByTestId("payment-state")).toHaveText(/Paid/);
  await openWallet(bob, "cashu-testnet");
  await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^31\s*test sats/);
  await openChat(bob);
  await alice.page.reload(); await bob.page.reload();
  for (const p of [alice, bob]) { await expect(payment(p)).toHaveText(/Received/); await expect(p.page.getByPlaceholder("Message…")).toBeEnabled(); }
  await expect(bubble.getByTestId("file-save")).toBeVisible();
  await openWallet(bob, "cashu-testnet");
  await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^31\s*test sats/);
  await bob.page.getByTestId("wallet-history").click();
  await expect(bob.page.getByTestId("wallet-tx").filter({ hasText: "Received ecash" })).toHaveCount(2);
  await openChat(bob);
  await expect(chat(bob).getByTestId("payment-bubble")).toHaveCount(3);
});
