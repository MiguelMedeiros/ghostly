import type { Locator, Page } from "@playwright/test";
import { bcrt1q } from "../../apps/ui/src/test/payments/moneyFormatFixtures";
import { strangerInvoice } from "../support/bolt11";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * Settings → Text size reaches a chat's money cards as it reaches its messages: a Lightning invoice's label and memo, a
 * Bitcoin address's label, the address and its "no wallet" line are half again their size at Huge, and none of them
 * goes past a phone's screen. The amount, the network's tag and the buttons keep their size.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const PHONE = { width: 390, height: 844 };

const px = (target: Locator) => target.evaluate((element) => Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10);

/** The page wider than the screen, or a card past its edge, or a word in it past the card's. */
const cut = (page: Page, cards: Locator[]) => Promise.all(cards.map((card) => card.evaluate((card) => {
  const edge = card.getBoundingClientRect();
  if (edge.left < -0.5 || edge.right > window.innerWidth + 0.5) return [`${card.getAttribute("data-testid")} at ${edge.left}-${edge.right}`];
  return [...card.querySelectorAll("p")].filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && (box.left < edge.left - 1 || box.right > edge.right + 1);
  }).map((el) => `${card.getAttribute("data-testid")}: "${el.textContent?.slice(0, 30)}" at ${el.getBoundingClientRect().right}`);
}))).then(async (out) => [...out.flat(), ...(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth ? [`page ${document.documentElement.scrollWidth}`] : []))]);

async function textSize(page: Page, textSize: string): Promise<void> {
  await page.evaluate((textSize) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), textSize })), textSize);
  await page.reload();
}

async function openChat(peer: Peer): Promise<void> {
  await peer.page.goto("/#/");
  await peer.page.getByTestId("chat-row").first().click();
  await expect(chat(peer)).toBeVisible();
}

test("at Text size Huge on a phone, an invoice's and a Bitcoin address's words grow with the messages, their amount does not", { tag: ["@feature:settings.text-size", "@feature:app.mobile-layout", "@feature:payments.money.onchain-card"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("money-size-a"), peer("money-size-b")]);
  await link(alice, bob);
  await connect(alice, bob);
  const page = alice.page;

  await say(bob, `pay me ${strangerInvoice(2100, "lunch at noon")}`);
  await say(bob, `my regtest address ${bcrt1q(9)}`);
  const invoice = chat(alice).getByTestId("invoice-bubble").last();
  const onchain = chat(alice).getByTestId("onchain-bubble").last();
  await expect(invoice).toContainText("lunch at noon", { timeout: 60_000 });
  await expect(onchain.getByTestId("money-detail")).toHaveText(bcrt1q(9), { timeout: 60_000 });
  const words = {
    invoiceLabel: invoice.locator("p").first(),
    invoiceMemo: invoice.locator("p").filter({ hasText: "lunch at noon" }),
    invoiceAmount: invoice.getByTestId("money-amount"),
    addressLabel: onchain.locator("p").first(),
    address: onchain.getByTestId("money-detail"),
    noWallet: onchain.getByTestId("money-no-wallet"),
    network: onchain.getByTestId("money-network"),
  };
  const sizes = async () => Object.fromEntries(await Promise.all(Object.entries(words).map(async ([name, target]) => [name, await px(target)])));
  expect(await sizes()).toEqual({ invoiceLabel: 11, invoiceMemo: 12.5, invoiceAmount: 22, addressLabel: 11, address: 11.5, noWallet: 12, network: 11 });

  await textSize(page, "huge");
  await page.setViewportSize(PHONE);
  await openChat(alice);
  await expect(onchain.getByTestId("money-detail")).toBeVisible();
  // Half again their size, as the messages are; the amount and the network's tag keep theirs.
  expect(await sizes()).toEqual({ invoiceLabel: 16.5, invoiceMemo: 18.8, invoiceAmount: 22, addressLabel: 16.5, address: 17.3, noWallet: 18, network: 11 });
  expect(await cut(page, [invoice, onchain])).toEqual([]);
  await invoice.screenshot({ path: test.info().outputPath("invoice-huge.png") });
  await onchain.screenshot({ path: test.info().outputPath("onchain-huge.png") });
});
