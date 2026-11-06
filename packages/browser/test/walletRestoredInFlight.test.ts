import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, hashToCurve, pointFromHex, serializeMintKeys, verifyUnblindedSignature, type Proof } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { snapshotDatabase, type DatabaseSnapshot } from "../src/backup/database";
import { STORES, databaseName, store, transact, wrap } from "../src/shared/idb";
import { RESTORED_WALLET_STORES, restoredWalletRow } from "../src/shared/restoredRows";
import type { PendingMelt, StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
// covers: backup.profile.file, wallet.cashu.pay-invoice, wallet.cashu.receive-lightning

/**
 * A backup made while a Lightning payment waited on the mint and a paid invoice's ecash was not yet in, restored after
 * the profile it came from finished both (WISP 05 § Restoring). The wallet is real cashu-ts in front of an in-memory
 * mint that signs with real keys (BDHKE), keeps what is spent and what it signed (NUT-07, NUT-09), returns a payment's
 * change on its blank outputs (NUT-08), and can hold a payment pending or lose its answer to a mint request. The
 * restore writes the bundle's rows as the app's restore does (`restoredWalletRow`). Test sats only, nothing leaves the
 * process.
 */
const MINT = "https://mint.example";
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });
/** What every payment really costs in routing: the rest of its 2 sats of reserve comes back as change. */
const FEE_RESERVE = 2, ROUTING_FEE = 1;

interface Output { id: string; amount: number; B_: string }

function fakeMint() {
  const made = createNewMintKeys(8, undefined, { versionByte: 0 });
  const keyset = { id: made.keysetId, keys: serializeMintKeys(made.pubKeys), secret: made.privKeys };
  const spent = new Set<string>();
  const signed = new Map<string, { id: string; amount: number; C_: string }>();
  const quotes = new Map<string, { amount: number; state: string }>();
  const melts = new Map<string, { request: string; amount: number; fee_reserve: number; state: string; outputs: Output[]; change: object[] }>();
  const invoices = new Map<string, number>();
  const Y = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const total = (items: { amount: number | string }[]) => items.reduce((sum, item) => sum + Number(item.amount), 0);
  const signOne = (output: Output, amount: number) => {
    const { C_ } = createBlindSignature(pointFromHex(output.B_), keyset.secret[String(amount)], output.id);
    const signature = { id: output.id, amount, C_: C_.toHex(true) };
    signed.set(output.B_, signature);
    return signature;
  };
  const sign = (outputs: Output[]) => outputs.map((output) => signOne(output, Number(output.amount)));
  const inputsRefusal = (inputs: Proof[]) => {
    for (const input of inputs) {
      const key = input.id === keyset.id ? keyset.secret[String(input.amount)] : undefined;
      if (!key || !verifyUnblindedSignature({ secret: new TextEncoder().encode(input.secret), C: pointFromHex(input.C) } as never, key)) return refuse(10003, "Proof could not be verified");
      if (spent.has(Y(input.secret))) return refuse(11001, "Token already spent");
    }
    return undefined;
  };
  /** The payment went through: what its reserve did not cost is signed on its blank outputs, one power of two each. */
  const pay = (id: string) => {
    const melt = melts.get(id)!;
    let left = melt.fee_reserve - ROUTING_FEE;
    melt.change = [];
    for (const output of melt.outputs) {
      if (left <= 0) break;
      const amount = 2 ** Math.floor(Math.log2(left));
      melt.change.push(signOne(output, amount));
      left -= amount;
    }
    melt.state = "PAID";
  };
  const meltAnswer = (id: string) => {
    const { outputs: _outputs, ...melt } = melts.get(id)!;
    return { quote: id, ...melt, unit: "sat", expiry: 4_000_000_000 };
  };
  const state = { holdMelts: false, loseMintAnswer: false };

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.18.0", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 8: { supported: true }, 9: { supported: true } } });
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
      if (total(body.outputs) !== quote.amount) return refuse(11002, "Transaction is not balanced");
      quote.state = "ISSUED";
      const signatures = sign(body.outputs);
      // The mint signed, and its answer never reached the wallet.
      if (state.loseMintAnswer) { state.loseMintAnswer = false; throw new TypeError("Failed to fetch"); }
      return answer({ signatures });
    }
    if (path === "/v1/swap") {
      const refused = inputsRefusal(body.inputs);
      if (refused) return refused;
      if (total(body.inputs) !== total(body.outputs)) return refuse(11002, "Transaction is not balanced");
      for (const p of body.inputs as Proof[]) spent.add(Y(p.secret));
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/melt/quote/bolt11") {
      const id = `melt-${melts.size + 1}`;
      melts.set(id, { request: body.request, amount: invoices.get(body.request)!, fee_reserve: FEE_RESERVE, state: "UNPAID", outputs: [], change: [] });
      return answer(meltAnswer(id));
    }
    if (path.startsWith("/v1/melt/quote/bolt11/")) return answer(meltAnswer(path.slice("/v1/melt/quote/bolt11/".length)));
    if (path === "/v1/melt/bolt11") {
      const melt = melts.get(body.quote)!;
      const refused = inputsRefusal(body.inputs);
      if (refused) return refused;
      if (total(body.inputs) < melt.amount + melt.fee_reserve) return refuse(11002, "Transaction is not balanced");
      for (const p of body.inputs as Proof[]) spent.add(Y(p.secret));
      melt.outputs = body.outputs ?? [];
      if (state.holdMelts) melt.state = "PENDING";
      else pay(body.quote);
      return answer(meltAnswer(body.quote));
    }
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? "SPENT" : "UNSPENT", witness: null })) });
    if (path === "/v1/restore") {
      const found = (body.outputs as Output[]).filter((o) => signed.has(o.B_));
      return answer({ outputs: found, signatures: found.map((o) => signed.get(o.B_)!) });
    }
    return new Response("not found", { status: 404 });
  }));

  return {
    state,
    /** An invoice of `amount` sats this mint can pay. */
    invoice: (amount: number, fill: number) => { const invoice = fakeInvoice(amount, new Uint8Array(32).fill(fill)); invoices.set(invoice, amount); return invoice; },
    /** Someone paid one of our invoices. */
    paid: (quote: string, amount: number) => quotes.set(quote, { amount, state: "PAID" }),
    quoteState: (quote: string) => quotes.get(quote)?.state,
    /** A payment the mint held pending goes through. */
    settle: (id: string) => pay(id),
    /** Ecash paid away somewhere else (the profile the backup came from paid with it). */
    spend: (proofs: readonly { secret: string }[]) => { for (const p of proofs) spent.add(Y(p.secret)); },
    isSpent: (proof: { secret: string }) => spent.has(Y(proof.secret)),
  };
}

const all = async <T>(name: string) => wrap<T[]>((await store(name, "readonly")).getAll());
const proofs = () => all<StoredProof>(STORES.proofs);
const sum = (items: readonly { amount: number }[]) => items.reduce((total, p) => total + p.amount, 0);
const balance = async () => sum((await proofs()).filter((p) => !p.reserved));
const quote = (id: string, amount: number): StoredQuote => ({ quote: id, mint: MINT, amount, invoice: "lnbc", createdAt: Date.now(), expiresAt: null });
const putQuote = async (q: StoredQuote) => transact([STORES.quotes], (s) => { s[STORES.quotes].put(q); });
const WALLET_STORES = [STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes, STORES.intents];

const wallets: CashuWallet[] = [];
const newWallet = () => {
  const wallet = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });
  wallets.push(wallet);
  return wallet;
};
/** The app started on this database: it settles what it finds written down, and asks about restored ecash. */
async function started(): Promise<CashuWallet> {
  const wallet = newWallet();
  wallet.start();
  await vi.waitFor(async () => {
    expect(await all(STORES.melts)).toEqual([]);
    expect(await all(STORES.quotes)).toEqual([]);
    expect((await proofs()).filter((p) => p.unchecked)).toEqual([]);
  }, { timeout: 5_000 });
  return wallet;
}

/** The bundle's wallet rows written back as the app's restore writes them (`restoredRows` in profileBackup.ts). */
async function restore(backup: DatabaseSnapshot): Promise<void> {
  await transact(WALLET_STORES, (s) => {
    for (const name of WALLET_STORES) {
      s[name].clear();
      const entry = backup.stores.find((e) => e.name === name)!;
      entry.values.forEach((value, i) => {
        const row = RESTORED_WALLET_STORES.includes(name) ? restoredWalletRow(name, value) : value;
        if (entry.keyPath) s[name].put(row);
        else s[name].put(row, entry.keys[i]);
      });
    }
  });
}

let mint: ReturnType<typeof fakeMint>;
let backup: DatabaseSnapshot;
/** The proofs the original holds once it settled both, that the backup did not have. */
let broughtByBoth: StoredProof[];

beforeEach(async () => {
  await transact(WALLET_STORES, (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  mint = fakeMint();
  const original = newWallet();
  // 100 sats: a 64, a 32 and a 4.
  mint.paid("q0", 100);
  await putQuote(quote("q0", 100));
  await original.checkQuotes([MINT]);
  expect(await balance()).toBe(100);
  // A payment of 30 with 2 of reserve, held pending by the mint: the 32 is handed over and reserved.
  mint.state.holdMelts = true;
  const { quote: meltQuote } = await original.quoteInvoice(mint.invoice(30, 9));
  expect(await original.payQuote(meltQuote, MINT)).toBe(false);
  mint.state.holdMelts = false;
  // An invoice of 21, paid: the mint signs its outputs, and its answer is lost.
  mint.paid("q21", 21);
  await putQuote(quote("q21", 21));
  mint.state.loseMintAnswer = true;
  await original.checkQuotes([MINT]);
  expect(mint.quoteState("q21")).toBe("ISSUED");
  // The backup: 68 free, 32 reserved for the payment, the invoice paid with its outputs written down.
  expect(await balance()).toBe(68);
  expect(await all<PendingMelt>(STORES.melts)).toHaveLength(1);
  expect(await all<StoredQuote>(STORES.quotes)).toEqual([expect.objectContaining({ quote: "q21", paid: true, outputs: expect.any(Array) })]);
  backup = (await snapshotDatabase(databaseName()))!;
  await original.stop();
  // The mint settles the payment: 1 of the reserve comes back as change.
  mint.settle(meltQuote);
  broughtByBoth = [];
});
afterEach(async () => {
  for (const wallet of wallets.splice(0)) await wallet.stop();
  vi.unstubAllGlobals();
});

describe("a backup restored with a Lightning payment and a paid invoice in flight", () => {
  it("when the original finished both and spent what they brought, the copy counts none of it, and its next payment goes through", async () => {
    const before = new Set((await proofs()).map((p) => p.secret));
    // The original runs on: the payment's change and the invoice's ecash come in, and it pays with them.
    const original = await started();
    broughtByBoth = (await proofs()).filter((p) => !before.has(p.secret));
    expect(sum(broughtByBoth)).toBe(FEE_RESERVE - ROUTING_FEE + 21);
    expect(await balance()).toBe(68 + 22);
    mint.spend(broughtByBoth);
    await original.stop();

    await restore(backup);
    const copy = await started();
    const held = await proofs();
    // Nothing the copy holds is spent at the mint: the change and the invoice's ecash were checked and dropped.
    expect(held.filter((p) => mint.isSpent(p)).map((p) => p.amount), "proofs the mint reads spent").toEqual([]);
    expect(await balance()).toBe(68);
    expect(await copy.balance()).toBe(68);
    // Each settled once, here too: the payment and the invoice are in the copy's history.
    const history = await all<WalletTx>(STORES.walletTx);
    expect(history.filter((tx) => tx.kind === "lightning-out").map((tx) => tx.amount)).toEqual([30]);
    expect(history.filter((tx) => tx.quote === "q21").map((tx) => tx.amount)).toEqual([21]);

    // The next payment takes all the copy holds, and goes through.
    const { quote: next, amount, feeReserve } = await copy.quoteInvoice(mint.invoice(66, 7));
    expect(amount + feeReserve).toBe(68);
    await expect(copy.payQuote(next, MINT)).resolves.toBe(true);
    expect(await balance()).toBe(FEE_RESERVE - ROUTING_FEE);
  });

  it("when the original never finished them, the copy finishes each once and credits what they brought", async () => {
    await restore(backup);
    const copy = await started();
    expect((await proofs()).filter((p) => mint.isSpent(p))).toEqual([]);
    expect(await balance()).toBe(68 + 1 + 21);
    const history = async () => (await all<WalletTx>(STORES.walletTx)).filter((tx) => tx.kind === "lightning-out" || tx.quote === "q21").map((tx) => [tx.kind, tx.amount]).sort();
    expect(await history()).toEqual([["lightning-in", 21], ["lightning-out", 30]]);
    // Started again: nothing is credited a second time.
    await copy.stop();
    await started();
    expect(await balance()).toBe(90);
    expect(await history()).toEqual([["lightning-in", 21], ["lightning-out", 30]]);
    // And the copy spends it.
    const again = wallets.at(-1)!;
    const { quote: next } = await again.quoteInvoice(mint.invoice(80, 5));
    await expect(again.payQuote(next, MINT)).resolves.toBe(true);
    expect(await balance()).toBe(90 - 80 - ROUTING_FEE);
  });
});
