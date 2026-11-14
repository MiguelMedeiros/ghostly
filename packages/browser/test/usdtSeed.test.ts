import { afterEach, expect, it, vi } from "vitest";
import { AbiCoder, Transaction, keccak256 } from "ethers";
import type { WalletAccountEvm } from "@tetherto/wdk-wallet-evm";
import { UsdtAdapter, type UsdtConfig } from "../src/engine/paymentAdapters/usdt";
// covers: wallet.usdt.send

// The real WDK, not a stand-in: `connect` wipes the seed bytes right after handing them over, so the wallet must have
// made its own key from them by then. A WDK that kept the bytes and derived later would sign for the all-zero seed.
const seeds = vi.hoisted(() => [] as Uint8Array[]);
vi.mock("@scure/bip39", async (original) => {
  const bip39 = await original<typeof import("@scure/bip39")>();
  return { ...bip39, mnemonicToSeedSync: (...args: Parameters<typeof bip39.mnemonicToSeedSync>) => { const seed = bip39.mnemonicToSeedSync(...args); seeds.push(seed); return seed; } };
});

const MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // m/44'/60'/0'/0/0 of MNEMONIC
const CODE = "0x6000";
const config: UsdtConfig = { network: "evm-local", provider: "http://127.0.0.1:5660", chainId: 31337, token: "0x" + "1".repeat(40), decimals: 6, codeHash: keccak256(CODE) };
const answers: Record<string, string> = { eth_chainId: "0x7a69", eth_getCode: CODE, eth_call: AbiCoder.defaultAbiCoder().encode(["uint8"], [6]) };

afterEach(() => { vi.unstubAllGlobals(); seeds.length = 0; });

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
