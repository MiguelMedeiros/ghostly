import { expect, it, vi } from "vitest";
import { Interface, Wallet, keccak256 } from "ethers";
import { SEPOLIA_TEST_USDT, SEPOLIA_TEST_USDT_FAUCET, TEST_USDT_FAUCET_AMOUNT, ETHEREUM_USDT } from "@ghostly/core";
import { UsdtAdapter } from "../src/engine/paymentAdapters/usdt";
// covers: wallet.usdt.faucet

const faucet = new Interface(["function mint(address token,address to,uint256 amount) returns (uint256)"]);
function adapter(config: object, gas = "1000000000000000000") {
  const signer = Wallet.createRandom();
  const Adapter = UsdtAdapter as unknown as new (config: object) => UsdtAdapter;
  const a = new Adapter({ network: "sepolia", chainId: 11155111, provider: "https://rpc.invalid", token: SEPOLIA_TEST_USDT, decimals: 6, codeHash: keccak256("0x6000"), ...config });
  const sent: string[] = [];
  Object.assign(a, { account: { getAddress: async () => signer.address, signTransaction: (tx: object) => signer.signTransaction(tx), sendTransaction: async (raw: string) => { sent.push(raw); } } });
  vi.spyOn(a, "rpc").mockImplementation((async (method: string) => ({
    eth_chainId: "0xaa36a7", eth_getCode: "0x6000", eth_getTransactionCount: "0x3", eth_estimateGas: "0xf887", eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_call: "0x" + "0".repeat(64), eth_getBalance: "0x" + BigInt(gas).toString(16),
  } as Record<string, unknown>)[method]) as never);
  return { a, sent, signer };
}

it("asks the fixed Sepolia faucet for test USDT, to this wallet only", async () => {
  const { a, sent, signer } = adapter({});
  await a.mintTestTokens();
  const { Transaction } = await import("ethers");
  const tx = Transaction.from(sent[0]);
  expect(tx.to?.toLowerCase()).toBe(SEPOLIA_TEST_USDT_FAUCET.toLowerCase());
  expect(tx.chainId).toBe(11155111n);
  expect(tx.value).toBe(0n);
  const [token, to, amount] = faucet.decodeFunctionData("mint", tx.data);
  expect([String(token).toLowerCase(), String(to), amount]).toEqual([SEPOLIA_TEST_USDT.toLowerCase(), signer.address, BigInt(TEST_USDT_FAUCET_AMOUNT)]);
});

it("refuses anywhere but Sepolia's test token, and without gas", async () => {
  await expect(adapter({ network: "ethereum", chainId: 1, token: ETHEREUM_USDT }).a.mintTestTokens()).rejects.toThrow("Sepolia only");
  await expect(adapter({ network: "evm-local", chainId: 31337, token: "0x" + "1".repeat(40) }).a.mintTestTokens()).rejects.toThrow("Sepolia only");
  const broke = adapter({}, "0");
  await expect(broke.a.mintTestTokens()).rejects.toThrow("Sepolia ETH for gas");
  expect(broke.sent).toEqual([]);
});
