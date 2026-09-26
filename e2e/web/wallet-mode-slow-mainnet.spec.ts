import { mockMainnetArk } from "../support/ark-mainnet";
import { createWallet, expect, openWallet, test, walletCard } from "../support/fixtures";

// A public Mainnet explorer that never answers (mempool.space, from some networks) must not hold up a Testnet
// wallet: the Mainnet Ark wallet's balance read is stuck on it while the person makes a Testnet one. The Mainnet
// wallet's server is a recorded answer (arkade.computer is never reached); the Testnet one is Mutinynet's real test
// server. No funds move.
test("a Mainnet wallet stuck on an explorer that never answers does not hold up a Testnet one", { tag: ["@network", "@feature:wallet.mode", "@feature:wallet.instances.create", "@feature:wallet.ark.create"] }, async ({ peer }) => {
  const alice = await peer("mode-slow-mainnet");
  // Not refused (that answers at once): the request just hangs, as a silent network does.
  let explorer = 0;
  await alice.context.route(/^https:\/\/mempool\.space\//, () => { explorer++; return new Promise<void>(() => {}); });
  const seen = new Set<string>();
  await mockMainnetArk(alice.context, seen);
  const page = alice.page;
  const panel = page.getByTestId("ark-wallet");
  // Made as soon as its server answers: its first balance read, stuck on the explorer, is not part of making it
  // (New stays busy, and the page behind it waits, for as long as the creation does).
  const mainnetStarted = Date.now();
  await createWallet(alice, "arkade", "mainnet");
  const mainnetTook = Date.now() - mainnetStarted;
  console.log(`  Mainnet wallet made in ${(mainnetTook / 1000).toFixed(1)} s`);
  expect.soft(mainnetTook, "New makes the Mainnet Ark wallet without waiting on its explorer").toBeLessThan(15_000);
  // The Mainnet wallet is open, and its balance read is stuck on the explorer.
  await expect(panel.getByTestId("ark-address")).toHaveText(/^\s*ark1/, { timeout: 30_000 });
  const mainnetAddress = (await panel.getByTestId("ark-address").innerText()).trim();
  await expect.poll(() => explorer, { message: "the Mainnet wallet asked the explorer" }).toBeGreaterThan(0);
  await expect(walletCard(page, "arkade-mainnet").getByTestId("wallet-card-network")).toHaveCount(0);

  // A Testnet Ark wallet, made now: as fast as its own server answers.
  const started = Date.now();
  await createWallet(alice, "arkade", "testnet", { timeout: 60_000 });
  await expect(panel.getByTestId("ark-balance")).toContainText("Mutinynet", { timeout: 30_000 });
  await expect(panel.getByTestId("ark-address")).toHaveText(/^\s*tark1/, { timeout: 30_000 });
  const testnetTook = Date.now() - started;
  console.log(`  Mutinynet wallet ready ${(testnetTook / 1000).toFixed(1)} s after New; arkade.computer calls answered here: ${[...seen].join(", ")}`);
  expect(testnetTook, "the Testnet wallet waited only on its own server").toBeLessThan(45_000);
  await expect(walletCard(page, "arkade-testnet").getByTestId("wallet-card-network")).toHaveText("Testnet");

  // Nothing was lost: the Mainnet wallet is still there, the same one, both open at once.
  await openWallet(alice, "arkade-mainnet");
  await expect(panel.getByTestId("ark-address")).toHaveText(mainnetAddress, { timeout: 30_000 });
  await openWallet(alice, "arkade-testnet");
  await expect(panel.getByTestId("ark-address")).toHaveText(/^\s*tark1/, { timeout: 30_000 });
});
