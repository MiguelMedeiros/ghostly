import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { cashuMint } from "../src/engine/paymentAdapters/providers/cashuMint";
import { breezDescriptor, breezStorage } from "../src/engine/paymentAdapters/providers/breez";
import { FakeBreezNetwork } from "./helpers/fakeBreez";
// covers: wallet.spark.lightning

let node: GhostlyNode | undefined;
beforeEach(async () => { await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); }); });
afterEach(async () => { await node?.shutdown(); node = undefined; vi.restoreAllMocks(); });

it("'Use for Lightning too' makes a network's Spark wallet's own seed that network's Breez Lightning source: one wallet behind both cards", async () => {
  const net = new FakeBreezNetwork();
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, providers: {
    lightning: [cashuMint, breezDescriptor(async () => net.sdk)], onchain: [],
  } });
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  await node.start();
  const mnemonic = generateMnemonic(wordlist);
  const backup = vi.spyOn(node["sparkWallets"].testnet, "backup").mockResolvedValue({ mnemonic, network: "regtest" });
  const mainnetBackup = vi.spyOn(node["sparkWallets"].mainnet, "backup");
  await node.sparkUseForLightning({ network: "testnet" });
  expect(backup).toHaveBeenCalledOnce();
  expect(mainnetBackup, "the Mainnet Spark wallet is not asked").not.toHaveBeenCalled();
  await vi.waitFor(() => expect(node!.getState().wallet.networks?.testnet.lightning).toMatchObject({ providerId: "breez", status: "ready" }));
  expect(node.getState().wallet.networks?.mainnet.lightning?.providerId, "the Mainnet Lightning source is untouched").not.toBe("breez");
  expect(net.connects.map((c) => c.storage), "the Spark wallet's storage: the same wallet").toEqual([breezStorage("regtest", mnemonic)]);
});
