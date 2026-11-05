import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { createWallet, expect, openWallet, test, useFakeProviders, type Peer } from "../support/fixtures";
import { choose } from "../support/select";
import { FakeEsplora } from "../../packages/browser/test/helpers/fakeEsplora";

/**
 * The Bitcoin total over the Testnet deck, offline: two Lightning cards on the fake source (100,000 test sats each,
 * in memory) and a BDK wallet against an in-memory Esplora the test can take down. The total adds what every card
 * holds; the BDK wallet's mempool sats are in it but not in what is ready now; with its server down the BDK card
 * cannot be read, so it is left out of the total (never counted as 0) and the breakdown says so; once the server is
 * back it is counted again.
 */

/** Esplora answered from `esplora` under a made-up host the test can take down (a refused connection). */
async function serveEsplora(context: BrowserContext, esplora: FakeEsplora, host: string) {
  let up = true;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*" };
  await context.route(`https://${host}/**`, async (route: Route) => {
    if (!up) return route.abort("connectionrefused");
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const response = await esplora.fetch(request.url(), { method: request.method(), body: request.postData() ?? undefined });
    await route.fulfill({ status: response.status, headers: { ...cors, "content-type": response.headers.get("content-type") ?? "text/plain" }, body: await response.text() });
  });
  return { set: (answering: boolean) => { up = answering; } };
}

/** A Lightning card on the fake source, named (another name and token: another wallet, not the same one twice). */
async function fakeLightning(p: Peer, name: string, token: string) {
  await createWallet(p, "lightning", "testnet", { provider: "fake-lightning", fill: async (form: Locator) => {
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Access token").fill(token);
    await form.getByTestId("provider-save").click();
  } });
}

/** A Testnet BDK wallet on regtest, through New (picked by name: the fake source is offered beside it), with the words written down and this Esplora server. */
async function makeBdk(p: Peer, esplora: string) {
  await createWallet(p, "bitcoin", "testnet", { provider: "bdk", timeout: 60_000, fill: async (form: Locator) => {
    await form.getByTestId("bdk-written").check();
    await choose(form.getByTestId("provider-form-bdk").getByLabel("Network"), "regtest");
    await form.getByLabel("Esplora server").fill(esplora);
    await form.getByTestId("provider-save").click();
  } });
  await openWallet(p, "bitcoin-testnet");
}

const amount = (page: Page) => page.getByTestId("wallet-total-bitcoin-amount");
const breakdown = (page: Page) => page.getByTestId("wallet-total-breakdown");
const row = (page: Page, id: string) => breakdown(page).getByTestId(`wallet-total-row-${id}`);
const lightningRows = (page: Page) => breakdown(page).locator("[data-testid^=wallet-total-row-lightning-testnet-]");

test("the Bitcoin total sums the tab's cards, keeps unconfirmed sats out of what is ready, and leaves a card it can't read out", { tag: ["@feature:wallet.balance.total", "@feature:wallet.lightning.cards", "@feature:wallet.onchain.bdk.create"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const esplora = new FakeEsplora();
  const alice = await peer("wallet-totals");
  const page = alice.page;
  const server = await serveEsplora(alice.context, esplora, "esplora-totals.ghostly.test");
  await useFakeProviders(alice);

  // Two Lightning cards of 100,000 test sats each, and a BDK wallet: 50,000 confirmed, 20,000 still in the mempool.
  await fakeLightning(alice, "Node A", "token-a");
  await fakeLightning(alice, "Node B", "token-b");
  await makeBdk(alice, "https://esplora-totals.ghostly.test/api");
  const panel = page.getByTestId("bitcoin-wallet");
  await expect(panel.getByTestId("onchain-source-status")).toContainText("Connected", { timeout: 60_000 });
  await panel.getByTestId("bitcoin-new-address").click();
  const address = (await panel.getByTestId("bitcoin-address").innerText()).trim();
  esplora.fund(address, 50_000);
  esplora.fund(address, 20_000, false);
  await expect.poll(async () => { await panel.getByRole("button", { name: "Refresh now" }).click(); return panel.getByTestId("bitcoin-balance").innerText(); }, { timeout: 30_000 }).toContain("20,000");

  // The total over the deck: every card counted, the mempool sats in it.
  const totals = page.getByTestId("wallet-totals");
  await expect(totals).toHaveAttribute("data-network", "testnet");
  await expect(totals.locator("xpath=following-sibling::*[1]")).toHaveClass(/wallet-deck/);
  await expect(amount(page)).toHaveText(/^270,000\s*test sats$/, { timeout: 30_000 });
  await expect(page.getByTestId("wallet-total-bitcoin-uncounted")).toHaveCount(0);
  await expect(page.getByTestId("wallet-total-usdt")).toHaveCount(0);

  // Where it comes from: a row per card, what is ready now without the mempool sats.
  await page.getByTestId("wallet-total-bitcoin").click();
  await expect(breakdown(page)).toHaveAttribute("data-network", "testnet");
  await expect(breakdown(page).getByTestId("wallet-total-sum-amount")).toHaveText("270,000 test sats");
  await expect(breakdown(page).getByTestId("wallet-total-ready-amount")).toHaveText("250,000 test sats");
  await expect(lightningRows(page)).toHaveCount(2);
  for (const line of await lightningRows(page).all()) {
    await expect(line).toHaveAttribute("data-state", "counted");
    await expect(line.getByTestId("wallet-total-line-amount")).toHaveText("100,000 test sats");
  }
  await expect(row(page, "bitcoin-testnet")).toHaveAttribute("data-state", "counted");
  await expect(row(page, "bitcoin-testnet")).toContainText("20,000 test sats unconfirmed");
  await expect(row(page, "bitcoin-testnet").getByTestId("wallet-total-line-amount")).toHaveText("70,000 test sats");
  await page.keyboard.press("Escape");
  await expect(breakdown(page)).toHaveCount(0);
  await expect(page.getByTestId("wallet-total-bitcoin")).toBeFocused();

  // Its server down at the next start: the BDK card can't be read, so it is not in the total, never as a 0.
  server.set(false);
  await page.reload();
  await openWallet(alice, "bitcoin-testnet");
  await expect(panel.getByTestId("bitcoin-connecting")).toHaveAttribute("data-status", "connecting");
  await expect(amount(page)).toHaveText(/^200,000\s*test sats$/, { timeout: 30_000 });
  await expect(page.getByTestId("wallet-total-bitcoin-uncounted")).toHaveText("1 card not counted");
  await page.getByTestId("wallet-total-bitcoin").click();
  await expect(row(page, "bitcoin-testnet")).toHaveAttribute("data-state", "unknown");
  await expect(row(page, "bitcoin-testnet")).toContainText("Couldn't read it now, not in the total");
  await expect(row(page, "bitcoin-testnet").getByTestId("wallet-total-line-amount")).toHaveText("?");
  await expect(breakdown(page).getByTestId("wallet-total-ready-amount")).toHaveText("200,000 test sats");
  await breakdown(page).getByTestId("wallet-total-close").click();

  // The server is back: the card connects by itself and is counted again.
  server.set(true);
  await expect(amount(page)).toHaveText(/^270,000\s*test sats$/, { timeout: 90_000 });
  await expect(page.getByTestId("wallet-total-bitcoin-uncounted")).toHaveCount(0);

  // On a phone the breakdown is a sheet from the bottom, inside the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("wallet-total-bitcoin").click();
  await expect(breakdown(page)).toHaveAttribute("data-side", "bottom");
  const box = await breakdown(page).boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844 + 1).toBe(true);
  await expect(page.getByTestId("wallet-total-close")).toBeVisible();
});
