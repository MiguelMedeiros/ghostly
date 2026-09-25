// "A little thank-you": Boo's eight wallets on test networks, funded from the shared regtest
// environment, and sats sent and requested in the chat with Casper. The phone shots reopen Boo's
// own storage in a phone-sized, touch context: the same chats and wallets, on a phone.
import { test, expect, type Browser } from "@playwright/test";
import { rmSync } from "node:fs";
import { LocalRelay } from "../../../e2e/support/relay";
import { CAST, chat, converse, go, newProfile, open, pair, person, shot, toBottom, type Peer } from "./helpers";
import { fund, openWallet } from "./wallet";
import { composerRow } from "../../../e2e/support/composer";

const composerOpen = async (p: Peer) => {
  await (await composerRow(p.page, "payment-button")).click();
  await expect(p.page.getByTestId("payment-composer")).toBeVisible();
};

/** The deck steered back to its first card, Cashu, with the arrows (a click would turn the card over). */
async function cashuCard(p: Peer) {
  const cashu = p.page.getByTestId("payment-card-cashu");
  for (let i = 0; i < 8 && (await cashu.getAttribute("aria-checked")) !== "true"; i++) {
    await p.page.getByTestId("payment-deck-prev").click();
    await p.page.waitForTimeout(350);
  }
  await p.page.waitForTimeout(900);
}

/** Casper sends Boo a thank-you in ecash. */
async function thankYou(casper: Peer, boo: Peer) {
  await composerOpen(casper);
  await casper.page.getByTestId("payment-card-cashu").click();
  await casper.page.getByTestId("payment-amount").fill("2100");
  await casper.page.getByTestId("payment-composer").getByPlaceholder("What for? (optional)").fill("for the snacks 🍪");
  await casper.page.getByTestId("payment-send").click();
  const review = casper.page.getByTestId("payment-composer").getByTestId("payment-review");
  await review.getByRole("button", { name: "Approve payment" }).click({ timeout: 60_000 });
  await expect(review.getByTestId("review-status")).toHaveText("settled", { timeout: 90_000 });
  await casper.page.getByTestId("payment-composer").getByRole("button", { name: "Close", exact: true }).click();
  await expect(chat(boo).getByTestId("payment-bubble").filter({ hasText: "for the snacks" }).first()).toBeVisible({ timeout: 90_000 });
}

/** Boo asks Casper for half the cabin over Ark; Casper pays it from the bubble. */
async function splitCabin(boo: Peer, casper: Peer) {
  await composerOpen(boo);
  await boo.page.getByTestId("payment-card-arkade").click();
  await boo.page.getByTestId("payment-amount").fill("4500");
  await boo.page.getByTestId("payment-composer").getByPlaceholder("What for? (optional)").fill("cabin, your half");
  await boo.page.getByTestId("payment-request").click();
  const request = chat(casper).getByTestId("payment-bubble").filter({ hasText: "Requests" }).last();
  await request.getByTestId("payment-pay").click({ timeout: 90_000 });
  await request.getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(request.getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
  await expect(chat(boo).getByTestId("payment-bubble").filter({ hasText: "You requested" }).last().getByTestId("payment-state")).toHaveText("Paid", { timeout: 90_000 });
}

async function story(browser: Browser, baseURL: string) {
  const relay = new LocalRelay();
  const profile = newProfile();
  const [boo, casper] = await Promise.all([person(browser, relay, baseURL, CAST.boo, { profile }), person(browser, relay, baseURL, CAST.casper)]);
  const [booFailed, casperFailed] = await Promise.all([
    fund(boo, { cashu: 42_000, arkade: 9_900, bark: 25_000, spark: 5_000, usdt: 25, bitcoin: 150_000, fedimint: 20_000 }),
    fund(casper, { cashu: 10_000, arkade: 9_900 }),
  ]);
  console.log("  not funded:", [...booFailed.map(r => `Boo ${r}`), ...casperFailed.map(r => `Casper ${r}`)].join(", ") || "none");
  await pair(casper, boo);
  const route = await boo.page.evaluate(() => location.hash);
  await converse([
    [casper, "the cabin is booked for friday 🏡"],
    [boo, "amazing, what do I owe you?"],
    [casper, "you brought the snacks last time. call it even?"],
    [boo, "no way. splitting it, sending a request"],
  ], [boo, casper]);
  await thankYou(casper, boo);
  await splitCabin(boo, casper);
  await converse([[casper, "paid ⚡ see you friday"]], [boo, casper]);
  await boo.page.waitForTimeout(2000);
  await toBottom(boo);
  return { relay, boo, casper, route, profile };
}

test("wallets and payments in the chat, desktop and phone", async ({ browser, baseURL }) => {
  test.setTimeout(30 * 60_000);
  const { relay, boo, route, profile } = await story(browser, baseURL!);

  await shot(boo, "x-sats-chat.png");
  await composerOpen(boo);
  await cashuCard(boo);
  await shot(boo, "sats.png");
  await boo.page.keyboard.press("Escape");
  await openWallet(boo, "cashu");
  await shot(boo, "x-wallet.png");

  // The same Boo on a phone: its browser profile, reopened in a phone context once the desktop one is closed.
  await boo.context.close();
  const phone = await open(browser, relay, baseURL!, "mBoo", { mobile: true, profile });
  await go(phone, route);
  await expect(chat(phone).getByText("paid ⚡ see you friday")).toBeVisible({ timeout: 60_000 });
  await phone.page.waitForTimeout(1500);
  await toBottom(phone);
  await shot(phone, "sats-mobile.png");
  await composerOpen(phone);
  await cashuCard(phone);
  await shot(phone, "x-sats-composer-mobile.png");
  await phone.page.keyboard.press("Escape");
  await openWallet(phone, "cashu");
  await phone.page.waitForTimeout(1500);
  await shot(phone, "x-wallet-mobile.png");
  await phone.context.close();
  rmSync(profile, { recursive: true, force: true });
  relay.close();
});
