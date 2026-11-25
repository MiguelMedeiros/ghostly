import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewMintKeys, serializeMintKeys } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredQuote } from "../src/shared/types";
// covers: wallet.cashu.receive-lightning

/**
 * A mint may give no expiry for an invoice it makes (NUT-04 `expiry: null`). The quote was then kept with none, and an
 * unpaid quote is only dropped once it has expired: it was asked about every minute for as long as the app ran, and
 * kept across restarts, long after its invoice (an hour) could be paid. Each unpaid invoice at such a mint added 60
 * requests an hour, for good. Now the invoice's own expiry stands in for the mint's. The real cashu-ts wallet on
 * fake-indexeddb, in front of an in-process mint; nothing leaves the process, test sats only.
 */
const MINT = "https://mint.example";
const HOUR = 3_600_000;
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });

/** A mint that knows one unpaid invoice (an hour long) and gives `expiry` for it; every ask about it is counted. */
function fakeMint(expiry: number | null) {
  const made = createNewMintKeys(8, undefined, { versionByte: 0 });
  const keyset = { id: made.keysetId, keys: serializeMintKeys(made.pubKeys) };
  const invoice = fakeInvoice(100, new Uint8Array(32).fill(1));
  const quote = () => ({ quote: "q1", request: invoice, amount: 100, unit: "sat", state: "UNPAID", expiry });
  const asks: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.18.0", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 9: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id: keyset.id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${keyset.id}`) return answer({ keysets: [{ id: keyset.id, unit: "sat", keys: keyset.keys }] });
    if (path === "/v1/mint/quote/bolt11") return answer(quote());
    if (path === "/v1/mint/quote/bolt11/q1") { asks.push(Date.now()); return answer(quote()); }
    return new Response("not found", { status: 404 });
  }));
  return { asks, invoice };
}

const storedQuotes = async () => wrap<StoredQuote[]>((await store(STORES.quotes, "readonly")).getAll());

/** Fake timeouts and clock only: IndexedDB (fake-indexeddb) runs on the real `setImmediate`. A second at a time. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
}
/** Asks about the invoice in each of `hours` hours. */
async function perHour(asks: number[], hours: number): Promise<number[]> {
  const counts: number[] = [];
  for (let h = 0; h < hours; h++) {
    const before = asks.length;
    await run(HOUR);
    counts.push(asks.length - before);
  }
  return counts;
}

let wallet: CashuWallet;
beforeEach(async () => {
  await transact([STORES.quotes], (s) => s[STORES.quotes].clear());
  vi.useFakeTimers({ now: Date.now(), toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(async () => {
  await wallet.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const newWallet = () => new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() }, () => [MINT]);

describe("an unpaid invoice whose mint gives no expiry", () => {
  it("goes once its invoice expired, as one whose mint gives an expiry, instead of being asked about every minute", async () => {
    const mint = fakeMint(null);
    wallet = newWallet();
    await wallet.receiveLightning(100);
    expect((await perHour(mint.asks, 6)).slice(2)).toEqual([0, 0, 0, 0]);
    expect(await storedQuotes()).toHaveLength(0);
  }, 120_000);

  it("kept with no expiry before: goes too once its invoice expired", async () => {
    const mint = fakeMint(null);
    await transact([STORES.quotes], (s) => s[STORES.quotes].put({
      quote: "q1", mint: MINT, amount: 100, invoice: mint.invoice, createdAt: Date.now(), expiresAt: null,
    } satisfies StoredQuote));
    wallet = newWallet();
    await wallet.start();
    expect((await perHour(mint.asks, 4)).slice(2)).toEqual([0, 0]);
    expect(await storedQuotes()).toHaveLength(0);
  }, 120_000);
});
