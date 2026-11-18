import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, deriveKeysetId, hashToCurve } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { CASHU_REQUEST_TIMEOUT_MS } from "../src/engine/paymentAdapters/cashu";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { TEST_MINT } from "../src/shared/mints";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { PendingMelt, StoredProof, WalletTx } from "../src/shared/types";
// covers: payments.cashu.send

/**
 * Pending Lightning payments at three mints, one of which loaded and then stopped answering. `pollMelts` asked them one
 * after another: each melt at the silent mint waited out its 30-s state read, and the melts at the healthy mints after
 * it in the list waited behind them (20 melts, 6 at the silent mint: one round lasted 3 min). Now a mint that did not
 * answer is down for the rest of the round, and the mints are asked side by side. Real cashu-ts in front of in-memory
 * mints, fake timers.
 */
const A = TEST_MINT;
const B = "http://localhost:3338";
const C = "http://127.0.0.1:3339";
const MINTS = [A, B, C];
const COUNT = 20;
/** Well within a mint's 30-s deadline: a payment settled by then did not wait for one. */
const SOON = CASHU_REQUEST_TIMEOUT_MS / 3;
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function fakeMint(url: string) {
  const { pubKeys: keys, privKeys } = createNewMintKeys(7, new Uint8Array(32).fill(9 + url.length));
  const pubKeys = Object.fromEntries(Object.entries(keys).map(([amount, key]) => [amount, hex(key as Uint8Array)]));
  const id = deriveKeysetId(pubKeys, { input_fee_ppk: 0, unit: "sat", versionByte: 1 });
  const keyset = (withKeys = false) => ({ id, unit: "sat", active: true, input_fee_ppk: 0, ...(withKeys ? { keys: pubKeys } : {}) });
  /** Every melt quote here is paid. */
  const melts = new Map<string, string>();
  /** Melt quote reads, and when each came in. */
  const reads: number[] = [];
  const cfg = { silent: false };
  const held: (() => void)[] = [];
  const respond = (path: string): Response => {
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: `Fake ${url}`, version: "cdk-mintd/0.17.7", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 8: { supported: true }, 9: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [keyset()] });
    if (path === "/v1/keys" || path === `/v1/keys/${id}`) return answer({ keysets: [keyset(true)] });
    if (path.startsWith("/v1/melt/quote/bolt11/")) {
      const quote = path.slice("/v1/melt/quote/bolt11/".length);
      return answer({ quote, request: melts.get(quote), amount: 10, fee_reserve: 2, unit: "sat", state: "PAID", expiry: 4_000_000_000, change: [] });
    }
    return new Response("not found", { status: 404 });
  };
  /** A proof as if minted earlier: C = k*Y. */
  const issue = (amount: number): StoredProof => {
    const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
    const signature = createBlindSignature(hashToCurve(new TextEncoder().encode(secret)), privKeys[String(amount)] as Uint8Array, id);
    return { mint: url, id, amount, secret, C: signature.C_.toHex(true) };
  };
  return { url, melts, reads, cfg, held, respond, issue };
}
type Mint = ReturnType<typeof fakeMint>;
let mints: Map<string, Mint>;

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const mint = [...mints.values()].find((m) => new URL(m.url).origin === url.origin);
    if (!mint) return new Response("offline", { status: 503 });
    if (url.pathname.startsWith("/v1/melt/quote/bolt11/")) mint.reads.push(Date.now());
    if (!mint.cfg.silent) return mint.respond(url.pathname);
    // Takes the connection and never answers.
    return new Promise<Response>((_, reject) => {
      mint.held.push(() => reject(new TypeError("Failed to fetch")));
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    });
  }));
}

const events = () => ({ onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });
const proofs = async () => wrap<StoredProof[]>((await store(STORES.proofs, "readonly")).getAll());
const melts = async () => wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());
const history = async () => wrap<WalletTx[]>((await store(STORES.walletTx, "readonly")).getAll());
const sum = (items: { amount: number }[]) => items.reduce((total, item) => total + item.amount, 0);

/** `ms` of fake time, a quarter second at a time, the IndexedDB work (on real macrotasks) let through in between. */
async function elapse(ms: number, until: () => boolean = () => false) {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  for (let passed = 0; passed < ms && !until(); passed += 250) {
    await settle();
    await vi.advanceTimersByTimeAsync(250);
  }
  await settle();
}

const wallets: CashuWallet[] = [];
let free: StoredProof[];
let reserved: StoredProof[];

beforeEach(async () => {
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes, STORES.settings, STORES.intents], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  mints = new Map(MINTS.map((url) => [url, fakeMint(url)]));
  stubFetch();
  // 20 Lightning payments in flight, round-robin over A, B, C (7, 7, 6), each holding one reserved 16-sat coin, and
  // some ecash of each mint left free.
  free = MINTS.flatMap((url) => [1, 2, 4, 8, 32, 64].map((amount) => mints.get(url)!.issue(amount)));
  reserved = [];
  const rows: PendingMelt[] = [];
  for (let i = 0; i < COUNT; i++) {
    const mint = mints.get(MINTS[i % 3])!;
    const coin = { ...mint.issue(16), reserved: true };
    const quote = `m${String(i).padStart(2, "0")}`;
    const request = fakeInvoice(10, new Uint8Array(32).fill(30 + i));
    mint.melts.set(quote, request);
    reserved.push(coin);
    rows.push({ quote, mint: mint.url, request, amount: 10, secrets: [coin.secret], outlay: coin.amount, outputs: [], createdAt: Date.now() - 60_000 });
  }
  await transact([STORES.melts, STORES.proofs], (s) => {
    for (const row of rows) s[STORES.melts].put(row);
    for (const p of [...free, ...reserved]) s[STORES.proofs].put(p);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const mint of mints.values()) { mint.cfg.silent = false; for (const drop of mint.held.splice(0)) drop(); }
  for (const wallet of wallets.splice(0)) await wallet.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A wallet with every mint loaded, and one `pollMelts` round under fake timers: when it ended and each melt settled. */
async function oneRound(silent: boolean) {
  const ev = events();
  const wallet = new CashuWallet(() => MINTS, ev);
  wallets.push(wallet);
  for (const url of MINTS) await wallet.checkMint(url);
  mints.get(C)!.cfg.silent = silent;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const start = Date.now();
  const settledAt = new Map<string, number>();
  ev.onMeltResolved.mockImplementation((melt: PendingMelt) => { settledAt.set(melt.quote, Date.now() - start); });
  for (const mint of mints.values()) mint.reads.length = 0;
  let endedAt: number | undefined;
  void (wallet as unknown as { pollMelts(): Promise<void> }).pollMelts().then(() => { endedAt = Date.now() - start; });
  await elapse(10 * CASHU_REQUEST_TIMEOUT_MS, () => endedAt !== undefined);
  const healthy = [...settledAt].filter(([quote]) => Number(quote.slice(1)) % 3 !== 2).map(([, at]) => at);
  return { ev, start, endedAt, settledAt, healthy };
}

/** No ecash lost or counted twice: every reserved coin is gone with its payment, the free ecash is untouched. */
async function expectAllPaid(ev: ReturnType<typeof events>) {
  expect(await melts()).toEqual([]);
  const left = await proofs();
  expect(left.some((p) => p.reserved)).toBe(false);
  expect(sum(left)).toBe(sum(free));
  expect(new Set(left.map((p) => p.secret))).toEqual(new Set(free.map((p) => p.secret)));
  const paid = (await history()).filter((tx) => tx.kind === "lightning-out");
  expect(paid).toHaveLength(COUNT);
  expect(sum(paid) + paid.reduce((total, tx) => total + tx.fee, 0)).toBe(sum(reserved));
  // Each payment resolved once, as paid.
  expect(ev.onMeltResolved).toHaveBeenCalledTimes(COUNT);
  expect(new Set(ev.onMeltResolved.mock.calls.map(([melt]) => (melt as PendingMelt).quote)).size).toBe(COUNT);
  expect(ev.onMeltResolved.mock.calls.every(([, paidOut]) => paidOut === true)).toBe(true);
}

describe("pending Lightning payments over three mints, one loaded and then silent", () => {
  it("settles the healthy mints' payments at once, gives up on the silent mint after one read, and settles its payments once it answers", async () => {
    const { ev, endedAt, settledAt, healthy } = await oneRound(true);

    // The healthy mints' 14 payments settle without waiting for the silent mint.
    expect(healthy).toHaveLength(14);
    expect(Math.max(...healthy)).toBeLessThan(SOON);
    // One read at the silent mint, given up on at its deadline; its other 5 payments wait for the next round.
    expect(mints.get(C)!.reads).toHaveLength(1);
    expect(endedAt).toBeDefined();
    expect(endedAt!).toBeLessThan(CASHU_REQUEST_TIMEOUT_MS + 5_000);
    expect(settledAt.size).toBe(14);
    expect((await melts()).map((m) => m.mint)).toEqual(Array(6).fill(C));
    expect((await proofs()).filter((p) => p.reserved)).toHaveLength(6);

    // The mint answers again: the next round asks it, and its payments settle.
    mints.get(C)!.cfg.silent = false;
    await elapse(3 * CASHU_REQUEST_TIMEOUT_MS, () => settledAt.size === COUNT);
    expect(settledAt.size).toBe(COUNT);
    expect(mints.get(C)!.reads).toHaveLength(1 + 6);
    await expectAllPaid(ev);
  }, 60_000);

  it("with every mint answering, settles all 20 payments in one short round, as before", async () => {
    const { ev, endedAt, settledAt, healthy } = await oneRound(false);

    expect(endedAt).toBeDefined();
    expect(endedAt!).toBeLessThan(SOON);
    expect(healthy).toHaveLength(14);
    expect(settledAt.size).toBe(COUNT);
    for (const url of MINTS) expect(mints.get(url)!.reads).toHaveLength(url === A ? 7 : url === B ? 7 : 6);
    await expectAllPaid(ev);
  }, 60_000);
});
