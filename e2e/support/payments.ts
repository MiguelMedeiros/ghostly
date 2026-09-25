import { expect, type Locator, type Page } from "@playwright/test";
import { composerRow } from "./composer";

/**
 * The open chat's payment sheet (+ → Payment), on its Pay or Accept side. On a phone it is a sheet over a backdrop;
 * close it with Escape (`closePayments`).
 */
export async function openPayments(page: Page, side: "pay" | "accept" = "pay"): Promise<Locator> {
  const sheet = page.getByTestId("payment-composer");
  if (!(await sheet.isVisible())) {
    const row = await composerRow(page, "payment-button");
    await expect(row).toBeEnabled({ timeout: 60_000 });
    await row.click();
    await expect(sheet).toBeVisible();
  }
  if ((await sheet.getAttribute("data-mode")) !== side) await page.getByTestId(`payment-mode-${side}`).click();
  await expect(sheet).toHaveAttribute("data-mode", side);
  return sheet;
}

/** Closes the payment sheet from inside it (the focus may have left it, on a button that went disabled). */
export async function closePayments(page: Page): Promise<void> {
  const sheet = page.getByTestId("payment-composer");
  if (!(await sheet.isVisible())) return;
  await sheet.locator("[data-testid^=payment-mode-][aria-selected=true]").focus();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
}

/** One card of the Accept side, brought to the front first on a phone's track (the stack takes a click as it is). */
async function acceptCard(page: Page, method: string): Promise<Locator> {
  const card = page.getByTestId(`payment-accept-${method}`);
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
  for (const [method, on] of Object.entries(methods)) {
    const card = await acceptCard(page, method);
    if ((await card.getAttribute("aria-checked")) !== String(on)) await card.click();
    await expect(card).toHaveAttribute("aria-checked", String(on));
  }
  const save = page.getByTestId("payment-accept-save");
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByTestId("payment-accept-status")).toHaveAttribute("data-state", "saved");
  }
  await closePayments(page);
}
