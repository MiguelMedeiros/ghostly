import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HDNodeWallet, Interface, Transaction, getAddress, keccak256 } from "ethers";
import { ETHEREUM_USDT, PaymentPreflightError, USDT_PUBLIC_RPC, validatePaymentTarget, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { UsdtAdapter, type UsdtConfig, type UsdtPrepared } from "../src/engine/paymentAdapters/usdt";
import { PaymentCoordinator, type IntentRepository, type SavedIntent } from "../src/engine/paymentAdapters/coordinator";
// covers: payments.usdt.send, payments.chat.reconcile, payments.amounts, wallet.usdt.send

// WDK derives the account from the seed and relays through the adapter's own RPC; this stand-in does the same with ethers.
vi.mock("@tetherto/wdk-wallet-evm", () => ({
  default: class {
    private node: HDNodeWallet;
    constructor(seed: Uint8Array, private config: { provider: { request(a: { method: string; params: unknown[] }): Promise<unknown> } }) { this.node = HDNodeWallet.fromSeed(seed.slice()).derivePath("m/44'/60'/0'/0/0"); }
    async getAccount() {
      const node = this.node, provider = this.config.provider;
      return { getAddress: async () => node.address, signTransaction: (tx: object) => node.signTransaction(tx), sendTransaction: (raw: string) => provider.request({ method: "eth_sendRawTransaction", params: [raw] }) };
    }
    dispose() {}
  },
}));
// The real seal is a 600k-iteration PBKDF2; a transparent one keeps the tests fast and still binds the password.
vi.mock("../src/engine/paymentAdapters/persistence", () => ({
  sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...new TextEncoder().encode(JSON.stringify([password, seed]))] }),
  unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => {
    const [p, seed] = JSON.parse(new TextDecoder().decode(new Uint8Array(sealed.ciphertext)));
    if (p !== password) throw new Error("Could not unlock the wallet");
    return seed;
  },
}));

const erc20 = new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const MNEMONIC = "test test test test test test test test test test test junk";
const RPC = "http://127.0.0.1:48545", TOKEN = "0x" + "1".repeat(40), BOB = "0x" + "2".repeat(40), CODE = "0x6000";
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);

/** A JSON-RPC chain behind `fetch`: token balances, nonces, a mempool that mines on demand, and faults to inject. */
type Mode = "mine" | "hold" | "revert" | "lost" | "drop";
let chain: ReturnType<typeof newChain>;
function newChain() {
  const c = {
    chainId: 31337, code: CODE, decimals: 6, baseFee: 1_000_000_000n as bigint | undefined, estimate: 50_000n, height: 100,
    tokens: new Map<string, bigint>(), eth: new Map<string, bigint>(), nonces: new Map<string, number>(),
    txs: new Map<string, { from: string; to: string; input: string; value: string; nonce: string }>(),
    receipts: new Map<string, { status: string; blockNumber: string; blockHash: string; logs: Array<{ address: string; topics: string[]; data: string }> }>(),
    blocks: new Map<string, { hash: string; timestamp: string }>(),
    sent: [] as string[], mode: "mine" as Mode, calls: [] as string[], httpDown: false, rejects: new Set<string>(),
    /** Puts a transaction in a block (one confirmation), moving tokens only if it succeeds. */
    /** Known to the node, not mined yet. */
    mempool(raw: string) {
      const tx = Transaction.from(raw);
      c.txs.set(tx.hash!, { from: tx.from!, to: tx.to!, input: tx.data, value: hex(tx.value), nonce: hex(tx.nonce) });
      return tx;
    },
    include(raw: string, status = 1) {
      const tx = c.mempool(raw), from = tx.from!.toLowerCase();
      c.nonces.set(from, tx.nonce + 1);
      const number = hex(++c.height), blockHash = keccak256(new TextEncoder().encode(number));
      c.blocks.set(number, { hash: blockHash, timestamp: hex(Math.floor(Date.now() / 1000)) });
      const logs: Array<{ address: string; topics: string[]; data: string }> = [];
      if (status === 1) {
        const [to, amount] = erc20.decodeFunctionData("transfer", tx.data) as unknown as [string, bigint];
        c.tokens.set(from, (c.tokens.get(from) ?? 0n) - amount);
        c.tokens.set(to.toLowerCase(), (c.tokens.get(to.toLowerCase()) ?? 0n) + amount);
        logs.push({ address: tx.to!, ...erc20.encodeEventLog("Transfer", [tx.from, to, amount]) });
      }
      c.receipts.set(tx.hash!, { status: hex(status), blockNumber: number, blockHash, logs });
      return tx.hash!;
    },
    advance(blocks = 1) { c.height += blocks; },
    handle(method: string, params: unknown[]): unknown {
      c.calls.push(method);
      const p = params as string[];
      switch (method) {
        case "eth_chainId": return hex(c.chainId);
        case "eth_getCode": return c.code;
        case "eth_call": {
          const data = (params[0] as { data: string }).data;
          if (data.startsWith(erc20.getFunction("decimals")!.selector)) return erc20.encodeFunctionResult("decimals", [c.decimals]);
          const [owner] = erc20.decodeFunctionData("balanceOf", data);
          return erc20.encodeFunctionResult("balanceOf", [c.tokens.get(String(owner).toLowerCase()) ?? 0n]);
        }
        case "eth_getBalance": return hex(c.eth.get(p[0].toLowerCase()) ?? 0n);
        case "eth_getTransactionCount": return hex(c.nonces.get(p[0].toLowerCase()) ?? 0);
        case "eth_estimateGas": return hex(c.estimate);
        case "eth_maxPriorityFeePerGas": return hex(1_000_000_000n);
        case "eth_blockNumber": return hex(c.height);
        case "eth_getBlockByNumber": return p[0] === "latest" ? (c.baseFee === undefined ? {} : { baseFeePerGas: hex(c.baseFee) }) : c.blocks.get(p[0]) ?? null;
        case "eth_getTransactionByHash": return c.txs.get(p[0]) ?? null;
        case "eth_getTransactionReceipt": return c.receipts.get(p[0]) ?? null;
        case "eth_sendRawTransaction": {
          c.sent.push(p[0]);
          if (c.mode === "mine") return c.include(p[0]);
          if (c.mode === "revert") return c.include(p[0], 0);
          if (c.mode === "hold") return c.mempool(p[0]).hash;
          if (c.mode === "lost") c.include(p[0]);
          throw new Error("socket hang up");
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return c;
}
beforeEach(() => {
  chain = newChain();
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    if (chain.httpDown) return new Response("", { status: 503 });
    const { id, method, params } = JSON.parse(init.body);
    if (chain.rejects.has(method)) return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } });
    try { return Response.json({ jsonrpc: "2.0", id, result: chain.handle(method, params) }); }
    catch (error) { return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } }); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const config = (over: Partial<UsdtConfig> = {}): UsdtConfig => ({ network: "evm-local", provider: RPC, chainId: 31337, token: TOKEN, decimals: 6, codeHash: keccak256(CODE), ...over });
async function wallet(tokens = 5_000_000n, eth = 10n ** 18n) {
  const adapter = await UsdtAdapter.connect(config(), MNEMONIC);
  const me = (await adapter.address()).toLowerCase();
  chain.tokens.set(me, tokens); chain.eth.set(me, eth); chain.nonces.set(me, 7);
  return { adapter, me };
}
const target = (over: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "usdt", network: "evm-local", provider: RPC, asset: "TEST-USDT", unit: "token-base", chainId: 31337, token: TOKEN, decimals: 6, address: BOB, issuedAt: Date.now() - 5_000, expiresAt: Date.now() + 60_000, ...over });
const FEE_CAP = 10 ** 15;
async function reviewed(adapter: UsdtAdapter, amount = 1_000_000, t = target()) {
  const { fee, prepared, evm } = await adapter.prepare(t, amount, FEE_CAP);
  const review: PaymentReview = { ...t, id: crypto.randomUUID(), payee: "Bob", amount, fee, feeCap: FEE_CAP, createdAt: Date.now(), state: "submitted", evm };
  return { review, prepared, fee };
}
const journal = () => vi.fn(async () => {});

describe("checking the token and RPC before a wallet is used", () => {
  it("reads the token's decimals and code fingerprint from the configured chain", async () => {
    await expect(UsdtAdapter.inspect({ network: "evm-local", provider: RPC, chainId: 31337, token: TOKEN })).resolves.toEqual(config({ token: getAddress(TOKEN) }));
  });
  it("refuses another chain or contract, a non-HTTPS or credentialed RPC, and a chain that answers differently", async () => {
    const inspect = (over: object) => UsdtAdapter.inspect({ network: "evm-local", provider: RPC, chainId: 31337, token: TOKEN, ...over } as never);
    await expect(inspect({ network: "ethereum", chainId: 1 })).rejects.toThrow("Unsupported USDT network");
    await expect(inspect({ network: "sepolia" })).rejects.toThrow("Unsupported USDT network");
    await expect(inspect({ provider: "http://rpc.example" })).rejects.toThrow("HTTPS or a loopback");
    await expect(inspect({ provider: "https://user:pw@rpc.example" })).rejects.toThrow("HTTPS or a loopback");
    await expect(inspect({ provider: "https://rpc.example/?key=1" })).rejects.toThrow("HTTPS or a loopback");
    chain.chainId = 1;
    await expect(inspect({})).rejects.toThrow("RPC chain does not match");
    chain.chainId = 31337; chain.code = "0x";
    await expect(inspect({})).rejects.toThrow("No token contract");
    chain.code = CODE; chain.decimals = 19;
    await expect(inspect({})).rejects.toThrow("Unexpected token decimals");
  });
  it("on Ethereum accepts only Tether's contract, with 6 decimals", async () => {
    chain.chainId = 1; chain.decimals = 18;
    await expect(UsdtAdapter.inspect({ network: "ethereum", provider: "https://rpc.example", chainId: 1, token: ETHEREUM_USDT })).rejects.toThrow("Unexpected token decimals");
  });
  it("an RPC that is down, errors, or answers without a result is an error, not an empty answer", async () => {
    const adapter = (await wallet()).adapter;
    chain.httpDown = true;
    await expect(adapter.rpc("eth_blockNumber")).rejects.toThrow("RPC unavailable");
    chain.httpDown = false; chain.rejects.add("eth_blockNumber");
    await expect(adapter.rpc("eth_blockNumber")).rejects.toThrow("rejected the operation");
    vi.stubGlobal("fetch", async () => Response.json({ jsonrpc: "2.0", id: 1 }));
    await expect(adapter.rpc("eth_blockNumber")).rejects.toThrow("rejected the operation");
  });
  it("will not open a wallet whose saved token metadata no longer matches the chain", async () => {
    chain.code = "0x6001";
    await expect(UsdtAdapter.connect(config(), MNEMONIC)).rejects.toThrow("Token metadata changed");
    chain.code = CODE; chain.decimals = 8;
    await expect(UsdtAdapter.connect(config(), MNEMONIC)).rejects.toThrow("Token metadata changed");
  });
  it("labels a request with real USDT only on Ethereum, and a locked wallet has no address", async () => {
    const { adapter, me } = await wallet();
    expect(await adapter.target()).toMatchObject({ method: "usdt", asset: "TEST-USDT", unit: "token-base", chainId: 31337, token: TOKEN, decimals: 6, address: getAddress(me) });
    const Adapter = UsdtAdapter as unknown as new (c: UsdtConfig) => UsdtAdapter;
    const mainnet = new Adapter(config({ network: "ethereum", chainId: 1, token: ETHEREUM_USDT }));
    Object.assign(mainnet, { account: { getAddress: async () => BOB } });
    expect((await mainnet.target()).asset).toBe("USDT");
    await adapter.dispose();
    expect(() => adapter.address()).toThrow("Unlock the USDT wallet first");
  });
});

describe("the RPC a request names", () => {
  const Adapter = UsdtAdapter as unknown as new (c: UsdtConfig) => UsdtAdapter;
  const onChain = async (over: Partial<UsdtConfig>) => {
    const adapter = new Adapter(config(over));
    Object.assign(adapter, { account: { getAddress: async () => BOB } });
    return (await adapter.target()).provider;
  };
  it("never carries this wallet's own RPC URL (a key in its path): the chain's public RPC, a local chain's origin", async () => {
    const keyed = await onChain({ network: "ethereum", chainId: 1, token: ETHEREUM_USDT, provider: "https://mainnet.infura.io/v3/not-a-real-key" });
    expect(keyed).toBe(USDT_PUBLIC_RPC.ethereum);
    expect(await onChain({ network: "sepolia", chainId: 11155111, provider: "https://eth-sepolia.g.alchemy.com/v2/not-a-real-key" })).toBe(USDT_PUBLIC_RPC.sepolia);
    expect(await onChain({ provider: `${RPC}/rpc/not-a-real-key` })).toBe(RPC);
    // What older apps read: still a URL they accept, with no path, query or credentials.
    for (const provider of [keyed, RPC]) expect(validatePaymentTarget({ ...target(), provider }).provider).toBe(provider);
  });
  it("pays a request naming another RPC through this wallet's own: the payee's is never asked", async () => {
    const { adapter } = await wallet();
    const asked: string[] = [];
    const chainFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => { asked.push(String(url)); return chainFetch(url, init); });
    const { review, prepared } = await reviewed(adapter, 1_000_000, target({ provider: "https://payee-rpc.example" }));
    expect(review.provider).toBe("https://payee-rpc.example");
    await adapter.execute(review, prepared, journal());
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((url) => url === RPC)).toBe(true);
  });
});

describe("preparing a token payment (the review)", () => {
  it("prices the worst-case gas and pins the nonce, signing and sending nothing", async () => {
    const { adapter, me } = await wallet();
    const { fee, prepared, review } = await reviewed(adapter);
    const gasLimit = (50_000n * 120n + 99n) / 100n, maxFee = 3_000_000_000n;
    expect(fee).toBe(Number(gasLimit * maxFee));
    expect(prepared).toMatchObject({ from: getAddress(me), to: getAddress(TOKEN), nonce: 7, value: "0", gasLimit: String(gasLimit), maxFeePerGas: String(maxFee) });
    expect(review.evm).toMatchObject({ nonce: 7, confirmations: 2 });
    expect(chain.sent).toEqual([]);
  });
  it("refuses a request for another chain, token or precision, or one that pays itself or the token", async () => {
    const { adapter, me } = await wallet();
    for (const over of [{ chainId: 11155111, network: "sepolia" as const }, { token: "0x" + "3".repeat(40) }, { decimals: 18 }])
      await expect(adapter.prepare(target(over), 1, FEE_CAP)).rejects.toThrow(/does not match|Token metadata/);
    await expect(adapter.prepare(target({ address: getAddress(me) }), 1, FEE_CAP)).rejects.toThrow("different recipient");
    await expect(adapter.prepare(target({ address: TOKEN }), 1, FEE_CAP)).rejects.toThrow("different recipient");
  });
  it("refuses when tokens or gas are short, the chain has no EIP-1559 fees, the fee cap is too low, or the contract changed", async () => {
    let { adapter } = await wallet(999_999n);
    await expect(adapter.prepare(target(), 1_000_000, FEE_CAP)).rejects.toThrow("Insufficient token balance");
    ({ adapter } = await wallet(5_000_000n, 1_000n));
    await expect(adapter.prepare(target(), 1_000_000, FEE_CAP)).rejects.toThrow("Insufficient ETH for gas");
    ({ adapter } = await wallet());
    await expect(adapter.prepare(target(), 1_000_000, 10 ** 12)).rejects.toThrow("exceeds your limit");
    chain.baseFee = undefined;
    await expect(adapter.prepare(target(), 1_000_000, FEE_CAP)).rejects.toThrow("EIP-1559");
    chain.baseFee = 1n; chain.code = "0x6001";
    await expect(adapter.prepare(target(), 1_000_000, FEE_CAP)).rejects.toThrow("Token contract changed");
    expect(chain.sent).toEqual([]);
  });
});

describe("executing an approved token payment", () => {
  it("writes the signed bytes down before broadcasting, then waits for two confirmations", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    const persist = vi.fn(async () => {
      expect(chain.sent, "nothing is broadcast before the journal holds the signed bytes").toEqual([]);
      expect(prepared.signed && prepared.hash).toBeTruthy();
    });
    const result = await adapter.execute(review, prepared, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(result).toEqual({ txid: prepared.hash, settled: false, pending: true });
    expect(chain.sent.map((raw) => Transaction.from(raw).hash)).toEqual([prepared.hash]);
    chain.advance();
    expect(await adapter.reconcile(review, prepared)).toEqual({ txid: prepared.hash, settled: true });
    expect(chain.sent, "reconcile only looks").toHaveLength(1);
    expect(chain.tokens.get(BOB.toLowerCase())).toBe(1_000_000n);
  });
  it("anything wrong before signing is a preflight failure: nothing signed, nothing sent", async () => {
    const { adapter, me } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    const refused = async (r: PaymentReview, p: UsdtPrepared, persist: (() => Promise<void>) | undefined, message: string) => {
      const error = await adapter.execute(r, p, persist).catch((e: Error) => e);
      expect(error, message).toBeInstanceOf(PaymentPreflightError);
      expect((error as Error).message).toContain(message);
    };
    await refused(review, prepared, undefined, "Durable payment journal required");
    await refused({ ...review, amount: 2_000_000 }, prepared, journal(), "no longer matches the approved review");
    await refused({ ...review, feeCap: review.fee - 1 }, prepared, journal(), "no longer matches the approved review");
    await refused({ ...review, evm: { ...review.evm!, nonce: 8 } }, prepared, journal(), "no longer matches the approved review");
    await refused({ ...review, chainId: 1 }, prepared, journal(), "Token metadata");
    await refused(review, { ...prepared, from: BOB }, journal(), "no longer matches the approved review");
    chain.nonces.set(me, 8);
    await refused(review, prepared, journal(), "Account nonce changed");
    chain.nonces.set(me, 7); chain.tokens.set(me, 1n);
    await refused(review, prepared, journal(), "balance changed");
    chain.tokens.set(me, 5_000_000n); chain.chainId = 1;
    await refused(review, prepared, journal(), "RPC chain does not match");
    expect(prepared.signed).toBeUndefined();
    expect(chain.sent).toEqual([]);
  });
  it("a journal that cannot be written stops the broadcast, and the failure is not called preflight", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    const error = await adapter.execute(review, prepared, async () => { throw new Error("disk full"); }).catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(PaymentPreflightError);
    expect(chain.sent).toEqual([]);
  });
  it("a reverted transfer is a failure that spent gas, not a payment", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    chain.mode = "revert";
    await adapter.execute(review, prepared, journal());
    chain.advance();
    expect(await adapter.reconcile(review, prepared)).toMatchObject({ settled: false, failed: true, error: expect.stringContaining("reverted") });
  });
});

describe("reconciling a token payment whose outcome is unknown", () => {
  it("with no signed bytes in the journal it is a failure to review again, not a guess", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    expect(await adapter.reconcile(review, prepared)).toMatchObject({ settled: false, failed: true });
    expect(chain.sent).toEqual([]);
  });
  it("a broadcast that never arrived is replayed with exactly the saved bytes, once", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    chain.mode = "drop";
    await expect(adapter.execute(review, prepared, journal())).rejects.toThrow();
    chain.mode = "mine";
    expect(await adapter.reconcile(review, prepared)).toMatchObject({ txid: prepared.hash, pending: true });
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1], "the very same signed transaction").toBe(chain.sent[0]);
    chain.advance();
    expect(await adapter.reconcile(review, prepared)).toMatchObject({ settled: true });
    expect(chain.sent).toHaveLength(2);
  });
  it("a broadcast whose answer was lost is found on chain and not sent again", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    chain.mode = "lost";
    await expect(adapter.execute(review, prepared, journal())).rejects.toThrow();
    chain.advance();
    expect(await adapter.reconcile(review, prepared)).toMatchObject({ settled: true });
    expect(chain.sent).toHaveLength(1);
  });
  it("once the nonce moved on, the saved bytes are not replayed", async () => {
    const { adapter, me } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    chain.mode = "drop";
    await adapter.execute(review, prepared, journal()).catch(() => {});
    chain.nonces.set(me, 8);
    expect(await adapter.reconcile(review, prepared)).toEqual({ txid: prepared.hash, settled: false });
    expect(chain.sent).toHaveLength(1);
  });
  it("a journal from another wallet cannot be replayed by this one", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    chain.mode = "drop";
    await adapter.execute(review, prepared, journal()).catch(() => {});
    const other = await UsdtAdapter.connect(config(), "legal winner thank year wave sausage worth useful legal winner thank yellow");
    await expect(other.reconcile(review, prepared)).rejects.toThrow("Could not unlock");
    expect(chain.sent).toHaveLength(1);
  });
});

describe("checking a token receipt", () => {
  async function paid(amount = 1_000_000) {
    const { adapter, me } = await wallet();
    const { review, prepared } = await reviewed(adapter, amount);
    await adapter.execute(review, prepared, journal());
    chain.advance();
    return { adapter, me, review, hash: prepared.hash! };
  }
  it("refuses a malformed hash or a target of another chain, token or precision", async () => {
    const { adapter, review, hash } = await paid();
    await expect(adapter.receipt("0x1234", review)).rejects.toThrow("Invalid receipt target");
    await expect(adapter.receipt(hash, { ...review, chainId: 1 })).rejects.toThrow("Invalid receipt target");
    await expect(adapter.receipt(hash, { ...review, token: BOB })).rejects.toThrow("Invalid receipt target");
    await expect(adapter.receipt(hash, { ...review, decimals: 18 })).rejects.toThrow("Invalid receipt target");
  });
  it("a transaction that pays another amount or recipient, or comes from someone else, is not this payment", async () => {
    const { adapter, review, hash } = await paid();
    await expect(adapter.receipt(hash, { ...review, amount: 999_999 })).rejects.toThrow("not the requested token transfer");
    await expect(adapter.receipt(hash, { ...review, address: "0x" + "4".repeat(40) })).rejects.toThrow("not the requested token transfer");
    await expect(adapter.receipt(hash, review, BOB)).rejects.toThrow("not the requested token transfer");
    expect(await adapter.receipt(hash, review), "the payee does not know the sender").toEqual({ txid: hash, settled: true });
  });
  it("an unknown hash is not settled, and an unmined one is pending", async () => {
    const { adapter } = await wallet();
    const { review, prepared } = await reviewed(adapter);
    expect(await adapter.receipt("0x" + "ab".repeat(32), review)).toEqual({ txid: "0x" + "ab".repeat(32), settled: false });
    chain.mode = "hold";
    expect(await adapter.execute(review, prepared, journal())).toEqual({ txid: prepared.hash, settled: false, pending: true });
    expect(await adapter.reconcile(review, prepared), "in the mempool: wait, do not resend").toEqual({ txid: prepared.hash, settled: false, pending: true });
    expect(chain.sent).toHaveLength(1);
  });
  it("a reorged block or a transfer older than the request does not settle it", async () => {
    const { adapter, review, hash } = await paid();
    const receipt = chain.receipts.get(hash)!, block = chain.blocks.get(receipt.blockNumber)!;
    chain.blocks.set(receipt.blockNumber, { ...block, hash: "0x" + "cd".repeat(32) });
    expect(await adapter.receipt(hash, review)).toEqual({ txid: hash, settled: false });
    chain.blocks.set(receipt.blockNumber, block);
    expect(await adapter.receipt(hash, { ...review, issuedAt: Date.now() + 60_000 }), "an old transfer cannot pay a newer request").toEqual({ txid: hash, settled: false });
  });
  it("a receipt without a matching Transfer event from the token is refused", async () => {
    const { adapter, review, hash } = await paid();
    const receipt = chain.receipts.get(hash)!;
    const log = receipt.logs[0];
    receipt.logs = [{ ...log, address: BOB }, { ...log, topics: ["0x" + "00".repeat(32)] }, { ...log, data: "0x" + (1n).toString(16).padStart(64, "0") }];
    await expect(adapter.receipt(hash, review)).rejects.toThrow("no matching token Transfer");
  });
});

describe("the coordinator with the token adapter", () => {
  function repository() {
    const records = new Map<string, SavedIntent>();
    const repo: IntentRepository = {
      get: async (id) => structuredClone(records.get(id)), list: async () => structuredClone([...records.values()]),
      put: async (v) => { records.set(v.review.id, structuredClone(v)); },
      cancel: async (id) => { const v = records.get(id)!; v.review.state = "cancelled"; return structuredClone(v); },
      claim: async (id) => { const v = records.get(id); if (!v || v.review.state !== "pending") throw new Error("already submitted"); v.review.state = "submitted"; return structuredClone(v); },
    };
    return { repo, records };
  }
  it("rejects fractional or zero token units before asking the wallet", async () => {
    const { adapter } = await wallet();
    const prepare = vi.spyOn(adapter, "prepare");
    const coordinator = new PaymentCoordinator(repository().repo, [adapter]);
    await expect(coordinator.prepare(target(), 1.5, FEE_CAP, { payee: "Bob" })).rejects.toThrow("token precision");
    await expect(coordinator.prepare(target(), 0, FEE_CAP, { payee: "Bob" })).rejects.toThrow("token precision");
    expect(prepare).not.toHaveBeenCalled();
  });
  it("approve, lost answer, restart, reconcile: settled with one transaction", async () => {
    const { adapter } = await wallet();
    const { repo, records } = repository();
    const coordinator = new PaymentCoordinator(repo, [adapter]);
    const r = await coordinator.prepare(target(), 1_000_000, FEE_CAP, { payee: "Bob", requestId: "req", linkId: "chat" });
    chain.mode = "lost";
    expect(await coordinator.approve(r.id)).toMatchObject({ state: "unknown" });
    expect((records.get(r.id)!.prepared as UsdtPrepared).signed, "the journal holds the signed bytes").toBeDefined();
    const restarted = new PaymentCoordinator(repo, [adapter]);
    await expect(restarted.approve(r.id)).rejects.toThrow("cannot be submitted again");
    expect(await restarted.reconcile(r.id)).toMatchObject({ state: "submitted" });
    chain.advance();
    expect(await restarted.reconcile(r.id)).toMatchObject({ state: "settled" });
    expect(chain.sent).toHaveLength(1);
  });
  it("a preflight refusal is final and lets the request be paid again", async () => {
    const { adapter, me } = await wallet();
    const coordinator = new PaymentCoordinator(repository().repo, [adapter]);
    const context = { payee: "Bob", requestId: "req", linkId: "chat" };
    const first = await coordinator.prepare(target(), 1_000_000, FEE_CAP, context);
    chain.nonces.set(me, 9);
    expect(await coordinator.approve(first.id)).toMatchObject({ state: "failed", error: expect.stringContaining("nonce changed") });
    const second = await coordinator.prepare(target(), 1_000_000, FEE_CAP, context);
    expect(await coordinator.approve(second.id)).toMatchObject({ state: "submitted" });
    expect(chain.sent).toHaveLength(1);
  });
});
