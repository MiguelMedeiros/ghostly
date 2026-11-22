import type { Locator, Page } from "@playwright/test";
import { expect, openWallet, showNetwork, test, walletCard } from "../support/fixtures";
import { mockEthereum } from "../support/ethereum";
import { mockMainnetMints } from "../support/mint";

/**
 * Which money a screen is about, Mainnet (real) or Testnet, is chosen on Wallets' tabs and New wallet's two cards; their
 * fill, coloured edge and the radio's dot (a box shadow) said which. Forced colors (Windows Contrast themes) replace or
 * drop all three, so both looked the same there. Now the chosen tab is filled with Highlight, as the app's other chosen
 * options are (forced-colors-controls.spec.ts), and the chosen card has a Highlight edge and a filled dot.
 */

/**
 * A few pixels of what is drawn at a spot of an element (`at`: where in it, 0..1 of its width and height, or a child's
 * centre), as PNG bytes: two spots drawn alike give the same bytes. Read off the screen, not computed styles: Chromium
 * reports the chosen tab's border in its network's colour though forced colors draw it as the other's.
 */
async function drawn(page: Page, el: Locator, at: { x: number; y: number } | string): Promise<Buffer> {
  const box = typeof at === "string" ? (await el.locator(at).boundingBox())! : (await el.boundingBox())!;
  const [x, y] = typeof at === "string" ? [box.x + box.width / 2, box.y + box.height / 2] : [box.x + box.width * at.x, box.y + at.y];
  return page.screenshot({ clip: { x: Math.round(x) - 2, y: Math.round(y) - 2, width: 4, height: 4 } });
}

/** Compared with the focus elsewhere: the focus has a mark of its own in forced colors (index.css), not the choice's. */
async function chosenStandsOut(page: Page, chosen: Locator, other: Locator, at: { x: number; y: number } | string, name: string) {
  await chosen.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect((await drawn(page, chosen, at)).equals(await drawn(page, other, at)), `${name}: the chosen one is drawn like the other`).toBe(false);
}

test("forced colors mark the chosen network on Wallets' tabs and in New wallet", { tag: ["@feature:app.accessibility", "@feature:wallet.instances.networks"] }, async ({ peer }) => {
  // A new profile's first wallets (wallet-first-run.spec.ts: the suite's own mints and Ethereum RPC, never Mainnet),
  // so Wallets shows its tabs.
  const alice = await peer("alice", { beforeOpen: async (context) => {
    await mockMainnetMints(context);
    await mockEthereum(context);
    await context.addInitScript(() => { try { localStorage.setItem("ghostly-test-wallet-setup", "on"); } catch { /* opaque origin */ } });
  } });
  const page = alice.page;
  await openWallet(alice);
  await expect(walletCard(page, "cashu-mainnet")).toBeVisible({ timeout: 60_000 });
  await showNetwork(page, "testnet");
  // No transition: the tabs' border colour eases for 0.2 s, and a colour read mid-way is neither look.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });

  // Inside the tab, above its words: its fill, nothing else.
  const INSIDE = { x: 0.5, y: 4 };
  const tab = (n: string) => page.getByTestId(`wallet-network-${n}`);
  await expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
  await chosenStandsOut(page, tab("testnet"), tab("mainnet"), INSIDE, "Wallets' tabs");
  await tab("mainnet").click();
  await expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
  await chosenStandsOut(page, tab("mainnet"), tab("testnet"), INSIDE, "Wallets' tabs, Mainnet chosen");

  await page.getByTestId("wallet-add").click();
  const card = (n: string) => page.getByTestId(`new-wallet-network-${n}`);
  await expect(card("mainnet").or(card("testnet")).first()).toBeVisible();
  const [chosen, other] = await card("mainnet").getAttribute("aria-checked") === "true" ? ["mainnet", "testnet"] : ["testnet", "mainnet"];
  await chosenStandsOut(page, card(chosen), card(other), ".new-wallet-network-dot", "New wallet's network");
});
