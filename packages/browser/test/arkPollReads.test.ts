import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { ArkadeAdapter } from "../src/engine/paymentAdapters/arkade";
import { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
// covers: wallet.ark.create

/*
 * An Ark wallet refreshes every 10 s for as long as the app runs, and every profile has a Mainnet one. The SDK's
 * getBalance asks the explorer (the boarding coins) and the Ark indexer each time. A refresh asked it twice, once for
 * the balance and once for what waits on-chain, which is in the same answer: one explorer request and one indexer
 * request every 10 s for nothing (a local build counted 13 explorer and 25 indexer requests a minute for one wallet).
 */

it("a refresh reads the balance and what waits on-chain from one getBalance", async () => {
  const getBalance = vi.fn(async () => ({ available: 1_000, boarding: { confirmed: 0, unconfirmed: 21, total: 21 } }));
  const sdk = { getBalance, getAddress: async () => "ark1me", getBoardingAddress: async () => "bc1me", getVtxos: async () => [], dispose: async () => {} };
  const adapter = Object.assign(Object.create(ArkadeAdapter.prototype) as ArkadeAdapter, { config: { network: "bitcoin", provider: "https://ark.example", explorer: "https://explorer.example" }, wallet: sdk });
  const ark = new ArkWallet("mainnet", vi.fn());
  Object.assign(ark, { adapter });
  await ark.refresh();
  expect(ark.view).toMatchObject({ balance: 1_000, incoming: 21, read: true });
  expect(ark.view.error).toBeUndefined();
  expect(getBalance).toHaveBeenCalledTimes(1);
  await ark.lock();
});
