import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentTarget } from "@ghostly/core";
import { BitcoindOnchain, bitcoindRpc, satsToBtc, type BitcoindCall, type BitcoindConfig, type BitcoindRpcFailure, type BitcoindTransport } from "../src/engine/paymentAdapters/providers/bitcoind";
import { BitcoinService } from "../src/engine/paymentAdapters/providers/bitcoinService";
import type { OnchainProviderDescriptor } from "../src/engine/paymentAdapters/providers/onchain";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import type { CashuWallet } from "../src/engine/wallet";
import { describeOnchainProvider } from "./helpers/providerContract";
import { endpoints } from "../../../e2e/infra/env.mjs";
// covers-gated: wallet.onchain.bitcoind, wallet.onchain.provider-contract, payments.chat.reconcile

/**
 * The Bitcoin Core source against a real regtest bitcoind (see e2e/README.md, "Bitcoin Core on regtest"): e2e/infra's
 * by default (npm run e2e:infra:up), or any other through GHOSTLY_BITCOIND_RPC_URL / _USER / _PASSWORD.
 *
 *   GHOSTLY_BITCOIND_REGTEST=1 npx vitest run test/bitcoind.regtest.test.ts
 *
 * Node has no CORS, so this reaches the node with `fetch`, standing in for the Tauri command (which has
 * Rust tests of its own). Each run makes wallets of its own; nothing is ever unloaded or stopped.
 */
const enabled = process.env.GHOSTLY_BITCOIND_REGTEST === "1";
const { url: URL, user: USER, password: PASSWORD } = endpoints.bitcoind;
const run = crypto.randomUUID().slice(0, 8);

/** What `bitcoind_rpc` does, over fetch: the same failure kinds. */
const fetchTransport: BitcoindTransport = async ({ url, wallet, user, password, method, params }: BitcoindCall) => {
  let response: Response;
  try {
    response = await fetch(wallet && !["getblockchaininfo", "estimatesmartfee", "finalizepsbt", "sendrawtransaction", "getmempoolentry"].includes(method) ? `${url}/wallet/${wallet}` : url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Basic ${btoa(`${user}:${password}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: "ghostly", method, params }),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    throw { kind: code === "ECONNREFUSED" ? "connect" : "transport", message: "The node is unreachable" } satisfies BitcoindRpcFailure;
  }
  if (response.status === 401 || response.status === 403) throw { kind: "auth", message: "The node refused the RPC user and password" } satisfies BitcoindRpcFailure;
  const reply = await response.json().catch(() => null) as { result: unknown; error: { code: number; message: string } | null } | null;
  if (!reply) throw { kind: "transport", message: `HTTP ${response.status}` } satisfies BitcoindRpcFailure;
  if (reply.error) throw { kind: "rpc", code: reply.error.code, message: reply.error.message } satisfies BitcoindRpcFailure;
  return reply.result;
};

/** The test's own hands on the node: any method, as the operator. */
const rpc = async <T = unknown>(method: string, params: unknown[] = [], wallet = "") =>
  (await fetchTransport({ url: URL, wallet, user: USER, password: PASSWORD, method, params })) as T;
const miner = `ghostly-miner-${run}`;
const mine = async (blocks = 1) => rpc("generatetoaddress", [blocks, await rpc<string>("getnewaddress", [], miner)]);
const config = (wallet: string): BitcoindConfig => ({ url: URL, wallet, user: USER, password: PASSWORD });

async function freshWallet(name: string) {
  await rpc("createwallet", [name]);
  return BitcoindOnchain.connect(config(name), "testnet", fetchTransport);
}
/** The miner pays `address` and a block confirms it. */
async function pay(address: string, sats: number) {
  const txid = await rpc<string>("sendtoaddress", [address, satsToBtc(sats)], miner);
  await mine();
  return txid;
}

describe.skipIf(!enabled)("Bitcoin Core on regtest", () => {
  const log: string[] = [];
  beforeAll(async () => {
    if (!PASSWORD) throw new Error("Set GHOSTLY_BITCOIND_RPC_PASSWORD");
    await rpc("createwallet", [miner]);
    await mine(101); // A spendable coinbase.
  }, 60_000);
  afterAll(() => { if (log.length) console.log(`Bitcoin Core regtest evidence:\n  ${log.join("\n  ")}`); });

  let counter = 0;
  describeOnchainProvider("Bitcoin Core (regtest)", async () => {
    const provider = await freshWallet(`ghostly-contract-${run}-${++counter}`);
    return {
      provider, network: "regtest",
      recipient: () => rpc<string>("getnewaddress", [], miner),
      fund: async (amount) => { await pay(await provider.receiveAddress(), amount * 2); },
    };
  }, { timeout: 20_000 });

  it("receives mined coins, pays through the coordinator, reconciles by txid, and the balances add up", async () => {
    const alice = `ghostly-alice-${run}`, bob = `ghostly-bob-${run}`;
    await rpc("createwallet", [alice]); await rpc("createwallet", [bob]);
    const descriptor: OnchainProviderDescriptor = { ...bitcoindRpc, platforms: ["web"], create: (s, host) => BitcoindOnchain.connect(config(s.config.wallet), host.mode, fetchTransport, host.signal) };
    const service = new BitcoinService(() => [descriptor], () => ({ platform: "web", cashu: {} as CashuWallet }), vi.fn());
    await service.start("testnet");
    await service.sources.set("bitcoind", { url: URL, wallet: alice, user: USER, password: PASSWORD });
    const coordinator = new PaymentCoordinator(intentRepository, [service.adapter]);
    const provider = service.sources.active!;

    // Receive: an address of Alice's wallet, paid by the miner.
    const address = await service.receiveAddress();
    expect(address).toMatch(/^bcrt1/);
    const funding = await pay(address, 100_000);
    expect(await provider.balance()).toEqual({ confirmed: 100_000, unconfirmed: 0 });
    log.push(`funded ${alice}: ${funding} (100000 sats, mined)`);

    // Send 25,000 sats to Bob: reviewed (signed, locked, not broadcast), then approved.
    const bobAddress = await rpc<string>("getnewaddress", [], bob);
    const target: PaymentTarget = { method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address: bobAddress, expiresAt: Date.now() + 600_000 };
    const review = await coordinator.prepare(target, 25_000, 2_000, { payee: "bob" });
    expect(await rpc<unknown[]>("listlockunspent", [], alice)).toHaveLength(1);
    expect(await rpc<number>("getmempoolinfo").then((m) => (m as { size: number }).size)).toBe(0);
    const approved = await coordinator.approve(review.id);
    expect(approved).toMatchObject({ state: "submitted" });
    expect(await coordinator.reconcile(review.id)).toMatchObject({ state: "submitted" });
    await mine();
    expect(await coordinator.reconcile(review.id)).toMatchObject({ state: "settled", txid: approved.txid });
    log.push(`sent 25000 sats ${alice} -> ${bob}: ${approved.txid} (fee ${review.fee} sats), settled after 1 block`);

    const balance = await provider.balance();
    expect(balance).toEqual({ confirmed: 100_000 - 25_000 - review.fee, unconfirmed: 0 });
    expect((await rpc<{ mine: { trusted: number } }>("getbalances", [], bob)).mine.trusted).toBe(0.00025);
    log.push(`balances: ${alice} ${balance.confirmed} sats, ${bob} 25000 sats`);
    const history = await provider.history(10);
    expect(history[0]).toMatchObject({ txid: approved.txid, amount: -25_000, fee: review.fee, confirmations: 1 });
    expect(history[1]).toMatchObject({ txid: funding, amount: 100_000 });

    // A cancelled review gives its coins back.
    const cancelled = await coordinator.prepare(target, 5_000, 2_000, { payee: "bob" });
    expect(await rpc<unknown[]>("listlockunspent", [], alice)).toHaveLength(1);
    await coordinator.cancel(cancelled.id);
    expect(await rpc<unknown[]>("listlockunspent", [], alice)).toHaveLength(0);
    await service.stop();
  }, 60_000);

  it("a transaction the node rejects spent nothing and its coins are free again; a refused password never runs", async () => {
    const wallet = `ghostly-reject-${run}`;
    const provider = await freshWallet(wallet);
    await pay(await provider.receiveAddress(), 50_000);
    const recipient = await rpc<string>("getnewaddress", [], miner);
    const first = await provider.prepareSend({ address: recipient, amount: 10_000, feeCap: 2_000 });
    // Spend the same coin elsewhere first: the reviewed transaction now conflicts and is rejected.
    await rpc("lockunspent", [true], wallet);
    const other = await rpc<string>("sendtoaddress", [recipient, satsToBtc(20_000)], wallet);
    await expect(provider.broadcast(first)).rejects.toBeInstanceOf(NothingSpentError);
    expect(await rpc<unknown[]>("listlockunspent", [], wallet)).toHaveLength(0);
    expect((await provider.status(first)).state).toBe("missing");
    log.push(`rejected (conflict with ${other}): ${first.txid} -> NothingSpentError, inputs unlocked`);

    const wrong = await BitcoindOnchain.connect({ ...config(wallet), password: "wrong" }, "testnet", fetchTransport).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ kind: "auth" });
    expect(String((wrong as Error).message)).not.toContain(PASSWORD);
    await expect(BitcoindOnchain.connect(config(wallet), "mainnet", fetchTransport)).rejects.toThrow("not Bitcoin mainnet");
  }, 60_000);
});
