import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, pointFromHex, serializeMintKeys } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { MELT_REQUEST_TIMEOUT_MS, SWAP_SETTLED_MS } from "../src/engine/paymentAdapters/cashu";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { PendingMelt, StoredProof, StoredQuote } from "../src/shared/types";
// covers: payments.cashu.send

/**
 * A Lightning payment at a mint that lists its melt among NUT-19's cached endpoints, with no ttl, and takes the melt's
 * connection without ever answering. cashu-ts tried the melt again after each 5-min timeout, ten times: the payment
 * stayed busy for 50 min, every other payment at that mint waited behind it, and its coins were let go a few seconds
 * after the last try ended, not `SWAP_SETTLED_MS` after, while the mint could still act on it. The melt's request now
 * ends within `MELT_REQUEST_TIMEOUT_MS`, its retries included. Real cashu-ts in front of an in-memory mint.
 */
const MINT = "https://mint.example";
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });
const FEE_RESERVE = 2;

interface Output { id: string; amount: number; B_: string }

function fakeMint() {
  const made = createNewMintKeys(8, undefined, { versionByte: 0 });
  const keyset = { id: made.keysetId, keys: serializeMintKeys(made.pubKeys), secret: made.privKeys };
  const quotes = new Map<string, { amount: number; state: string }>();
  const melts = new Map<string, { request: string; amount: number; fee_reserve: number; state: string }>();
  const invoices = new Map<string, number>();
  /** When each melt request came in: the mint takes it and never answers. */
  const meltTries: number[] = [];
  const held: (() => void)[] = [];
  const state = { closed: false };
  const sign = (outputs: Output[]) => outputs.map((output) => {
    const { C_ } = createBlindSignature(pointFromHex(output.B_), keyset.secret[String(output.amount)], output.id);
    return { id: output.id, amount: Number(output.amount), C_: C_.toHex(true) };
  });
  const meltAnswer = (id: string) => ({ quote: id, ...melts.get(id)!, unit: "sat", expiry: 4_000_000_000, change: [] });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      // NUT-19 with no ttl: cashu-ts tries a cached endpoint again after each failed try, up to its own count.
      const cached = { ttl: null, cached_endpoints: ["/v1/mint/bolt11", "/v1/melt/bolt11", "/v1/swap"].map((p) => ({ method: "POST", path: p })) };
      return answer({ name: "Fake", version: "nutshell/0.17.0", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 8: { supported: true }, 9: { supported: true }, 19: cached } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id: keyset.id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${keyset.id}`) return answer({ keysets: [{ id: keyset.id, unit: "sat", keys: keyset.keys }] });
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const id = path.slice("/v1/mint/quote/bolt11/".length);
      const quote = quotes.get(id)!;
      return answer({ quote: id, request: fakeInvoice(quote.amount, new Uint8Array(32).fill(1)), amount: quote.amount, unit: "sat", state: quote.state, expiry: null });
    }
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(body.quote)!;
      if (quote.state !== "PAID") return refuse(20002, "Quote not paid");
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/melt/quote/bolt11") {
      const id = `melt-${melts.size + 1}`;
      melts.set(id, { request: body.request, amount: invoices.get(body.request)!, fee_reserve: FEE_RESERVE, state: "UNPAID" });
      return answer(meltAnswer(id));
    }
    if (path.startsWith("/v1/melt/quote/bolt11/")) return answer(meltAnswer(path.slice("/v1/melt/quote/bolt11/".length)));
    if (path === "/v1/melt/bolt11") {
      // Over: refused, which cashu-ts does not try again.
      if (state.closed) return refuse(20000, "closed");
      meltTries.push(Date.now());
      return new Promise<Response>((_, reject) => {
        held.push(() => reject(new TypeError("Failed to fetch")));
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    // The melt never happened: nothing it took is spent.
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: "UNSPENT", witness: null })) });
    if (path === "/v1/restore") return answer({ outputs: [], signatures: [] });
    return new Response("not found", { status: 404 });
  }));
  return {
    meltTries,
    invoice: (amount: number, fill: number) => { const invoice = fakeInvoice(amount, new Uint8Array(32).fill(fill)); invoices.set(invoice, amount); return invoice; },
    paid: (quote: string, amount: number) => quotes.set(quote, { amount, state: "PAID" }),
    /** Drops every connection still held: the test is over. */
    close: () => { state.closed = true; for (const drop of held.splice(0)) drop(); },
  };
}
let mint: ReturnType<typeof fakeMint>;

const proofs = async () => wrap<StoredProof[]>((await store(STORES.proofs, "readonly")).getAll());
const balance = async () => (await proofs()).filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);
const melts = async () => wrap<PendingMelt[]>((await store(STORES.melts, "readonly")).getAll());
const events = () => ({ onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });

/** `ms` of fake time, five seconds at a time, the IndexedDB work (on real macrotasks) let through in between. */
async function elapse(ms: number) {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  for (let passed = 0; passed < ms; passed += 5_000) {
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
  }
  await settle();
}

const wallets: CashuWallet[] = [];
beforeEach(async () => {
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes, STORES.settings, STORES.intents], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  // cashu-ts says each retry in the console.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mint = fakeMint();
  mint.paid("q0", 100);
  const quote: StoredQuote = { quote: "q0", mint: MINT, amount: 100, invoice: "lnbc", createdAt: Date.now(), expiresAt: null };
  await transact([STORES.quotes], (s) => { s[STORES.quotes].put(quote); });
  const funding = new CashuWallet(() => [MINT], events());
  await funding.checkQuotes([MINT]);
  await funding.stop();
  expect(await balance()).toBe(100);
});
afterEach(async () => {
  vi.useRealTimers();
  mint.close();
  for (const wallet of wallets.splice(0)) await wallet.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a Lightning payment at a mint whose melt cashu-ts tries again (NUT-19, no ttl) and that never answers", () => {
  it("ends its request within MELT_REQUEST_TIMEOUT_MS, and holds its coins SWAP_SETTLED_MS past it", async () => {
    const wallet = new CashuWallet(() => [MINT], events());
    wallets.push(wallet);
    const { quote } = await wallet.quoteInvoice(mint.invoice(30, 9));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const start = Date.now();
    const ended: { value?: unknown; at?: number } = {};
    wallet.payQuote(quote, MINT).then((value) => { ended.value = value; ended.at = Date.now(); }, (error: unknown) => { ended.value = error; ended.at = Date.now(); });

    await elapse(MELT_REQUEST_TIMEOUT_MS + 10_000);
    // Not paid, and not known to have failed: the payment is pending, its coins held.
    expect(ended).toEqual({ value: false, at: expect.any(Number) });
    expect(ended.at! - start).toBeLessThanOrEqual(MELT_REQUEST_TIMEOUT_MS + 5_000);
    // No try of it starts once its deadline passed.
    expect(mint.meltTries.every((at) => at - start < MELT_REQUEST_TIMEOUT_MS)).toBe(true);
    const held = await melts();
    expect(held).toHaveLength(1);

    // The mint may still act on what it took: the coins stay with the melt for the margin after its request ended.
    await elapse(SWAP_SETTLED_MS - 30_000);
    expect(await melts()).toHaveLength(1);
    expect(await balance()).toBe(100 - 30 - FEE_RESERVE);

    // Past it, the mint reads them unspent and the payment unpaid: they come back.
    await elapse(60_000);
    expect(await melts()).toEqual([]);
    expect(await balance()).toBe(100);
  }, 60_000);
});
