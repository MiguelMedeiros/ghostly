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

it("'Use for Lightning too' makes the Spark wallet's own seed the Breez Lightning source: one wallet behind both cards", async () => {
  const net = new FakeBreezNetwork();
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, providers: {
    lightning: [cashuMint, breezDescriptor(async () => net.sdk)], onchain: [],
  } });
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  await node.start();
  await node.walletSetMode({ mode: "testnet" });
  const mnemonic = generateMnemonic(wordlist);
  const backup = vi.spyOn(node["sparkWallet"], "backup").mockResolvedValue({ mnemonic, network: "regtest" });
  await node.sparkUseForLightning();
  expect(backup).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(node!.getState().wallet.lightning).toMatchObject({ providerId: "breez", status: "ready" }));
  expect(net.connects.map((c) => c.storage), "the Spark wallet's storage: the same wallet").toEqual([breezStorage("regtest", mnemonic)]);
});
