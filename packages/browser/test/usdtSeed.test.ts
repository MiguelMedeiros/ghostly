import { afterEach, expect, it, vi } from "vitest";
import { AbiCoder, Transaction, keccak256 } from "ethers";
import type { WalletAccountEvm } from "@tetherto/wdk-wallet-evm";
import { UsdtAdapter, type UsdtConfig } from "../src/engine/paymentAdapters/usdt";
// covers: wallet.usdt.send

// The real WDK, not a stand-in: `connect` wipes the seed bytes right after handing them over, so the wallet must have
// made its own key from them by then. A WDK that kept the bytes and derived later would sign for the all-zero seed.
// Which way each seed was made: the browser's PBKDF2 (WebCrypto) or the one in script, which holds the thread.
const seeds = vi.hoisted(() => [] as Uint8Array[]);
const made = vi.hoisted(() => [] as ("webcrypto" | "script")[]);
vi.mock("@scure/bip39", async (original) => {
  const bip39 = await original<typeof import("@scure/bip39")>();
  return {
    ...bip39,
    mnemonicToSeedSync: (...args: Parameters<typeof bip39.mnemonicToSeedSync>) => { const seed = bip39.mnemonicToSeedSync(...args); seeds.push(seed); made.push("script"); return seed; },
    mnemonicToSeedWebcrypto: async (...args: Parameters<typeof bip39.mnemonicToSeedWebcrypto>) => { const seed = await bip39.mnemonicToSeedWebcrypto(...args); seeds.push(seed); made.push("webcrypto"); return seed; },
  };
});

const MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // m/44'/60'/0'/0/0 of MNEMONIC
const CODE = "0x6000";
const config: UsdtConfig = { network: "evm-local", provider: "http://127.0.0.1:5660", chainId: 31337, token: "0x" + "1".repeat(40), decimals: 6, codeHash: keccak256(CODE) };
const answers: Record<string, string> = { eth_chainId: "0x7a69", eth_getCode: CODE, eth_call: AbiCoder.defaultAbiCoder().encode(["uint8"], [6]) };

afterEach(() => { vi.unstubAllGlobals(); seeds.length = 0; made.length = 0; });

it("signs for the mnemonic's account after the seed bytes it was given are wiped, and wipes its key on dispose", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { id, method } = JSON.parse(init.body);
    return Response.json({ jsonrpc: "2.0", id, result: answers[method] });
  });
  const adapter = await UsdtAdapter.connect(config, MNEMONIC);
  expect(seeds).toHaveLength(1);
  expect(seeds[0].every((byte) => byte === 0)).toBe(true);
  expect(await adapter.address()).toBe(ACCOUNT_0);
  const account = (adapter as unknown as { account: WalletAccountEvm }).account;
  const raw = await account.signTransaction({ type: 2, to: config.token, data: "0x", value: 0n, chainId: 31337, nonce: 0, gasLimit: 60_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n });
  expect(Transaction.from(raw).from).toBe(ACCOUNT_0);
  const key = account.keyPair?.privateKey;
  expect(key?.some((byte) => byte !== 0)).toBe(true);
  await adapter.dispose();
  expect(key?.every((byte) => byte === 0)).toBe(true);
  expect(() => adapter.address()).toThrow("Unlock the USDT wallet first");
});

// Every start opens a wallet that opens by itself: its seed's 2,048 rounds of PBKDF2 in script held the page's thread
// each time (about 80 ms of a 230 ms task on a phone-speed CPU). The browser's own PBKDF2 makes the same bytes.
it("makes the seed with the browser's own PBKDF2, not one in script, for the same account", async () => {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { id, method } = JSON.parse(init.body);
    return Response.json({ jsonrpc: "2.0", id, result: answers[method] });
  });
  const adapter = await UsdtAdapter.connect(config, MNEMONIC);
  expect(made).toEqual(["webcrypto"]);
  expect(await adapter.address()).toBe(ACCOUNT_0);
  await adapter.dispose();
});
