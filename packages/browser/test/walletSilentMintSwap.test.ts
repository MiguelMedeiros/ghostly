import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, hashToCurve, pointFromHex, serializeMintKeys, type Proof } from "@cashu/cashu-ts";
import { CashuWallet, SwapUnsettledError } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { TEST_MINT } from "../src/shared/mints";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredPayment, StoredProof, StoredQuote } from "../src/shared/types";
// covers: payments.cashu.send

/**
 * A mint that takes the connection and never answers (overloaded, or a proxy in front of a dead backend). A chat payment
 * there waited cashu-ts' 5 min request timeout on the swap, then as long again asking the mint what happened, and only
 * then said the payment was not made. Swaps and the questions after one now give up within the swap's own timeout, so
 * the same answer comes within a minute. Real cashu-ts in front of an in-memory Testnet mint (BDHKE, real keys).
 */
const MINT = TEST_MINT;
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });

interface Output { id: string; amount: number; B_: string }

function fakeMint() {
  const made = createNewMintKeys(8, undefined, { versionByte: 0 });
  const keyset = { id: made.keysetId, keys: serializeMintKeys(made.pubKeys), secret: made.privKeys };
  const spent = new Set<string>();
  const signed = new Map<string, { id: string; amount: number; C_: string }>();
  const quotes = new Map<string, { amount: number; state: string }>();
  /** Paths the mint takes and never answers: the request ends only when its caller gives up on it. */
  const silent = new Set<string>();
  const asked: string[] = [];
  const held: (() => void)[] = [];
  const Y = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const total = (items: { amount: number | string }[]) => items.reduce((sum, item) => sum + Number(item.amount), 0);
  const sign = (outputs: Output[]) => outputs.map((output) => {
    const { C_ } = createBlindSignature(pointFromHex(output.B_), keyset.secret[String(output.amount)], output.id);
    const signature = { id: output.id, amount: Number(output.amount), C_: C_.toHex(true) };
    signed.set(output.B_, signature);
    return signature;
  });
  const state = { actsWhenSilent: false, cachesSwaps: false };
  const respond = (path: string, body: Record<string, unknown>) => {
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      // NUT-19 with no ttl: cashu-ts tries a cached endpoint again after each failed try, for as long as it takes.
      const cached = state.cachesSwaps ? { 19: { ttl: null, cached_endpoints: ["/v1/swap", "/v1/restore"].map((p) => ({ method: "POST", path: p })) } } : {};
      return answer({ name: "Fake", version: "cdk-mintd/0.17.7", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 9: { supported: true }, ...cached } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id: keyset.id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${keyset.id}`) return answer({ keysets: [{ id: keyset.id, unit: "sat", keys: keyset.keys }] });
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const id = path.slice("/v1/mint/quote/bolt11/".length);
      const quote = quotes.get(id)!;
      return answer({ quote: id, request: fakeInvoice(quote.amount, new Uint8Array(32).fill(1)), amount: quote.amount, unit: "sat", state: quote.state, expiry: null });
    }
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(String(body.quote))!;
      if (quote.state !== "PAID") return refuse(20002, "Quote not paid");
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs as Output[]) });
    }
    if (path === "/v1/swap") {
      const inputs = body.inputs as Proof[];
      if (inputs.some((p) => spent.has(Y(p.secret)))) return refuse(11001, "Token already spent");
      if (total(inputs) !== total(body.outputs as Output[])) return refuse(11002, "Transaction is not balanced");
      for (const p of inputs) spent.add(Y(p.secret));
      return answer({ signatures: sign(body.outputs as Output[]) });
    }
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? "SPENT" : "UNSPENT", witness: null })) });
    if (path === "/v1/restore") {
      const found = (body.outputs as Output[]).filter((o) => signed.has(o.B_));
      return answer({ outputs: found, signatures: found.map((o) => signed.get(o.B_)!) });
    }
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(MINT).origin) return new Response("offline", { status: 503 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    asked.push(url.pathname);
    if (!silent.has(url.pathname)) return respond(url.pathname, body);
    // Taken, and acted on when the mint does so: only its answer never comes.
    if (state.actsWhenSilent) respond(url.pathname, body);
    return new Promise<Response>((_, reject) => {
      held.push(() => reject(new TypeError("Failed to fetch")));
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    });
  }));
  return {
    asked,
    /** Drops every connection still held: the test is over. */
    close: () => { silent.clear(); for (const drop of held.splice(0)) drop(); },
    paid: (quote: string, amount: number) => quotes.set(quote, { amount, state: "PAID" }),
    cachesSwaps: () => { state.cachesSwaps = true; },
    silent: (paths: string[], acts = false) => { silent.clear(); for (const p of paths) silent.add(p); state.actsWhenSilent = acts; },
  };
}
let mint: ReturnType<typeof fakeMint>;

const proofs = async () => wrap<StoredProof[]>((await store(STORES.proofs, "readonly")).getAll());
const balance = async () => (await proofs()).filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);
const payments = async () => wrap<StoredPayment[]>((await store(STORES.payments, "readonly")).getAll());
const events = () => ({ onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });

/** `ms` of fake time, a second at a time, the IndexedDB work (on real macrotasks) let through in between. */
async function elapse(ms: number) {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  for (let passed = 0; passed < ms; passed += 1_000) {
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await settle();
}

const wallets: CashuWallet[] = [];
beforeEach(async () => {
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes, STORES.settings, STORES.intents], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  mint = fakeMint();
  // 100 test sats in the wallet: coins of 64, 32 and 4, so 27 needs a swap.
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

/** A chat payment of `amount`, as `sendPayment` makes it: the record that keeps the token is written with the split. */
function pay(wallet: CashuWallet, amount: number) {
  const outbox = vi.fn((token: string, at: string): StoredPayment => ({ id: "pay-1", linkId: "chat", kind: "payment", direction: "out", amount, unit: "sat", state: "pending", createdAt: Date.now(), mint: at, token }));
  const ended: { value?: unknown } = {};
  wallet.createToken(amount, undefined, undefined, outbox).then((sent) => { ended.value = sent; }, (error: unknown) => { ended.value = error; });
  return { outbox, ended };
}

describe("a Cashu payment at a mint that takes the connection and never answers", () => {
  it("says the mint has not answered within a minute, not after two 5-minute waits", async () => {
    const wallet = new CashuWallet(() => [MINT], events());
    wallets.push(wallet);
    // Loaded while the mint answers, as a wallet that just paid there is.
    await wallet.checkMint(MINT);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mint.silent(["/v1/swap", "/v1/restore", "/v1/checkstate"]);
    const { outbox, ended } = pay(wallet, 27);
    await elapse(60_000);
    expect(ended.value).toBeInstanceOf(SwapUnsettledError);
    expect((ended.value as Error).message).toContain("has not answered yet. The payment was not made.");
    expect(outbox).not.toHaveBeenCalled();
    expect(await payments()).toEqual([]);
    // Asked once, then asked what happened: no swap sent again.
    expect(mint.asked.filter((p) => p === "/v1/swap")).toHaveLength(1);
  }, 30_000);

  it("gives up within the same minute at a mint whose swaps cashu-ts tries again (NUT-19, no ttl)", async () => {
    mint.cachesSwaps();
    const wallet = new CashuWallet(() => [MINT], events());
    wallets.push(wallet);
    await wallet.checkMint(MINT);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mint.silent(["/v1/swap", "/v1/restore", "/v1/checkstate"]);
    const { ended } = pay(wallet, 27);
    await elapse(60_000);
    expect(ended.value).toBeInstanceOf(SwapUnsettledError);
    // The deadline ends the request: no try of it starts once it passed.
    expect(mint.asked.filter((p) => p === "/v1/swap")).toHaveLength(1);
  }, 30_000);

  it("whose swap the mint made after the wallet gave up: the coins come back to the wallet, and no payment is kept", async () => {
    const wallet = new CashuWallet(() => [MINT], events());
    wallets.push(wallet);
    await wallet.checkMint(MINT);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The mint makes the swap (the inputs spent, the outputs signed), and its answer never comes; nor do its answers after.
    mint.silent(["/v1/swap", "/v1/restore", "/v1/checkstate"], true);
    const { outbox, ended } = pay(wallet, 27);
    await elapse(60_000);
    expect(ended.value).toBeInstanceOf(SwapUnsettledError);
    expect(await balance(), "the 100 sats are set aside while the swap is open").toBeLessThan(100);

    // The mint answers again: asked where the swap stands, it gives back what it signed, and it is all the wallet's.
    mint.silent([]);
    await wallet.settleSwaps([MINT]);
    expect(await balance()).toBe(100);
    expect((await proofs()).every((p) => !p.reserved)).toBe(true);
    expect(await wrap((await store(STORES.swaps, "readonly")).getAll())).toEqual([]);
    expect(outbox).not.toHaveBeenCalled();
    expect(await payments()).toEqual([]);
    expect(mint.asked.filter((p) => p === "/v1/swap")).toHaveLength(1);
  }, 30_000);
});
