import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import { BdkOnchain, bdk, parseBdkSettings, type BdkStore } from "../src/engine/paymentAdapters/providers/bdk";
import { fakeAddress } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError, SourceConfigError, SourceUnreachableError, type ProviderSettings } from "../src/engine/paymentAdapters/providers/types";
import { newBdkPhrase } from "../src/engine/paymentAdapters/providers/bdkPhrase";
import { describeOnchainProvider } from "./helpers/providerContract";
import { FakeEsplora } from "./helpers/fakeEsplora";
import { nodeBdk } from "./helpers/bdkNode";
import { phraseLeaks, TEST_PHRASE } from "./helpers/phraseLeaks";
// covers: wallet.onchain.bdk.create, wallet.onchain.bdk.send, wallet.onchain.provider-contract

vi.setConfig({ testTimeout: 30_000 });
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ESPLORA = "http://127.0.0.1:44299";
let esplora: FakeEsplora;
beforeEach(async () => {
  esplora = new FakeEsplora();
  // BDK's own Esplora client (in the WebAssembly) calls the global fetch.
  vi.stubGlobal("fetch", esplora.fetch);
  await transact([STORES.settings], (s) => { s[STORES.settings].clear(); });
});
afterEach(() => { vi.unstubAllGlobals(); });

const settings = (config: Record<string, string> = {}, mnemonic = newBdkPhrase()): ProviderSettings => ({ config: { network: "regtest", esplora: ESPLORA, script: "bip84", ...config }, secrets: { mnemonic } });
const open = (s: ProviderSettings = settings(), signal = new AbortController().signal, extra: { store?: BdkStore } = {}) => BdkOnchain.open(s, { signal }, { bdk: nodeBdk, fetch: esplora.fetch, ...extra });
async function funded(sats = 50_000, s?: ProviderSettings) {
  const provider = await open(s);
  esplora.fund(await provider.receiveAddress(), sats);
  await provider.sync(true);
  return provider;
}

describeOnchainProvider("BDK (mocked Esplora)", async () => {
  const provider = await open();
  return { provider, network: "regtest", recipient: fakeAddress, fund: async (amount) => { esplora.fund(await provider.receiveAddress(), amount); await provider.sync(true); } };
});

describe("the BDK wallet's settings", () => {
  it("are checked before anything is contacted", () => {
    expect(parseBdkSettings(settings({}, `  ${ABANDON.toUpperCase().replace(/ /g, "  ")} `))).toMatchObject({ network: "regtest", esplora: ESPLORA, mnemonic: ABANDON });
    // Blank: every public server of the network, blockstream.info first (mempool.space does not answer everywhere).
    expect(parseBdkSettings(settings({ network: "signet", esplora: "" }))).toMatchObject({ esplora: "https://blockstream.info/signet/api", servers: ["https://blockstream.info/signet/api", "https://mempool.space/signet/api"], script: "bip84" });
    expect(parseBdkSettings(settings({ network: "mutinynet", esplora: "" }))).toMatchObject({ servers: ["https://mutinynet.com/api"] });
    expect(parseBdkSettings(settings({ network: "mutinynet", esplora: "https://mutinynet.com/api/" }))).toMatchObject({ esplora: "https://mutinynet.com/api", servers: ["https://mutinynet.com/api"] });
    for (const [config, mnemonic, error] of [
      [{ network: "bitcoin" }, undefined, /test network/],
      [{ network: "testnet" }, undefined, /test network/],
      [{ esplora: "" }, undefined, /your own Esplora/],
      [{ esplora: "http://esplora.example" }, undefined, /HTTPS/],
      [{ esplora: "https://user:pass@esplora.example" }, undefined, /no credentials/],
      [{ esplora: "not a url" }, undefined, /not a URL/],
      [{ script: "bip44" }, undefined, /BIP84 or BIP86/],
      [{}, "abandon abandon", /not valid/],
      [{}, ABANDON.replace("about", "abandon"), /not valid/],
    ] as const) expect(() => parseBdkSettings(settings(config, mnemonic)), JSON.stringify(config)).toThrow(error);
  });

  it("are offered in Testnet only, on every platform", () => {
    expect(bdk.networks).not.toContain("bitcoin");
    expect(bdk.platforms).toEqual(["web", "extension", "desktop"]);
    expect(() => bdk.validate!(settings(), "mainnet")).toThrow(/test networks only/);
    expect(bdk.fields.find((f) => f.name === "mnemonic")?.kind).toBe("secret");
  });

  it("refuses an Esplora server of another network, or one that does not answer", async () => {
    esplora.genesis = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
    await expect(open()).rejects.toThrow(/is on Bitcoin mainnet, not regtest/);
    esplora.genesis = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
    await expect(BdkOnchain.open(settings(), { signal: new AbortController().signal }, { bdk: nodeBdk, fetch: () => Promise.reject(new TypeError("fetch failed")) })).rejects.toThrow(/not running/);
  });
});

describe("why the BDK wallet could not connect", () => {
  const signal = () => new AbortController().signal;
  const openWith = (fetcher: typeof fetch, config: Record<string, string> = {}, deps: { bdk?: typeof nodeBdk } = {}) => BdkOnchain.open(settings(config), { signal: signal() }, { bdk: nodeBdk, fetch: fetcher, ...deps });
  const answer = (status: number, body: string): typeof fetch => async (input) => Object.defineProperty(new Response(body, { status }), "url", { value: String(input) });
  const refused: typeof fetch = () => Promise.reject(new TypeError("Load failed"));
  const failure = async (opening: Promise<unknown>) => { try { await opening; } catch (error) { return error as Error; } throw new Error("it opened"); };

  it("no answer in time: unreachable, tried again later, not a setting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Like WebKit: the fetch ends when its signal aborts ("Fetch is aborted"), never before.
      const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Fetch is aborted", "AbortError"))));
      const opening = failure(openWith(hanging, { esplora: "https://esplora.example/api" }));
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await opening;
      expect(error).toBeInstanceOf(SourceUnreachableError);
      expect(error.message).toBe("the Esplora server at esplora.example did not answer in 20 s");
    } finally { vi.useRealTimers(); }
  });

  it("closing the source is not a server that did not answer", async () => {
    const controller = new AbortController();
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Fetch is aborted", "AbortError"))));
    const opening = failure(BdkOnchain.open(settings(), { signal: controller.signal }, { bdk: nodeBdk, fetch: hanging }));
    controller.abort();
    expect(await opening).not.toBeInstanceOf(SourceUnreachableError);
  });

  it("a local server that refuses: it is not running; a remote one: it did not answer", async () => {
    const local = await failure(openWith(refused));
    expect(local).toBeInstanceOf(SourceUnreachableError);
    expect(local.message).toBe("nothing answers at 127.0.0.1:44299: the local Esplora server is not running");
    const remote = await failure(openWith(refused, { esplora: "https://esplora.example/api" }));
    expect(remote).toBeInstanceOf(SourceUnreachableError);
    expect(remote.message).toBe("the Esplora server at esplora.example did not answer (Load failed)");
  });

  it("down or busy for a moment (5xx, 429): unreachable", async () => {
    for (const status of [502, 503, 429]) {
      const error = await failure(openWith(answer(status, "Bad gateway")));
      expect(error, String(status)).toBeInstanceOf(SourceUnreachableError);
      expect(error.message).toContain(`answered ${status}: it is down or busy`);
    }
  });

  it("wrong network, named when it is a known chain", async () => {
    for (const [genesis, chain] of [
      ["000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "Bitcoin mainnet"],
      ["000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943", "testnet3"],
      ["00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043", "testnet4"],
      ["00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6", "signet"],
      ["11".repeat(32), "another chain"],
    ]) {
      const error = await failure(openWith(answer(200, genesis)));
      expect(error, chain).toBeInstanceOf(SourceConfigError);
      expect(error.message).toBe(`wrong network: the Esplora server at 127.0.0.1:44299 is on ${chain}, not regtest`);
    }
  });

  it("not an Esplora API at all (a web page, a 404): a setting to change", async () => {
    for (const [status, body] of [[404, "Not found"], [200, "<!doctype html><html>"]] as const) {
      const error = await failure(openWith(answer(status, body)));
      expect(error).toBeInstanceOf(SourceConfigError);
      expect(error.message).toBe(`http://127.0.0.1:44299 is not an Esplora API (it answered ${status} for block 0)`);
    }
  });

  it("a phrase that makes no wallet: bad descriptor", async () => {
    const broken = async () => ({ ...(await nodeBdk()), seed_to_descriptor: () => { throw new Error("invalid key"); } }) as Awaited<ReturnType<typeof nodeBdk>>;
    const error = await failure(openWith(esplora.fetch, {}, { bdk: broken }));
    expect(error).toBeInstanceOf(SourceConfigError);
    expect(error.message).toBe("bad descriptor: the recovery phrase does not make a BIP84 wallet (invalid key)");
    // A setting checked before anything is contacted is a setting too.
    expect(await failure(BdkOnchain.open(settings({}, "abandon abandon"), { signal: signal() }, { bdk: nodeBdk, fetch: esplora.fetch }))).toBeInstanceOf(SourceConfigError);
  });

  it("blank server: the public ones of the network are asked together, and the first on the chain is used", async () => {
    // The fake answers under /api: the path of a public server, on it.
    const onFake = (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input).replace("/signet/api", "/api");
    esplora.genesis = "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6";
    const asked: string[] = [];
    const publicServers: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      asked.push(url.host);
      if (url.host === "blockstream.info") throw new TypeError("Load failed");
      return esplora.fetch(onFake(input), init);
    };
    const provider = await BdkOnchain.open(settings({ network: "signet", esplora: "" }), { signal: signal() }, { bdk: nodeBdk, fetch: publicServers });
    expect(provider.config.esplora).toBe("https://mempool.space/signet/api");
    expect(new Set(asked)).toEqual(new Set(["blockstream.info", "mempool.space"]));
    await provider.close();

    const none = await failure(BdkOnchain.open(settings({ network: "signet", esplora: "" }), { signal: signal() }, { bdk: nodeBdk, fetch: refused }));
    expect(none).toBeInstanceOf(SourceUnreachableError);
    expect(none.message).toBe("no public signet Esplora server answered (blockstream.info, mempool.space): the Esplora server at blockstream.info did not answer (Load failed)");
    // Every one on another chain: that is the setting (the network chosen), not the servers.
    esplora.genesis = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
    expect(await failure(BdkOnchain.open(settings({ network: "signet", esplora: "" }), { signal: signal() }, { bdk: nodeBdk, fetch: (input, init) => esplora.fetch(onFake(input), init) }))).toBeInstanceOf(SourceConfigError);
  });

  it("offers the public servers of the network chosen, and a local regtest one, under the server field", () => {
    const field = bdk.fields.find((f) => f.name === "esplora")!;
    expect(field.changeable).toBe(true);
    const offered = (network: string) => field.suggestions!.filter((s) => s.when?.network === network).map((s) => s.value);
    expect(offered("signet")).toEqual(["https://blockstream.info/signet/api", "https://mempool.space/signet/api"]);
    expect(offered("mutinynet")).toEqual(["https://mutinynet.com/api"]);
    expect(offered("regtest")).toEqual(["http://127.0.0.1:47002"]);
    for (const s of field.suggestions!) expect(() => parseBdkSettings(settings({ network: s.when!.network, esplora: s.value })), s.value).not.toThrow();
  });
});

describe("the BDK wallet", () => {
  it("derives BIP84 and BIP86 addresses from the phrase (BIP84 test vector)", async () => {
    esplora.genesis = "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6";
    const segwit = await open(settings({ network: "signet", esplora: "https://esplora.example" }, ABANDON));
    esplora.genesis = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";
    expect(await segwit.receiveAddress()).toBe("tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl");
    expect((await segwit.info()).alias).toBe("BDK BIP84 · 73c5da0a");
    const taproot = await open(settings({ script: "bip86" }, ABANDON));
    expect(await taproot.receiveAddress()).toMatch(/^bcrt1p/);
  });

  it("stores its state without the phrase or a private key, and keeps its addresses across a restart", async () => {
    const s = settings({}, TEST_PHRASE);
    const first = await open(s);
    const shown = [await first.receiveAddress(), await first.receiveAddress()];
    await first.close();
    const saved = JSON.stringify(await wrap((await store(STORES.settings, "readonly")).getAll()));
    expect(saved).toContain("tpub");
    expect(saved).not.toMatch(/tprv|xprv/);
    expect(phraseLeaks(saved)).toEqual([]);
    const again = await open(s);
    expect(shown).not.toContain(await again.receiveAddress());
  });

  it("finds what a restored phrase already received (full scan), then only syncs", async () => {
    const s = settings();
    const before = await open(s);
    const address = await before.receiveAddress();
    await transact([STORES.settings], (st) => { st[STORES.settings].clear(); });
    esplora.fund(address, 12_345);
    const restored = await open(s);
    expect(await restored.balance()).toEqual({ confirmed: 12_345, unconfirmed: 0 });
    esplora.requests.length = 0;
    await restored.sync(true);
    expect(esplora.requests.some((r) => r.startsWith("GET /scripthash/"))).toBe(true);
  });

  it("counts coins in the mempool as unconfirmed, and does not spend a stranger's unconfirmed coins", async () => {
    const provider = await open();
    esplora.fund(await provider.receiveAddress(), 30_000, false);
    await provider.sync(true);
    expect(await provider.balance()).toEqual({ confirmed: 0, unconfirmed: 30_000 });
    await expect(provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 5_000 })).rejects.toThrow(/Not enough confirmed sats/);
    esplora.mine();
    await provider.sync(true);
    expect((await provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 5_000 })).amount).toBe(1_000);
  });

  it("signs exactly the reviewed payment at the asked fee rate, and refuses what it must", async () => {
    const provider = await funded();
    const address = fakeAddress();
    const prepared = await provider.prepareSend({ address, amount: 10_000, feeCap: 5_000, feeRate: 3 });
    expect(prepared.feeRate).toBe(3);
    // One input, two outputs (the payment and the change) of P2WPKH: about 141 vB.
    expect(prepared.fee).toBeGreaterThanOrEqual(3 * 140);
    expect(prepared.fee).toBeLessThanOrEqual(3 * 145);
    await provider.release(prepared);
    await expect(provider.prepareSend({ address: "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", amount: 1_000, feeCap: 5_000 })).rejects.toThrow(/not a regtest address/);
    await expect(provider.prepareSend({ address, amount: 1.5, feeCap: 5_000 })).rejects.toThrow(/whole number/);
    await expect(provider.prepareSend({ address, amount: 100, feeCap: 5_000 })).rejects.toThrow(/Could not build/); // dust
    await expect(provider.prepareSend({ address, amount: 1_000, feeCap: 5_000, feeRate: 50_000 })).rejects.toThrow(/fee rate/);
    // A fee estimate from the server is used when none is asked.
    esplora.feeEstimates = { "3": 7.2 };
    expect((await provider.prepareSend({ address, amount: 1_000, feeCap: 5_000 })).feeRate).toBe(8);
  });

  it("reserves the coins of a review until it is broadcast or released", async () => {
    const provider = await funded(20_000);
    const first = await provider.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 });
    // The only coin is reserved: a second review cannot take it.
    await expect(provider.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 })).rejects.toThrow(/Not enough confirmed sats/);
    await provider.release(first);
    const second = await provider.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 });
    expect(second.txid).not.toBe(first.txid);
    // Reservations survive a restart.
    await provider.close();
    const reopened = await BdkOnchain.open(settings(), { signal: new AbortController().signal }, { bdk: nodeBdk, fetch: esplora.fetch }).catch(() => undefined);
    expect(reopened).toBeDefined();
  });

  it("keeps a reservation across a restart", async () => {
    const s = settings();
    const provider = await funded(20_000, s);
    await provider.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 });
    await provider.close();
    const again = await open(s);
    await expect(again.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 })).rejects.toThrow(/Not enough confirmed sats/);
  });

  it("says NothingSpent only when the node refused and nobody knows the transaction", async () => {
    const provider = await funded(20_000);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 });
    esplora.fault = "reject";
    await expect(provider.broadcast(prepared)).rejects.toBeInstanceOf(NothingSpentError);
    // Its coins are free again.
    const retry = await provider.prepareSend({ address: fakeAddress(), amount: 5_000, feeCap: 2_000 });
    esplora.fault = "none";
    expect(await provider.broadcast(retry)).toBe(retry.txid);
  });

  it("treats a lost answer, a 5xx or no network as an unknown outcome, and finds the transaction by txid", async () => {
    const provider = await funded(20_000);
    for (const fault of ["offline", "error"] as const) {
      const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 2_000 });
      esplora.fault = fault;
      const error = await provider.broadcast(prepared).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NothingSpentError);
      expect((await provider.status(prepared)).state).toBe("missing");
      esplora.fault = "none";
      await provider.release(prepared);
    }
    const lost = await provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 2_000 });
    esplora.fault = "lost";
    await expect(provider.broadcast(lost)).rejects.not.toBeInstanceOf(NothingSpentError);
    expect(await provider.status(lost)).toEqual({ state: "mempool", confirmations: 0 });
    esplora.fault = "none";
    // Broadcasting it again (a reconcile) answers the same txid and pays nothing more.
    expect(await provider.broadcast(lost)).toBe(lost.txid);
    esplora.mine(2);
    expect(await provider.status(lost)).toEqual({ state: "confirmed", confirmations: 2 });
  });

  it("takes a node's \"already have it\" for the transaction it is", async () => {
    const provider = await funded(20_000);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 2_000 });
    const fetcher = esplora.fetch;
    for (const answer of ["sendrawtransaction RPC error: {\"code\":-27,\"message\":\"Transaction already in block chain\"}", "sendrawtransaction RPC error: {\"code\":-26,\"message\":\"txn-already-in-mempool\"}"]) {
      const said = (input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? Promise.resolve(new Response(answer, { status: 400 })) : fetcher(input, init);
      const again = await BdkOnchain.open(settings(), { signal: new AbortController().signal }, { bdk: nodeBdk, fetch: said });
      expect(await again.broadcast(prepared)).toBe(prepared.txid);
    }
  });

  it("says a transaction whose coins another one spent is conflicted", async () => {
    const provider = await funded(20_000);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 2_000 });
    expect(await provider.broadcast(prepared)).toBe(prepared.txid);
    esplora.conflict(prepared.txid);
    expect((await provider.status(prepared)).state).toBe("conflicted");
  });

  it("refuses to broadcast a damaged or swapped transaction", async () => {
    const provider = await funded(20_000);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 1_000, feeCap: 2_000 });
    await expect(provider.broadcast({ ...prepared, signed: "zz" })).rejects.toBeInstanceOf(NothingSpentError);
    await expect(provider.broadcast({ ...prepared, txid: "00".repeat(32) })).rejects.toBeInstanceOf(NothingSpentError);
    expect(esplora.broadcasts).toBe(0);
  });

  it("lists history newest first (sent without the fee) and what paid one of its addresses", async () => {
    const provider = await open();
    const address = await provider.receiveAddress();
    const funding = esplora.fund(address, 40_000);
    await provider.sync(true);
    const prepared = await provider.prepareSend({ address: fakeAddress(), amount: 3_000, feeCap: 2_000 });
    await provider.broadcast(prepared);
    const history = await provider.history(10);
    expect(history[0]).toMatchObject({ txid: prepared.txid, amount: -3_000, fee: prepared.fee, confirmations: 0 });
    expect(history[1]).toMatchObject({ txid: funding, amount: 40_000, confirmations: 1 });
    expect(await provider.balance()).toEqual({ confirmed: 0, unconfirmed: 40_000 - 3_000 - prepared.fee });
    expect(await provider.received(address)).toEqual([{ txid: funding, amount: 40_000, confirmations: 1 }]);
    expect(await provider.received(await provider.receiveAddress())).toEqual([]);
    expect(await provider.history(1)).toHaveLength(1);
  });

  it("stops when its source is closed", async () => {
    const controller = new AbortController();
    const provider = await open(settings(), controller.signal);
    controller.abort();
    await expect(provider.sync(true)).rejects.toThrow(/closed/);
  });
});
