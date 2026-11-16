import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { BdkOnchain } from "../src/engine/paymentAdapters/providers/bdk";
import { FakeEsplora } from "./helpers/fakeEsplora";
import { nodeBdk } from "./helpers/bdkNode";
// covers: wallet.onchain.bdk.create

// Which way each seed was made: the browser's PBKDF2 (WebCrypto) or the one in script, which holds the thread.
const made = vi.hoisted(() => [] as ("webcrypto" | "script")[]);
vi.mock("@scure/bip39", async (original) => {
  const bip39 = await original<typeof import("@scure/bip39")>();
  return {
    ...bip39,
    mnemonicToSeedSync: (...args: Parameters<typeof bip39.mnemonicToSeedSync>) => { made.push("script"); return bip39.mnemonicToSeedSync(...args); },
    mnemonicToSeedWebcrypto: (...args: Parameters<typeof bip39.mnemonicToSeedWebcrypto>) => { made.push("webcrypto"); return bip39.mnemonicToSeedWebcrypto(...args); },
  };
});

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
afterEach(() => { vi.unstubAllGlobals(); made.length = 0; });

// A saved BDK wallet opens at every start and at every reconnect: its seed's 2,048 rounds of PBKDF2 in script held the
// page's thread each time (about 35 ms on a desktop CPU). The browser's own PBKDF2 makes the same bytes.
it("makes the seed with the browser's own PBKDF2, not one in script, for the same wallet", async () => {
  const esplora = new FakeEsplora();
  vi.stubGlobal("fetch", esplora.fetch);
  const provider = await BdkOnchain.open({ config: { network: "regtest", esplora: "http://127.0.0.1:44299", script: "bip84" }, secrets: { mnemonic: ABANDON } }, { signal: new AbortController().signal }, { bdk: nodeBdk, fetch: esplora.fetch });
  expect(made).toEqual(["webcrypto"]);
  // BIP84's first receive address of the "abandon … about" phrase (its key hash is the BIP84 test vector's), on regtest.
  expect(await provider.receiveAddress()).toBe("bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk");
});
