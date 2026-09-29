import { expect, type Locator, type Page } from "@playwright/test";
import { composerRow } from "./composer";

/**
 * The open chat's payment sheet (+ → Payment), on its Pay or Accept side, and with `network` on that network's tab
 * (each deck shows one network's cards). On a phone it is a sheet over a backdrop; close it with Escape
 * (`closePayments`).
 */
export async function openPayments(page: Page, side: "pay" | "accept" = "pay", network?: "mainnet" | "testnet"): Promise<Locator> {
  const sheet = page.getByTestId("payment-composer");
  if (!(await sheet.isVisible())) {
    const row = await composerRow(page, "payment-button");
    await expect(row).toBeEnabled({ timeout: 60_000 });
    await row.click();
    await expect(sheet).toBeVisible();
  }
  if ((await sheet.getAttribute("data-mode")) !== side) await page.getByTestId(`payment-mode-${side}`).click();
  await expect(sheet).toHaveAttribute("data-mode", side);
  if (network) await paymentNetwork(page, network);
  return sheet;
}

/** The open payment sheet's Mainnet | Testnet tab: a card of the other network is not in its deck until it is chosen. */
export async function paymentNetwork(page: Page, network: "mainnet" | "testnet"): Promise<void> {
  const tab = page.getByTestId(`payment-tab-${network}`);
  if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** The networks the open payment sheet has tabs for. */
const networksShown = async (page: Page) => (await page.getByTestId("payment-tabs").count()) ? ["mainnet", "testnet"] as const : [];

/** Closes the payment sheet from inside it (the focus may have left it, on a button that went disabled). */
export async function closePayments(page: Page): Promise<void> {
  const sheet = page.getByTestId("payment-composer");
  if (!(await sheet.isVisible())) return;
  await sheet.locator("[data-testid^=payment-mode-][aria-selected=true]").focus();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
}

/**
 * One card of the Accept side (`cashu-testnet`, or a kind alone for its first card on the tab shown), its network's tab
 * chosen and the card brought to the front first on a phone's track (the stack takes a click as it is).
 */
async function acceptCard(page: Page, method: string): Promise<Locator> {
  const network = method.split("-")[1];
  if (network === "mainnet" || network === "testnet") await paymentNetwork(page, network);
  const card = method.includes("-") ? page.getByTestId(`payment-accept-${method}`) : page.locator(`[data-testid^="payment-accept-${method}-"]`).first();
  if ((await page.getByTestId("payment-composer").locator(".wallet-deck").getAttribute("data-mode")) === "track") {
    for (let i = 0; i < 8 && (await card.getAttribute("data-active")) !== "true"; i++) await page.getByTestId("payment-accept-deck-next").click();
    await expect(card).toHaveAttribute("data-active", "true");
  }
  return card;
}

/**
 * Which ways of paying the open chat accepts, chosen as a person does: + → Payment → Accept, each card named turned
 * on or off, then Save. The others stay as they are, and nothing is paid. The sheet is closed after.
 */
export async function chatPayments(page: Page, methods: Record<string, boolean>): Promise<void> {
  await openPayments(page, "accept");
  const turn = async (id: string, on: boolean) => {
    const card = await acceptCard(page, id);
    if ((await card.getAttribute("aria-checked")) !== String(on)) await card.click();
    await expect(card).toHaveAttribute("aria-checked", String(on));
  };
  for (const [method, on] of Object.entries(methods)) {
    // `cashu-testnet` means that card; a kind alone means each of its cards, on both networks' tabs (the switches of
    // one tab are kept while the other is shown, and Save saves them all).
    if (method.includes("-")) { await turn(method, on); continue; }
    for (const network of await networksShown(page)) {
      await paymentNetwork(page, network);
      if (await page.getByTestId(`payment-accept-${method}-${network}`).count()) await turn(`${method}-${network}`, on);
    }
  }
  const save = page.getByTestId("payment-accept-save");
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByTestId("payment-accept-status")).toHaveAttribute("data-state", "saved");
  }
  await closePayments(page);
}

/**
 * A card of the chat's payment deck: `cashu-testnet`, or a kind alone for the first card of that kind. The deck shows
 * the tab's network only: with wallets on both networks, choose the card's first (`paymentNetwork`).
 */
export const paymentCard = (page: Page, card: string): Locator =>
  card.includes("-") ? page.getByTestId(`payment-card-${card}`) : page.locator(`[data-testid^="payment-card-${card}-"]`).first();
