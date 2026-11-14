import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, pointFromHex, serializeMintKeys } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredQuote } from "../src/shared/types";
// covers: wallet.cashu.receive-lightning

/**
 * An open invoice of ours whose mint stops answering was asked about every minute for good (every 4 s once the mint
 * said it was paid), and each ask loaded the mint again (`/v1/info`, `/v1/keysets`, `/v1/keys`): 180 requests an hour
 * per invoice, 2,700 for a paid one, and it is never dropped, since only the mint's own "unpaid" drops it. A mint that
 * answers an error about a quote it no longer knows was asked every minute too. Now a quote whose mint does not answer,
 * or answers with an error, waits longer each time up to half an hour, and its mint is loaded once a round for all of
 * them. The real cashu-ts wallet on fake-indexeddb, in front of in-process mints with real keys; nothing leaves the
 * process, test sats only.
 */
const DEAD = "https://dead.mint.example";
const LIVE = "https://live.mint.example";
const HOUR = 3_600_000;
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });

interface Output { id: string; amount: number; B_: string }

/** Every mint request, by host and path; `DEAD` does not answer while `down`, `LIVE` knows none of our quotes. */
function fakeMints() {
  const made = createNewMintKeys(8, undefined, { versionByte: 0 });
  const keyset = { id: made.keysetId, keys: serializeMintKeys(made.pubKeys), secret: made.privKeys };
  const state = { down: true };
  const paid = new Set<string>();
  const requests: { host: string; path: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ host: url.host, path: url.pathname });
    if (url.origin === DEAD && state.down) throw new TypeError("Failed to fetch");
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.18.0", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 9: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id: keyset.id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${keyset.id}`) return answer({ keysets: [{ id: keyset.id, unit: "sat", keys: keyset.keys }] });
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const id = path.slice("/v1/mint/quote/bolt11/".length);
      // An expired quote the mint let go of.
      if (url.origin === LIVE || !paid.has(id)) return new Response(JSON.stringify({ code: 20007, detail: "Quote not found" }), { status: 400, headers: json });
      return answer({ quote: id, request: fakeInvoice(100, new Uint8Array(32).fill(1)), amount: 100, unit: "sat", state: "PAID", expiry: null });
    }
    if (path === "/v1/mint/bolt11") {
      const signatures = (body.outputs as Output[]).map((o) => ({ id: o.id, amount: Number(o.amount), C_: createBlindSignature(pointFromHex(o.B_), keyset.secret[String(o.amount)], o.id).C_.toHex(true) }));
      paid.delete(body.quote);
      return answer({ signatures });
    }
    return new Response("not found", { status: 404 });
  }));
  const at = (host: string) => requests.filter((r) => r.host === new URL(host).host);
  return { state, paid, requests, at };
}

const quote = (id: string, mint: string, extra: Partial<StoredQuote> = {}): StoredQuote => ({
  quote: id, mint, amount: 100, invoice: `lnbc1000n1${id}`, createdAt: Date.now() - 2 * HOUR, expiresAt: Date.now() - HOUR, ...extra,
});
const putQuotes = (quotes: StoredQuote[]) => transact([STORES.quotes], (s) => { for (const q of quotes) s[STORES.quotes].put(q); });
const storedQuotes = async () => wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());

/** Fake timeouts and clock only: IndexedDB (fake-indexeddb) runs on the real `setImmediate`. A second at a time. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
}
/** Requests to `host` in each of `hours` hours. */
async function perHour(mints: ReturnType<typeof fakeMints>, host: string, hours: number): Promise<number[]> {
  const counts: number[] = [];
  for (let h = 0; h < hours; h++) {
    const before = mints.at(host).length;
    await run(HOUR);
    counts.push(mints.at(host).length - before);
  }
  return counts;
}

let wallet: CashuWallet;
let events: { onChange: ReturnType<typeof vi.fn>; onTestMintNeeded: ReturnType<typeof vi.fn>; onQuotePaid: ReturnType<typeof vi.fn>; onMeltResolved: ReturnType<typeof vi.fn> };
let mints: ReturnType<typeof fakeMints>;
beforeEach(async () => {
  await transact([STORES.quotes, STORES.proofs, STORES.walletTx], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  vi.useFakeTimers({ now: Date.now(), toFake: ["setTimeout", "clearTimeout", "Date"] });
  mints = fakeMints();
  events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() };
  wallet = new CashuWallet(() => [DEAD, LIVE], events);
});
afterEach(async () => {
  await wallet.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an open invoice whose mint stops answering", () => {
  it("expired: asked a few times an hour once its mint stays down, not 180; it stays, the only claim on its sats", async () => {
    await putQuotes([quote("q1", DEAD)]);
    wallet.start();
    const counts = await perHour(mints, DEAD, 4);
    if (process.env.INVOICE_PACE) console.log(`one expired invoice at a dead mint, requests per hour: ${counts.join(", ")}`);
    expect(counts[0], "the first hour").toBeLessThanOrEqual(30);
    for (const count of counts.slice(1)) expect(count, "each hour after").toBeLessThanOrEqual(9);
    expect((await storedQuotes()).map((q) => q.quote)).toEqual(["q1"]);
  }, 120_000);

  it("20 of them: the mint is loaded once a round for all, not 3 requests per invoice", async () => {
    await putQuotes(Array.from({ length: 20 }, (_, i) => quote(`q${i}`, DEAD)));
    wallet.start();
    const counts = await perHour(mints, DEAD, 3);
    if (process.env.INVOICE_PACE) console.log(`20 expired invoices at a dead mint, requests per hour: ${counts.join(", ")}`);
    expect(counts[0], "the first hour").toBeLessThanOrEqual(30);
    for (const count of counts.slice(1)) expect(count, "each hour after").toBeLessThanOrEqual(9);
    expect(await storedQuotes()).toHaveLength(20);
  }, 120_000);

  it("paid, its ecash not minted yet: asked a few times an hour, not every 4 s", async () => {
    await putQuotes([quote("q1", DEAD, { paid: true, expiresAt: null })]);
    wallet.start();
    const counts = await perHour(mints, DEAD, 3);
    if (process.env.INVOICE_PACE) console.log(`one paid invoice at a dead mint, requests per hour: ${counts.join(", ")}`);
    expect(counts[0], "the first hour").toBeLessThanOrEqual(30);
    for (const count of counts.slice(1)) expect(count, "each hour after").toBeLessThanOrEqual(9);
  }, 120_000);

  it("its mint back: the screen showing it, or a check of its mint, asks at once, and the paid sats come in", async () => {
    await putQuotes([quote("q1", DEAD, { paid: true, expiresAt: null }), quote("q2", DEAD, { paid: true, expiresAt: null })]);
    wallet.start();
    await run(2 * HOUR);
    mints.state.down = false;
    mints.paid.add("q1");
    mints.paid.add("q2");
    // The receive screen shows the first one: asked now, not at the end of its half hour.
    expect(await wallet.watch("lnbc1000n1q1")).toBe(true);
    expect(events.onQuotePaid).toHaveBeenCalledWith(expect.objectContaining({ quote: "q1" }));
    // A check of the mint's invoices (a wallet about to be removed) asks at once too.
    await wallet.checkQuotes([DEAD]);
    expect(events.onQuotePaid).toHaveBeenCalledWith(expect.objectContaining({ quote: "q2" }));
    expect(await storedQuotes()).toEqual([]);
  }, 120_000);
});

describe("an open invoice its mint answers an error about", () => {
  it("is asked a few times an hour, not every minute", async () => {
    await putQuotes([quote("q1", LIVE)]);
    wallet.start();
    const counts = await perHour(mints, LIVE, 3);
    const asks = mints.at(LIVE).filter((r) => r.path.startsWith("/v1/mint/quote/")).length;
    if (process.env.INVOICE_PACE) console.log(`one expired invoice the mint no longer knows, requests per hour: ${counts.join(", ")}`);
    expect(counts.slice(1).every((count) => count <= 3), `${counts}`).toBe(true);
    expect(asks).toBeLessThanOrEqual(14);
  }, 120_000);
});
