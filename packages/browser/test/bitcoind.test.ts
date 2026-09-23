import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentTarget } from "@ghostly/core";
import { BitcoindOnchain, bitcoindRpc, btcToSats, credentials, satsToBtc, type BitcoindCall, type BitcoindTransport } from "../src/engine/paymentAdapters/providers/bitcoind";
import { BitcoinService } from "../src/engine/paymentAdapters/providers/bitcoinService";
import type { OnchainProviderDescriptor } from "../src/engine/paymentAdapters/providers/onchain";
import { offeredIn } from "../src/engine/paymentAdapters/providers/registry";
import { fakeAddress } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError, type ProviderHost } from "../src/engine/paymentAdapters/providers/types";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { describeOnchainProvider } from "./helpers/providerContract";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { p2pkh } from "@scure/btc-signer";
import { MockBitcoind, REGTEST } from "./helpers/mockBitcoind";

const CONFIG = { url: "http://127.0.0.1:18443", wallet: "ghostly", user: "u", password: "test-only-password" };
const connect = (node: MockBitcoind, transport: BitcoindTransport = node.transport) => BitcoindOnchain.connect(CONFIG, "testnet", transport);
const methods = (node: MockBitcoind) => node.calls.map((c) => c.method);

describeOnchainProvider("Bitcoin Core (mocked RPC)", async () => {
  const node = new MockBitcoind();
  return { provider: await connect(node), network: "regtest", recipient: fakeAddress, fund: async (amount) => node.fund(amount) };
});

describe("Bitcoin Core source", () => {
  it("writes amounts as exact BTC strings and reads them back as whole sats", () => {
    expect(satsToBtc(1_000)).toBe("0.00001000");
    expect(satsToBtc(2_100_000_000_000_000)).toBe("21000000.00000000");
    expect(satsToBtc(1)).toBe("0.00000001");
    expect(() => satsToBtc(1.5)).toThrow();
    expect(btcToSats(0.00001)).toBe(1_000);
    expect(btcToSats(0.29)).toBe(29_000_000);
    expect(btcToSats(-0.0000141)).toBe(-1_410);
    expect(() => btcToSats("1")).toThrow();
  });

  it("is offered on Desktop only, in both modes, and says so", () => {
    expect(offeredIn(bitcoindRpc, "desktop", "testnet") && offeredIn(bitcoindRpc, "desktop", "mainnet")).toBe(true);
    expect(offeredIn(bitcoindRpc, "web", "testnet") || offeredIn(bitcoindRpc, "extension", "mainnet")).toBe(false);
    expect(bitcoindRpc.description).toContain("desktop app");
    expect(bitcoindRpc.fields.filter((f) => f.kind === "secret").map((f) => f.name)).toEqual(["password"]);
  });

  it("checks the form: an address without credentials in it, a plain wallet name, a user and password or a cookie", () => {
    const check = (config: Record<string, string>, secrets: Record<string, string>) => () => bitcoindRpc.validate!({ config, secrets }, "testnet");
    expect(check({ url: "http://127.0.0.1:18443", wallet: "w", user: "u" }, { password: "p" })).not.toThrow();
    expect(check({ url: "http://127.0.0.1:18443" }, { password: "__cookie__:abcd" })).not.toThrow();
    expect(check({ url: "http://u:p@127.0.0.1:18443", user: "u" }, { password: "p" })).toThrow("own fields");
    expect(check({ url: "ftp://127.0.0.1" , user: "u" }, { password: "p" })).toThrow("RPC address");
    expect(check({ url: "http://127.0.0.1:18443", wallet: "../x", user: "u" }, { password: "p" })).toThrow("wallet name");
    expect(check({ url: "http://127.0.0.1:18443", user: "u" }, { password: "" })).toThrow("password");
    expect(check({ url: "http://127.0.0.1:18443" }, { password: "nocolon" })).toThrow("password");
    expect(credentials({ config: {}, secrets: { password: "__cookie__:ab:cd" } })).toEqual({ user: "__cookie__", password: "ab:cd" });
    expect(credentials({ config: { user: "alice" }, secrets: { password: "a:b" } })).toEqual({ user: "alice", password: "a:b" });
  });

  it("refuses a node on a network of the other mode, a chain it does not know, and a wallet that cannot sign", async () => {
    const node = new MockBitcoind();
    node.chain = "main";
    await expect(connect(node)).rejects.toThrow("Mainnet mode");
    await expect(BitcoindOnchain.connect(CONFIG, "mainnet", node.transport)).resolves.toBeInstanceOf(BitcoindOnchain);
    node.chain = "signet";
    await expect(BitcoindOnchain.connect(CONFIG, "mainnet", node.transport)).rejects.toThrow("not Bitcoin mainnet");
    await expect(connect(node)).resolves.toBeInstanceOf(BitcoindOnchain);
    node.chain = "liquidv1";
    await expect(connect(node)).rejects.toThrow("does not know");
    node.chain = "regtest"; node.privateKeys = false;
    await expect(connect(node)).rejects.toThrow("no private keys");
  });

  it("reaches the node only through the Desktop host's bitcoind_rpc command", async () => {
    const node = new MockBitcoind();
    const settings = { config: { url: CONFIG.url, wallet: "ghostly", user: "u" }, secrets: { password: CONFIG.password } };
    const host = { platform: "desktop" as const, mode: "testnet" as const, cashu: {} as CashuWallet, signal: new AbortController().signal };
    await expect(bitcoindRpc.create(settings, host)).rejects.toThrow("desktop app");
    const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => { expect(command).toBe("bitcoind_rpc"); return node.transport(args as unknown as BitcoindCall); });
    const controller = new AbortController();
    const provider = await bitcoindRpc.create(settings, { ...host, signal: controller.signal, invoke: invoke as ProviderHost["invoke"] });
    expect(invoke).toHaveBeenCalledWith("bitcoind_rpc", { ...CONFIG, method: "getblockchaininfo", params: [] });
    controller.abort();
    await expect(provider.balance()).rejects.toThrow("closed");
  });

  it("sends the credentials apart from the address, to the configured wallet", async () => {
    const node = new MockBitcoind();
    const provider = await connect(node);
    await provider.receiveAddress();
    expect(node.calls.every((c) => c.url === CONFIG.url && c.wallet === "ghostly" && c.user === "u" && c.password === CONFIG.password)).toBe(true);
    await provider.close();
    await expect(provider.balance()).rejects.toThrow("closed");
  });

  it("locks the coins of a prepared payment, signs without broadcasting, and unlocks them when the review is cancelled", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
    expect(node.locked.size).toBe(1);
    expect(methods(node)).not.toContain("sendrawtransaction");
    expect(prepared.feeRate).toBe(2); // regtest cannot estimate: the test-network fallback
    expect(prepared.signed).toMatch(/^[0-9a-f]+$/);
    await provider.release(prepared);
    expect(node.locked.size).toBe(0);
  });

  it("refuses a fee above the cap before signing, and a transaction that does not pay what was asked", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    await expect(provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 10, feeRate: 5 })).rejects.toThrow("above your limit");
    expect(methods(node)).not.toContain("walletprocesspsbt");
    expect(node.locked.size).toBe(0);

    // A node that pays someone else than the person asked.
    const liar: BitcoindTransport = (call) => node.transport(call.method === "walletcreatefundedpsbt" ? { ...call, params: [[], [{ [fakeAddress()]: "0.00010000" }], 0, call.params[3]] } : call);
    const lying = await connect(node, liar);
    await expect(lying.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 })).rejects.toThrow("does not pay");
    expect(node.locked.size).toBe(0);
    expect(methods(node)).not.toContain("sendrawtransaction");
  });

  it("says nothing was spent only when the node never ran the broadcast or rejected it, and unlocks then", async () => {
    for (const failure of [
      { kind: "connect", message: "The node is unreachable" },
      { kind: "auth", message: "The node refused the RPC user and password" },
      { kind: "refused", message: "Request too large" },
      { kind: "rpc", code: -26, message: "min relay fee not met" },
      { kind: "rpc", code: -25, message: "bad-txns-inputs-missingorspent" },
    ] as const) {
      const node = new MockBitcoind(); node.fund(50_000);
      const provider = await connect(node);
      const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
      node.failNext("sendrawtransaction", failure);
      await expect(provider.broadcast(prepared)).rejects.toBeInstanceOf(NothingSpentError);
      expect(node.locked.size).toBe(0);
    }
  });

  it("treats anything else as unknown, and a lost answer is found again in the mempool", async () => {
    for (const failure of [{ kind: "transport", message: "The node timed out" }, { kind: "rpc", code: -1, message: "odd" }, new Error("Not running in Tauri")]) {
      const node = new MockBitcoind(); node.fund(50_000);
      const provider = await connect(node);
      const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
      node.failNext("sendrawtransaction", failure);
      const error = await provider.broadcast(prepared).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NothingSpentError);
      expect(node.locked.size).toBe(1); // Still reserved: it may yet go out.
    }
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
    node.loseNextBroadcastAnswer = true;
    await expect(provider.broadcast(prepared)).rejects.not.toBeInstanceOf(NothingSpentError);
    expect(await provider.status(prepared)).toEqual({ state: "mempool", confirmations: 0 });
  });

  it("a re-broadcast the node rejects, of a transaction that went out before, is not 'nothing spent' and keeps its coins", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
    await provider.broadcast(prepared);
    node.drop(prepared.txid); // Out of this node's mempool; other nodes may still relay it.
    for (const failure of [{ kind: "rpc", code: -26, message: "mempool min fee not met" }, { kind: "connect", message: "The node is unreachable" }] as const) {
      node.failNext("sendrawtransaction", failure);
      const error = await provider.broadcast(prepared).catch((e: unknown) => e);
      if (failure.kind === "rpc") expect(error).not.toBeInstanceOf(NothingSpentError);
      expect(methods(node).filter((m) => m === "lockunspent")).toEqual([]);
    }
  });

  it("pays a legacy (base58) address as well as a bech32 one", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const legacy = p2pkh(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), REGTEST).address!;
    expect(legacy).toMatch(/^[mn]/);
    expect(await provider.prepareSend({ address: legacy, amount: 10_000, feeCap: 1_000 })).toMatchObject({ address: legacy, amount: 10_000 });
  });

  it("follows a transaction: missing, in the mempool, confirmed, conflicted; re-broadcasting it is harmless", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
    expect(await provider.status(prepared)).toEqual({ state: "missing", confirmations: 0 });
    expect(await provider.broadcast(prepared)).toBe(prepared.txid);
    expect((await provider.status(prepared)).state).toBe("mempool");
    node.drop(prepared.txid);
    expect((await provider.status(prepared)).state).toBe("missing");
    expect(await provider.broadcast(prepared)).toBe(prepared.txid);
    node.mine();
    expect(await provider.status(prepared)).toEqual({ state: "confirmed", confirmations: 1 });
    // Already in a block: bitcoind says so with -27, which is success.
    expect(await provider.broadcast(prepared)).toBe(prepared.txid);
    node.txs.get(prepared.txid)!.confirmations = -2;
    expect((await provider.status(prepared)).state).toBe("conflicted");
  });

  it("refuses to broadcast a prepared payment whose transaction is not the reviewed one", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
    await expect(provider.broadcast({ ...prepared, txid: "0".repeat(64) })).rejects.toThrow("not the one reviewed");
    expect(methods(node)).not.toContain("sendrawtransaction");
  });

  it("lists one line per transaction, newest first, net of change, with the fee and a time in ms", async () => {
    const node = new MockBitcoind(); node.fund(50_000);
    const provider = await connect(node);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 10_000, feeCap: 1_000 });
    await provider.broadcast(prepared);
    const history = await provider.history(10);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ txid: prepared.txid, amount: -10_000, fee: prepared.fee, confirmations: 0, timestamp: 1_700_000_000_000 });
    expect(history[1]).toMatchObject({ amount: 50_000, confirmations: 1 });
    expect(await provider.history(1)).toHaveLength(1);
  });
});

describe("Bitcoin Core through the payment coordinator", () => {
  beforeEach(async () => { await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); }); });
  const target = (address: string): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });

  async function engine(node: MockBitcoind) {
    const descriptor: OnchainProviderDescriptor = { ...bitcoindRpc, platforms: ["web"], create: (s, host) => BitcoindOnchain.connect({ ...CONFIG, url: s.config.url }, host.mode, node.transport, host.signal) };
    const service = new BitcoinService(() => [descriptor], () => ({ platform: "web", cashu: {} as CashuWallet }), vi.fn());
    await service.start("testnet");
    await service.sources.set("bitcoind", { url: CONFIG.url, user: "u", password: CONFIG.password });
    return { service, coordinator: new PaymentCoordinator(intentRepository, [service.adapter]) };
  }

  it("reviews, broadcasts on approval, settles once mined; a lost answer is reconciled with the same transaction", async () => {
    const node = new MockBitcoind(); node.fund(100_000);
    const { service, coordinator } = await engine(node);
    expect(await service.receiveAddress()).toMatch(/^bcrt1/);

    const review = await coordinator.prepare(target(fakeAddress()), 10_000, 2_000, { payee: "x" });
    expect(methods(node)).not.toContain("sendrawtransaction");
    const approved = await coordinator.approve(review.id);
    expect(approved).toMatchObject({ state: "submitted" });
    node.mine();
    expect(await coordinator.reconcile(review.id)).toMatchObject({ state: "settled", txid: approved.txid });

    node.loseNextBroadcastAnswer = true;
    const lost = await coordinator.prepare(target(fakeAddress()), 10_000, 2_000, { payee: "x" });
    expect(await coordinator.approve(lost.id)).toMatchObject({ state: "unknown" });
    // It did go out, then the mempool forgot it: reconciling sends the very same transaction again.
    node.drop(((await intentRepository.get(lost.id))!.prepared as { txid: string }).txid);
    expect(await coordinator.reconcile(lost.id)).toMatchObject({ state: "submitted" });
    node.mine();
    expect(await coordinator.reconcile(lost.id)).toMatchObject({ state: "settled" });
    const broadcastTxids = new Set(node.calls.filter((c) => c.method === "sendrawtransaction").map((c) => c.params[0]));
    expect(broadcastTxids.size).toBe(2); // Two payments, each one transaction however many times it was sent.
  });

  it("a rejected broadcast fails cleanly and gives the coins back; a cancelled review unlocks them", async () => {
    const node = new MockBitcoind(); node.fund(100_000);
    const { coordinator } = await engine(node);
    const refused = await coordinator.prepare(target(fakeAddress()), 10_000, 2_000, { payee: "x" });
    node.failNext("sendrawtransaction", { kind: "rpc", code: -26, message: "min relay fee not met" });
    expect(await coordinator.approve(refused.id)).toMatchObject({ state: "failed" });
    expect(node.locked.size).toBe(0);
    const cancelled = await coordinator.prepare(target(fakeAddress()), 10_000, 2_000, { payee: "x" });
    expect(node.locked.size).toBe(1);
    await coordinator.cancel(cancelled.id);
    expect(node.locked.size).toBe(0);
  });
});
