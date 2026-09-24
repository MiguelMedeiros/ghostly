import { expect, openWallet, test, useTestnet } from "../support/fixtures";

// A public Mainnet service that never answers (mempool.space, from some networks) must not hold the
// switch: the Mainnet wallet's balance was being read when the person switched, and that read is left
// behind. Talks to the real Ark servers (arkade.computer, mutinynet.arkade.sh), never moves funds.
test("switching to Testnet does not wait for a Mainnet explorer that never answers", { tag: ["@network", "@feature:wallet.mode"] }, async ({ peer }) => {
  const alice = await peer("mode-slow-mainnet");
  // Not refused (that answers at once): the request just hangs, as a silent network does.
  await alice.context.route(/^https:\/\/mempool\.space\//, () => new Promise<void>(() => {}));
  const page = alice.page;
  const panel = page.getByTestId("ark-wallet");
  await openWallet(alice, "arkade");
  // The Mainnet wallet is open, and its balance read is stuck on the explorer.
  await expect(panel.getByTestId("ark-address")).toHaveText(/^\s*ark1/, { timeout: 90_000 });
  const mainnetAddress = (await panel.getByTestId("ark-address").innerText()).trim();

  const switched = Date.now();
  await useTestnet(alice);
  await openWallet(alice, "arkade");
  // At once: the Mainnet wallet leaves the panel (connecting to Mutinynet, or already there).
  await expect(panel.getByTestId("ark-address")).not.toHaveText(/^\s*ark1/, { timeout: 5_000 });
  await expect(panel.getByTestId("ark-connecting").or(panel.getByTestId("ark-balance").filter({ hasText: "Mutinynet" }))).toBeVisible({ timeout: 5_000 });
  // Then the Mutinynet wallet itself, as fast as its own server answers.
  await expect(panel.getByTestId("ark-balance")).toContainText("Mutinynet", { timeout: 60_000 });
  await expect(panel.getByTestId("ark-address")).toHaveText(/^\s*tark1/, { timeout: 30_000 });
  console.log(`  Mutinynet wallet ready ${((Date.now() - switched) / 1000).toFixed(1)} s after the switch`);

  // Nothing was lost: back on Mainnet, the same wallet.
  await openWallet(alice);
  await page.getByTestId("wallet-mode").getByRole("radio", { name: "Mainnet" }).click();
  await openWallet(alice, "arkade");
  await expect(panel.getByTestId("ark-address")).toHaveText(mainnetAddress, { timeout: 90_000 });
});
