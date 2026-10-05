import type { BrowserContext } from "@playwright/test";

/** The public RPCs a USDT wallet is made with (packages/core USDT_PUBLIC_RPC), and the chain each answers as. */
const CHAINS = {
  ethereum: { url: /^https:\/\/ethereum\.publicnode\.com/, chainId: "0x1" },
  sepolia: { url: /^https:\/\/ethereum-sepolia-rpc\.publicnode\.com/, chainId: "0xaa36a7" },
} as const;

/**
 * USDT without the public RPC: the Ethereum RPC a USDT wallet is made with (ethereum.publicnode.com for Mainnet,
 * ethereum-sepolia-rpc.publicnode.com for Testnet) is answered here, as a chain with the token contract (6 decimals)
 * and nothing in this wallet. No real RPC is reached.
 */
export async function mockEthereum(context: BrowserContext, chain: keyof typeof CHAINS = "ethereum"): Promise<void> {
  const { url, chainId } = CHAINS[chain];
  const answer = ({ id, method, params }: { id: number; method: string; params?: unknown[] }) => {
    const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    const data = String((params?.[0] as { data?: string } | undefined)?.data ?? "");
    const result = method === "eth_chainId" ? chainId : method === "eth_getCode" ? "0x6080604052" : method === "eth_call" ? word(data.startsWith("0x313ce567") ? 6 : 0)
      : method === "eth_getLogs" ? [] : method === "eth_blockNumber" ? "0x1000" : "0x0";
    return { jsonrpc: "2.0", id, result };
  };
  await context.route(url, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  });
}
