import { chat, connect, createWallet, expect, getTestCoins, link, openChat, test, useTestnet } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";
import { closePayments, openPayments, paymentCard, paymentNetwork } from "../support/payments";

/**
 * The chat's payment sheet shows one network's cards at a time, under Mainnet | Testnet tabs (the Wallets page's):
 * on Pay and on Accept. A payment sent or a request made closes it, back to the chat; one that fails keeps it. Alice has Cashu on both networks (her Mainnet mints answered by the suite's own mint, so no
 * real money moves); Bob has Testnet Cashu only. The tab only filters: Alice pays test sats on the Testnet card, and
 * her Accept switches are saved per network.
 */

const mainnetCards = "[data-testid^=payment-card-][data-testid$=-mainnet]", testnetCards = "[data-testid^=payment-card-][data-testid$=-testnet]";

test("the payment sheet's Mainnet | Testnet tabs: one network's cards on Pay and Accept, a Testnet payment, switches kept per network", {
  tag: ["@network", "@feature:payments.chat.cards", "@feature:payments.chat.networks", "@feature:payments.chat.methods", "@feature:payments.cashu.send", "@feature:payments.cashu.request"],
}, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("tabs-alice", { viewport: { width: 1280, height: 900 } }), peer("tabs-bob")]);
  await mockMainnetMints(alice.context);
  await createWallet(alice, "cashu", "mainnet");
  await createWallet(alice, "cashu", "testnet");
  await useTestnet(bob);
  await getTestCoins(alice);
  await link(alice, bob);
  await connect(alice, bob);
  await openChat(alice);
  await openChat(bob);
  const { page } = alice;
  const sheet = page.getByTestId("payment-composer");

  // Bob takes test money only: the sheet opens on Testnet, with Testnet's cards alone.
  await openPayments(page);
  await expect(page.getByTestId("payment-tab-testnet")).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
  await expect(sheet.locator(testnetCards)).toHaveCount(2);
  await expect(sheet.locator(mainnetCards)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sheet-testnet-desktop.png"), animations: "disabled" });

  // The keyboard moves along the tabs; Mainnet has its own deck, and says Bob has no wallet there.
  await page.getByTestId("payment-tab-testnet").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("payment-tab-mainnet")).toBeFocused();
  await expect(page.getByTestId("payment-tab-mainnet")).toHaveAttribute("aria-selected", "true");
  await expect(sheet.locator(testnetCards)).toHaveCount(0);
  await expect(paymentCard(page, "cashu-mainnet")).toHaveAttribute("title", /Your contact has no Mainnet Cashu wallet/, { timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("sheet-mainnet-desktop.png"), animations: "disabled" });

  // Test sats on the Testnet card: the deck trap, the card clicked before the amount.
  await paymentNetwork(page, "testnet");
  await paymentCard(page, "cashu-testnet").click();
  await page.getByTestId("payment-amount").fill("21");
  await page.getByTestId("payment-send").click();
  const review = sheet.getByTestId("payment-review");
  await expect(review.getByTestId("review-network")).toHaveText("Test money");
  await review.getByRole("button", { name: "Approve payment" }).click();
  // Sent: the sheet closes, back to the chat with the keyboard on the message field; the bubble tells the rest.
  await expect(sheet).toHaveCount(0);
  await expect(page.getByPlaceholder("Message…")).toBeFocused();
  await expect(chat(alice).getByTestId("payment-bubble").filter({ hasText: "21" })).toBeVisible();
  await expect(chat(bob).getByTestId("payment-bubble").filter({ hasText: "21" }).getByTestId("payment-state")).toHaveText(/Received/, { timeout: 60_000 });

  // A request made closes the sheet too, and its bubble is in both chats.
  await openPayments(page);
  await paymentCard(page, "cashu-testnet").click();
  await page.getByTestId("payment-amount").fill("5");
  await page.getByTestId("payment-request").click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByPlaceholder("Message…")).toBeFocused();
  for (const p of [alice, bob]) await expect(chat(p).getByTestId("payment-bubble").filter({ hasText: /\b5\s*test sats/ })).toBeVisible({ timeout: 60_000 });

  // A request that fails (the mint does not answer) keeps the sheet, with the error, to try again.
  const refuse = /^https:\/\/testnut\.cashu\.space\/v1\/mint\/quote/;
  await alice.context.route(refuse, (route) => route.abort("connectionrefused"));
  await openPayments(page);
  await paymentCard(page, "cashu-testnet").click();
  await page.getByTestId("payment-amount").fill("6");
  await page.getByTestId("payment-request").click();
  await expect(sheet.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("payment-request")).toBeEnabled();
  await alice.context.unroute(refuse);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveAttribute("data-side", "cards");
  await closePayments(page);

  // Accept: Lightning off on Testnet, Cashu off on Mainnet, one Save for both tabs.
  await openPayments(page, "accept");
  await expect(page.getByTestId("payment-tab-testnet"), "the chat's last network").toHaveAttribute("aria-selected", "true");
  await page.getByTestId("payment-accept-lightning-testnet").click();
  await paymentNetwork(page, "mainnet");
  await page.getByTestId("payment-accept-cashu-mainnet").click();
  await paymentNetwork(page, "testnet");
  await expect(page.getByTestId("payment-accept-lightning-testnet"), "kept while Mainnet was shown").toHaveAttribute("aria-checked", "false");
  await page.getByTestId("payment-accept-save").click();
  await expect(page.getByTestId("payment-accept-status")).toHaveAttribute("data-state", "saved");
  await closePayments(page);

  // After a reload, each network's switches are as saved.
  await page.reload();
  await openChat(alice);
  await openPayments(page, "accept", "testnet");
  await expect(page.getByTestId("payment-accept-lightning-testnet")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("payment-accept-cashu-testnet")).toHaveAttribute("aria-checked", "true");
  await paymentNetwork(page, "mainnet");
  await expect(page.getByTestId("payment-accept-cashu-mainnet")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("payment-accept-lightning-mainnet")).toHaveAttribute("aria-checked", "true");
  await closePayments(page);

  // A phone: the two tabs on one row, under Pay or request | Accept, and nothing wider than the screen.
  await page.setViewportSize({ width: 375, height: 812 });
  await openPayments(page, "pay", "testnet");
  const [mainnetTab, testnetTab] = await Promise.all(["mainnet", "testnet"].map((n) => page.getByTestId(`payment-tab-${n}`).boundingBox()));
  expect(Math.abs(mainnetTab!.y - testnetTab!.y), "the two tabs on one row").toBeLessThan(1);
  expect(testnetTab!.x + testnetTab!.width).toBeLessThanOrEqual(375);
  expect((await page.getByTestId("payment-mode-pay").boundingBox())!.y).toBeLessThan(mainnetTab!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sheet-testnet-375.png"), animations: "disabled" });
  await closePayments(page);
});
