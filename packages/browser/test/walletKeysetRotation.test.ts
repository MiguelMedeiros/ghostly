import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, getTokenMetadata, hashToCurve, pointFromHex, serializeMintKeys, verifyUnblindedSignature, type Proof } from "@cashu/cashu-ts";
import { ENDPOINT, type GhostLink, type PaymentReview, type PaymentResult } from "@ghostly/core";
import { CashuWallet, SwapUnsettledError } from "../src/engine/wallet";
import { PaymentDesk } from "../src/engine/payments";
import { CashuAdapter, NEVER_REACHED_MINT } from "../src/engine/paymentAdapters/cashu";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { PendingMelt, PendingSwap, StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
// covers: wallet.cashu.receive-lightning, wallet.cashu.receive-token, payments.cashu.send, payments.chat.review, wallet.cashu.pay-invoice

/**
 * A mint that rotates its keyset under a wallet that loaded it before. The wallet is real cashu-ts in front of an
 * in-memory mint that signs with real keys (BDHKE), keeps what is spent and what it signed (NUT-07, NUT-09), and
 * refuses outputs on a keyset it retired with code 12002, as cdk-mintd does. cashu-ts reloads the mint's keysets on
 * such a refusal and throws a `StaleKeysetError`: the mint's refusal all the same, never a mint that did not answer.
 */
const MINT = "https://mint.example";
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });

interface Output { id: string; amount: number; B_: string }
interface Signature { id: string; amount: number; C_: string }
interface Keyset { id: string; active: boolean; keys: Record<string, string>; secret: Record<string, Uint8Array> }

function fakeMint() {
  const keysets: Keyset[] = [];
  const newKeyset = () => {
    const made = createNewMintKeys(8, undefined, { versionByte: 0 });
    keysets.push({ id: made.keysetId, active: true, keys: serializeMintKeys(made.pubKeys), secret: made.privKeys });
  };
  newKeyset();
  const spent = new Set<string>();
  const signed = new Map<string, Signature>();
  const quotes = new Map<string, { amount: number; state: string }>();
  const melts = new Map<string, { request: string; amount: number; fee_reserve: number; state: string }>();
  const calls: string[] = [];
  /** Requests to these paths reach a mint that never answers, and does nothing with them. */
  const held = new Set<string>();
  /** The mint rotates its keyset again right before it reads each swap. */
  let rotateOnSwap = false;
  const Y = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const total = (items: { amount: number | string }[]) => items.reduce((sum, item) => sum + Number(item.amount), 0);

  /** Every output on an active keyset of this mint, or nothing is signed. */
  const refusal = (outputs: Output[]) => {
    for (const output of outputs) {
      const keyset = keysets.find((k) => k.id === output.id);
      if (!keyset) return refuse(12001, "Keyset is not known");
      if (!keyset.active) return refuse(12002, "Keyset is inactive, cannot sign messages");
    }
    return undefined;
  };
  const sign = (outputs: Output[]) => outputs.map((output) => {
    const keyset = keysets.find((k) => k.id === output.id)!;
    const { C_ } = createBlindSignature(pointFromHex(output.B_), keyset.secret[String(output.amount)], output.id);
    const signature = { id: output.id, amount: Number(output.amount), C_: C_.toHex(true) };
    signed.set(output.B_, signature);
    return signature;
  });
  /** Inputs this mint signed (on any keyset, retired ones too), none of them spent. */
  const inputsRefusal = (inputs: Proof[]) => {
    for (const input of inputs) {
      const keyset = keysets.find((k) => k.id === input.id);
      const key = keyset?.secret[String(input.amount)];
      if (!key || !verifyUnblindedSignature({ secret: new TextEncoder().encode(input.secret), C: pointFromHex(input.C) } as never, key)) return refuse(10003, "Proof could not be verified");
      if (spent.has(Y(input.secret))) return refuse(11001, "Token already spent");
    }
    return undefined;
  };

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push(path);
    if (held.has(path)) throw new TypeError("Failed to fetch");
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.18.0", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 9: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: keysets.map((k) => ({ id: k.id, unit: "sat", active: k.active, input_fee_ppk: 0 })) });
    if (path === "/v1/keys") return answer({ keysets: keysets.filter((k) => k.active).map((k) => ({ id: k.id, unit: "sat", keys: k.keys })) });
    if (path.startsWith("/v1/keys/")) {
      const keyset = keysets.find((k) => k.id === path.slice("/v1/keys/".length));
      return keyset ? answer({ keysets: [{ id: keyset.id, unit: "sat", keys: keyset.keys }] }) : refuse(12001, "Keyset is not known");
    }
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const id = path.slice("/v1/mint/quote/bolt11/".length);
      const quote = quotes.get(id)!;
      return answer({ quote: id, request: fakeInvoice(quote.amount, new Uint8Array(32).fill(1)), amount: quote.amount, unit: "sat", state: quote.state, expiry: null });
    }
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(body.quote)!;
      if (quote.state !== "PAID") return refuse(20002, "Quote not paid");
      if (total(body.outputs) !== quote.amount) return refuse(11002, "Transaction is not balanced");
      const refused = refusal(body.outputs);
      if (refused) return refused;
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/swap") {
      if (rotateOnSwap) rotate();
      const refused = inputsRefusal(body.inputs) ?? refusal(body.outputs);
      if (refused) return refused;
      if (total(body.inputs) !== total(body.outputs)) return refuse(11002, "Transaction is not balanced");
      for (const p of body.inputs as Proof[]) spent.add(Y(p.secret));
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/melt/quote/bolt11") {
      const id = `melt-${melts.size + 1}`;
      melts.set(id, { request: body.request, amount: 30, fee_reserve: 2, state: "UNPAID" });
      return answer({ quote: id, ...melts.get(id)!, unit: "sat", expiry: 4_000_000_000 });
    }
    if (path.startsWith("/v1/melt/quote/bolt11/")) {
      const id = path.slice("/v1/melt/quote/bolt11/".length);
      return answer({ quote: id, ...melts.get(id)!, unit: "sat", expiry: 4_000_000_000, change: [] });
    }
    if (path === "/v1/melt/bolt11") {
      const melt = melts.get(body.quote)!;
      const refused = inputsRefusal(body.inputs) ?? refusal(body.outputs ?? []);
      if (refused) return refused;
      for (const p of body.inputs as Proof[]) spent.add(Y(p.secret));
      melt.state = "PAID";
      return answer({ quote: body.quote, ...melt, unit: "sat", expiry: 4_000_000_000, change: [] });
    }
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? "SPENT" : "UNSPENT", witness: null })) });
    if (path === "/v1/restore") {
      const found = (body.outputs as Output[]).filter((o) => signed.has(o.B_));
      return answer({ outputs: found, signatures: found.map((o) => signed.get(o.B_)!) });
    }
    return new Response("not found", { status: 404 });
  }));

  function rotate() { for (const k of keysets) k.active = false; newKeyset(); }
  return {
    calls,
    held,
    rotateOnSwap: (on: boolean) => { rotateOnSwap = on; },
    /** The token's ecash is spent by someone else (its sender took it back). */
    spend: (token: string) => { for (const p of getTokenMetadata(token).incompleteProofs) spent.add(Y(p.secret)); },
    unspent: (token: string) => getTokenMetadata(token).incompleteProofs.every((p) => !spent.has(Y(p.secret))),
    /** Someone paid one of our invoices. */
    paid: (quote: string, amount: number) => quotes.set(quote, { amount, state: "PAID" }),
    quoteState: (quote: string) => quotes.get(quote)?.state,
    /** The mint retires its keyset and signs on a new one from now on. */
    rotate,
    active: () => keysets.find((k) => k.active)!.id,
  };
}

const all = async <T>(name: string) => wrap<T[]>((await store(name, "readonly")).getAll());
const proofs = () => all<StoredProof>(STORES.proofs);
const balance = async () => (await proofs()).filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);
const reserved = async () => (await proofs()).filter((p) => p.reserved).map((p) => p.amount);
const quote = (id: string, amount: number): StoredQuote => ({ quote: id, mint: MINT, amount, invoice: "lnbc", createdAt: Date.now(), expiresAt: null });
const putQuote = async (q: StoredQuote) => transact([STORES.quotes], (s) => { s[STORES.quotes].put(q); });

let wallet: CashuWallet;
let mint: ReturnType<typeof fakeMint>;

/** 100 sats minted on the keyset the mint has now: the wallet has loaded the mint, as any running app has. */
async function funded() {
  mint.paid("q0", 100);
  await putQuote(quote("q0", 100));
  await wallet.checkQuotes([MINT]);
  expect(await balance()).toBe(100);
}

beforeEach(async () => {
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  mint = fakeMint();
  wallet = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });
  await funded();
});
afterEach(async () => {
  await wallet.stop();
  vi.unstubAllGlobals();
});

describe("after the mint rotates its keyset", () => {
  it("an invoice already paid to us is credited on the next round, with new outputs on the new keyset", async () => {
    mint.paid("q21", 21);
    await putQuote(quote("q21", 21));
    mint.rotate();
    await wallet.checkQuotes([MINT]);
    await wallet.checkQuotes([MINT]);
    expect(await all(STORES.quotes)).toEqual([]);
    expect(mint.quoteState("q21")).toBe("ISSUED");
    expect(await balance()).toBe(121);
    expect((await proofs()).filter((p) => p.id === mint.active()).reduce((sum, p) => sum + p.amount, 0)).toBe(21);
  });

  it("a redeem is made again on the keyset the mint signs with now, and the ecash is in at once", async () => {
    // Before, the first redeem after a rotation was refused in cashu-ts' own English ("Mint rejected a stale keyset;
    // the snapshot has been refreshed, re-prepare the operation"), and only a second try went through.
    const { token } = await wallet.createToken(13);
    expect(await balance()).toBe(87);
    mint.rotate();
    await expect(wallet.receiveToken(token)).resolves.toMatchObject({ amount: 13, mint: MINT, fee: 0 });
    expect(await balance()).toBe(100);
    expect((await proofs()).filter((p) => p.id === mint.active()).reduce((sum, p) => sum + p.amount, 0)).toBe(13);
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
    expect(mint.unspent(token)).toBe(false);
  });

  it("a redeem the mint refuses again on its new keyset ends in the wallet's own words, and the token stays good", async () => {
    const { token } = await wallet.createToken(13);
    // The mint rotates again before each swap it reads: the outputs made anew are on a retired keyset too.
    mint.rotateOnSwap(true);
    const thrown = await wallet.receiveToken(token).catch((error: unknown) => error);
    expect(thrown).not.toBeInstanceOf(SwapUnsettledError);
    expect((thrown as Error).message).toBe("The mint did not confirm the ecash");
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
    expect(mint.unspent(token)).toBe(true);
    mint.rotateOnSwap(false);
    await expect(wallet.receiveToken(token)).resolves.toMatchObject({ amount: 13, mint: MINT });
    expect(await balance()).toBe(100);
  });

  it("a send the mint refuses gives its sats back at once, and the next one goes through", async () => {
    mint.rotate();
    const first = await wallet.createToken(13).catch((error: unknown) => error);
    expect(first, "the mint answered").not.toBeInstanceOf(SwapUnsettledError);
    expect(first).toBeInstanceOf(Error);
    expect(await balance()).toBe(100);
    expect(await reserved()).toEqual([]);
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
    await expect(wallet.createToken(13)).resolves.toMatchObject({ mint: MINT });
    expect(await balance()).toBe(87);
  });

  it("a reviewed chat payment prepared before it fails at approval and gives its sats back, not 'outcome unknown'", async () => {
    const { fee, prepared } = await wallet.prepareReviewedCashu(MINT, 13);
    mint.rotate();
    const review = {
      id: "r1", linkId: "l1", payee: "bob", method: "cashu", network: "bitcoin", provider: MINT, asset: "BTC", unit: "sat",
      address: "creqA", expiresAt: Date.now() + 60_000, amount: 13, fee, feeCap: 20, createdAt: Date.now(), state: "submitted",
    } as PaymentReview;
    const publish = vi.fn(async () => {});
    const persist = vi.fn(async () => {});
    expect(await new CashuAdapter(wallet, publish).execute(review, prepared, persist)).toEqual({ settled: false, failed: true, error: NEVER_REACHED_MINT });
    expect(prepared.abandoned, "written down before anything is let go").toBe(true);
    expect(persist).toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await balance()).toBe(100);
    expect(await reserved()).toEqual([]);
  });

  it("a Lightning payment whose blank outputs the mint refuses fails at once, its sats back, not left pending", async () => {
    // 30 + 2 of fee reserve: the 32 coin pays it as it is, with no swap; only the blank outputs are on the old keyset.
    const { quote: id } = await wallet.quoteInvoice(fakeInvoice(30, new Uint8Array(32).fill(9)));
    mint.rotate();
    await expect(wallet.payQuote(id, MINT)).rejects.toThrow();
    expect(await all<PendingMelt>(STORES.melts)).toEqual([]);
    expect(await balance()).toBe(100);
    expect(await reserved()).toEqual([]);
  });
});

/** A chat of ours with a contact who pays in ecash: what the contact is told, and the lines the chat gets. */
function chat(payee: CashuWallet) {
  const results: PaymentResult[] = [];
  const lines: string[] = [];
  const link = { isDataLinkOpen: true, supportsPayments: true, allowsPayment: () => true, paymentEnabled: () => true, requirePaymentSupport: async () => {},
    sendPaymentResult: (result: PaymentResult) => results.push(result), sendPayment: async () => {}, sendPaymentRequest: async () => {}, sendPaymentAsk: async () => {} };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(async (row: { text: string }) => { lines.push(row.text); }), onChange: vi.fn() };
  const desk = new PaymentDesk(payee, host as never);
  const pay = (token: string) => desk.onPayment("l1", { id: "pay1", timestamp: 1_000, amount: { value: "13", asset: "sat" }, endpoint: [ENDPOINT.cashu, token] });
  return { desk, results, lines, pay };
}

/** The app opened again: a wallet (and a chat) that know nothing but what is stored. */
function reopened() {
  const desk: { current?: PaymentDesk } = {};
  const next = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: (swap, done) => desk.current?.onSwapSettled(swap, done) });
  const opened = chat(next);
  desk.current = opened.desk;
  return { wallet: next, ...opened };
}

const STALE = /stale keyset|re-prepare/i;

describe("ecash received around a keyset rotation", () => {
  it("a contact's ecash arriving after the rotation is credited, and nobody reads cashu-ts' words", async () => {
    const { token } = await wallet.createToken(13);
    mint.rotate();
    const { results, lines, pay } = chat(wallet);
    await pay(token);
    expect(results).toEqual([{ id: "pay1", ok: true, credited: "13" }]);
    expect(lines).toEqual(["⚡ 13 sats"]);
    expect(await balance()).toBe(100);
    expect(mint.unspent(token)).toBe(false);
  });

  it("a contact's redeem waiting on the mint when it rotated is credited after a restart, and the contact told", async () => {
    const { token } = await wallet.createToken(13);
    mint.held.add("/v1/swap");
    const first = chat(wallet);
    await first.pay(token);
    expect(first.results, "nothing failed: the mint has not said").toEqual([]);
    expect(await all<PendingSwap>(STORES.swaps)).toHaveLength(1);

    mint.rotate();
    mint.held.clear();
    await wallet.stop();
    const next = reopened();
    wallet = next.wallet;
    wallet.start();
    await vi.waitFor(() => expect(next.results).toHaveLength(1));
    expect(next.results).toEqual([{ id: "pay1", ok: true, credited: "13" }]);
    expect(next.lines).toEqual(["⚡ 13 sats"]);
    expect(await balance()).toBe(100);
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
    expect(mint.unspent(token)).toBe(false);
  });

  it("the same with the app closed long past the redeem's last request: the token is still good, so it is sent again", async () => {
    const { token } = await wallet.createToken(13);
    mint.held.add("/v1/swap");
    await chat(wallet).pay(token);
    mint.rotate();
    mint.held.clear();
    await wallet.stop();
    // An hour went by: no request of it can still reach the mint. Before, it was let go and the contact told it failed.
    const [kept] = await all<PendingSwap>(STORES.swaps);
    await transact([STORES.swaps], (s) => { s[STORES.swaps].put({ ...kept, createdAt: kept.createdAt - 3_600_000, attemptEndedAt: kept.attemptEndedAt! - 3_600_000 }); });
    const next = reopened();
    wallet = next.wallet;
    wallet.start();
    await vi.waitFor(() => expect(next.results).toHaveLength(1));
    expect(next.results).toEqual([{ id: "pay1", ok: true, credited: "13" }]);
    expect(await balance()).toBe(100);
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
  });

  it("a pasted token waiting on the mint when it rotated is in the wallet after a restart, as the wallet promised", async () => {
    const { token } = await wallet.createToken(13);
    mint.held.add("/v1/swap");
    const said = await wallet.receiveToken(token).catch((error: unknown) => error);
    expect(said).toBeInstanceOf(SwapUnsettledError);
    expect((said as Error).message).toBe("mint.example has not answered yet. The ecash is added to your wallet as soon as it does.");

    mint.rotate();
    mint.held.clear();
    await wallet.stop();
    wallet = reopened().wallet;
    wallet.start();
    await vi.waitFor(async () => expect(await balance()).toBe(100));
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
    expect((await all<WalletTx>(STORES.walletTx)).filter((tx) => tx.kind === "ecash-in")).toMatchObject([{ amount: 13, fee: 0 }]);
    expect(mint.unspent(token)).toBe(false);
  });

  it("a waiting redeem whose ecash its sender spent meanwhile ends after the restart, in the wallet's own words", async () => {
    const { token } = await wallet.createToken(13);
    mint.held.add("/v1/swap");
    await chat(wallet).pay(token);
    mint.rotate();
    mint.spend(token);
    mint.held.clear();
    await wallet.stop();
    const next = reopened();
    wallet = next.wallet;
    wallet.start();
    await vi.waitFor(() => expect(next.results).toHaveLength(1));
    expect(next.results).toEqual([{ id: "pay1", ok: false, error: "The mint did not confirm the ecash" }]);
    expect(next.lines).toEqual(["Could not receive 13 sats: The mint did not confirm the ecash"]);
    expect(await balance()).toBe(87);
    expect(await all<PendingSwap>(STORES.swaps)).toEqual([]);
  });

  it("ecash its sender spent before it arrived is refused as spent, never in cashu-ts' words", async () => {
    const { token } = await wallet.createToken(13);
    mint.rotate();
    mint.spend(token);
    const { results, lines, pay } = chat(wallet);
    await pay(token);
    expect(results).toEqual([{ id: "pay1", ok: false, error: "This ecash was already spent somewhere else" }]);
    expect(lines.join(" ")).not.toMatch(STALE);
    expect(await balance()).toBe(87);
  });
});
