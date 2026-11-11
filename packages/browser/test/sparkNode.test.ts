import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { cashuMint } from "../src/engine/paymentAdapters/providers/cashuMint";
import { breezDescriptor, breezDatabaseName } from "../src/engine/paymentAdapters/providers/breez";
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
  expect(net.connects.map((c) => c.storage), "the Spark wallet's storage: the same wallet").toEqual([breezDatabaseName("regtest", mnemonic)]);
});

it("a Breez Lightning card that opened the Spark wallet's own database says it is that wallet; a card on another phrase does not", async () => {
  const net = new FakeBreezNetwork();
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, providers: {
    lightning: [cashuMint, breezDescriptor(async () => net.sdk)], onchain: [],
  } });
  vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  node["sparkWallets"].testnet["sdk"] = async () => net.sdk;
  await node.start();
  await node.sparkCreate({ network: "regtest" });
  await node.sparkUseForLightning({ network: "testnet" });
  await node.lightningSetSource({ providerId: "breez", values: { mnemonic: generateMnemonic(wordlist) }, network: "testnet" });
  const breezCards = () => (node!.getState().wallet.networks?.testnet.lightnings ?? []).filter((c) => c.providerId === "breez");
  await vi.waitFor(() => expect(breezCards().map((c) => c.status)).toEqual(["ready", "ready"]));
  expect(new Set(net.connects.map((c) => c.storage)).size, "two phrases, two Breez databases").toBe(2);
  expect(breezCards().map((c) => [c.name, c.sameWalletAs ?? null])).toEqual([["Breez", "spark"], ["Breez 2", null]]);
  // The flat view of the default for receiving (the other phrase's card) says nothing either.
  expect(node.getState().wallet.networks?.testnet.lightning).not.toHaveProperty("sameWalletAs");
  // The Spark wallet closed: nothing to be the same as.
  await node["sparkWallets"].testnet.lock();
  await node["refreshWallet"]();
  expect(breezCards().map((c) => c.sameWalletAs ?? null)).toEqual([null, null]);
});
