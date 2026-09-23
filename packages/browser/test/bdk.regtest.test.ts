import "fake-indexeddb/auto";
import { it, vi } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { BdkOnchain } from "../src/engine/paymentAdapters/providers/bdk";
import { describeOnchainProvider } from "./helpers/providerContract";
import { nodeBdk } from "./helpers/bdkNode";

/**
 * The BDK provider against a real regtest chain: bitcoind + electrs (Esplora) from
 * e2e/support/bdk-regtest (see e2e/README.md). Worthless coins; skipped unless GHOSTLY_BDK_REGTEST=1.
 */
const enabled = process.env.GHOSTLY_BDK_REGTEST === "1";
// @ts-expect-error A plain .mjs script, shared with the e2e tests.
const regtest = enabled ? await import("../../../e2e/support/bdk-regtest/regtest.mjs") as { ready(): Promise<{ esplora: string }>; send(address: string, sats: number): Promise<string>; address(): string } : undefined;

if (enabled) {
  const { esplora } = await regtest!.ready();
  describeOnchainProvider("BDK (regtest)", async () => {
    const provider = await BdkOnchain.open({ config: { network: "regtest", esplora, script: "bip84" }, secrets: { mnemonic: generateMnemonic(wordlist) } }, { signal: new AbortController().signal }, { bdk: nodeBdk });
    return {
      provider, network: "regtest",
      recipient: () => regtest!.address(),
      fund: async (amount) => {
        await regtest!.send(await provider.receiveAddress(), amount);
        // electrs answers the new tip a moment before it has indexed the block's transactions.
        await vi.waitFor(async () => { await provider.sync(true); if ((await provider.balance()).confirmed < amount) throw new Error("not yet"); }, { timeout: 20_000, interval: 500 });
      },
    };
  }, { timeout: 30_000 });
} else it.skip("BDK (regtest): set GHOSTLY_BDK_REGTEST=1 with e2e/support/bdk-regtest running", () => {});
