import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { setAwayWallets } from "../src/engine/paymentAdapters/away";
// covers: devices.handoff.wallets

/*
 * A wallet at home on another device (WISP 06 § Wallets that stay home) is never opened, made again, unlocked,
 * joined, restored or used here, whichever engine method asks: the ones the pages call and the CLI calls alike
 * (`packages/cli/src/engineMethods.ts`). Each is driven through the engine, as a caller does.
 */

const transport: PkarrTransport = { publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) };
const nodes: GhostlyNode[] = [];
afterEach(async () => { setAwayWallets(new Map()); for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); });

const AWAY = /can't be used here\. Use it on Desktop\./;
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("a wallet at home on another device, through the engine", () => {
  it("refuses every way of making it again, unlocking, joining, restoring or using it on this device", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    setAwayWallets(new Map(["arkade", "bark", "usdt", "spark", "fedimint", "bitcoin"].map((type) => [`${type}:testnet`, "Desktop"] as [string, string]).concat([["lightning:testnet:cashu", "Desktop"]])));
    const calls: [string, () => Promise<unknown>][] = [
      ["arkCreate", () => node.arkCreate({ network: "mutinynet", provider: "https://ark.test", explorer: "https://esplora.test" } as never)],
      ["barkCreate", () => node.barkCreate({ network: "signet", provider: "https://bark.test", explorer: "https://esplora.test" } as never)],
      ["usdtCreate", () => node.usdtCreate({ network: "sepolia" } as never)],
      ["sparkCreate", () => node.sparkCreate({ network: "regtest" } as never)],
      ["arkUnlock", () => node.arkUnlock({ password: "a test password", network: "testnet" })],
      ["usdtUnlock", () => node.usdtUnlock({ password: "a test password", network: "testnet" })],
      ["arkRestoreBackup", () => node.arkRestoreBackup({ text: "{}", password: "a test password", network: "testnet" })],
      ["barkRestoreBackup", () => node.barkRestoreBackup({ text: "{}", password: "a test password", network: "testnet" })],
      ["sparkRestoreBackup", () => node.sparkRestoreBackup({ text: "{}", password: "a test password", network: "testnet" })],
      ["usdtRestoreBackup", () => node.usdtRestoreBackup({ text: "{}", password: "a test password", network: "testnet" })],
      ["fedimintJoin", () => node.fedimintJoin({ invite: "fed11test", network: "testnet" })],
      ["fedimintRestoreBackup", () => node.fedimintRestoreBackup({ text: "{}", password: "a test password", network: "testnet" })],
      ["fedimintRestorePhrase", () => node.fedimintRestorePhrase({ mnemonic: PHRASE, invites: ["fed11test"], network: "testnet" })],
      ["sparkUseForLightning", () => node.sparkUseForLightning({ network: "testnet" })],
      ["walletCreate bark", () => node.walletCreate({ type: "bark", network: "testnet" })],
      ["lightningSetSource on its card", () => node.lightningSetSource({ providerId: "nwc", values: {}, network: "testnet", card: "cashu" })],
      ["lightningRetrySource", () => node.lightningRetrySource({ network: "testnet", card: "cashu" })],
      ["lightningReconfigureSource", () => node.lightningReconfigureSource({ values: {}, network: "testnet", card: "cashu" })],
      ["lightningRefresh", () => node.lightningRefresh({ network: "testnet", card: "cashu" })],
      // A card away is never made this device's default for receiving.
      ["lightningSetReceive", () => node.lightningSetReceive({ network: "testnet", card: "cashu" })],
      // A Bitcoin Core source at home on another device: its record there is never written over from here.
      ["bitcoinSetSource", () => node.bitcoinSetSource({ providerId: "bitcoind", values: {}, network: "testnet" })],
      ["bitcoinClearSource", () => node.bitcoinClearSource({ network: "testnet" })],
      ["bitcoinRetrySource", () => node.bitcoinRetrySource({ network: "testnet" })],
      ["bitcoinReconfigureSource", () => node.bitcoinReconfigureSource({ values: {}, network: "testnet" })],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow(AWAY);
  });

  it("a wallet here is not refused: only the one away is", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    setAwayWallets(new Map([["bark:mainnet", "Desktop"]]));
    // Fails for its own reason (no backup in that text), not because it is away.
    await expect(node.arkRestoreBackup({ text: "{}", password: "a test password", network: "testnet" })).rejects.not.toThrow(AWAY);
  });
});
