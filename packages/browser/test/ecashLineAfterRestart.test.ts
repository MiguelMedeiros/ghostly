import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet, createBlindSignature, createNewMintKeys, hashToCurve, pointFromHex, serializeMintKeys, verifyUnblindedSignature, type Proof } from "@cashu/cashu-ts";
import type { GhostLink, Payment } from "@ghostly/core";
import { CashuWallet } from "../src/engine/wallet";
import { PaymentDesk } from "../src/engine/payments";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { TEST_MINT } from "../src/shared/mints";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredMessage, StoredPayment, StoredProof, StoredQuote, WalletTx } from "../src/shared/types";
// covers: payments.cashu.send

/**
 * Ecash sent in a chat whose app ends after the token is written down with its payment, before its chat line is. The
 * next start sends the token again (`replay`): the line comes with it, written from the stored payment, and only once.
 * Real cashu-ts in front of an in-memory Testnet mint that signs with real keys (BDHKE) and keeps what is spent.
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
  const Y = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const total = (items: { amount: number | string }[]) => items.reduce((sum, item) => sum + Number(item.amount), 0);
  const sign = (outputs: Output[]) => outputs.map((output) => {
    const { C_ } = createBlindSignature(pointFromHex(output.B_), keyset.secret[String(output.amount)], output.id);
    const signature = { id: output.id, amount: Number(output.amount), C_: C_.toHex(true) };
    signed.set(output.B_, signature);
    return signature;
  });
  const inputsRefusal = (inputs: Proof[]) => {
    for (const input of inputs) {
      const key = keyset.secret[String(input.amount)];
      if (input.id !== keyset.id || !key || !verifyUnblindedSignature({ secret: new TextEncoder().encode(input.secret), C: pointFromHex(input.C) } as never, key)) return refuse(10003, "Proof could not be verified");
      if (spent.has(Y(input.secret))) return refuse(11001, "Token already spent");
    }
    return undefined;
  };
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
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/swap") {
      const refused = inputsRefusal(body.inputs);
      if (refused) return refused;
      if (total(body.inputs) !== total(body.outputs)) return refuse(11002, "Transaction is not balanced");
      for (const p of body.inputs as Proof[]) spent.add(Y(p.secret));
      return answer({ signatures: sign(body.outputs) });
    }
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? "SPENT" : "UNSPENT", witness: null })) });
    if (path === "/v1/restore") {
      const found = (body.outputs as Output[]).filter((o) => signed.has(o.B_));
      return answer({ outputs: found, signatures: found.map((o) => signed.get(o.B_)!) });
    }
    return new Response("not found", { status: 404 });
  }));
  return { paid: (quote: string, amount: number) => quotes.set(quote, { amount, state: "PAID" }) };
}

const all = async <T>(name: string) => wrap<T[]>((await store(name, "readonly")).getAll());
const balance = async () => (await all<StoredProof>(STORES.proofs)).filter((p) => !p.reserved).reduce((sum, p) => sum + p.amount, 0);

/** The chat's history, as the engine keeps it: a line is added once, by its id. */
const history = new Map<string, StoredMessage>();
const frames: Payment[] = [];
const wallets: CashuWallet[] = [];

/** One run of the app: a wallet and a desk on the same database. `ends`: its app ends as it writes a chat line. */
function app(ends = false) {
  const wallet = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() });
  wallets.push(wallet);
  const link = {
    isDataLinkOpen: true, supportsPayments: true, allowsPayment: () => true, paymentEnabled: () => true, requirePaymentSupport: async () => {},
    sendPayment: async (payment: Payment) => { frames.push(payment); }, sendPaymentResult: vi.fn(), sendPaymentRequest: vi.fn(), sendPaymentAsk: vi.fn(),
  };
  const desk = new PaymentDesk(wallet, {
    getLink: () => link as unknown as GhostLink,
    storeMessage: async (message: StoredMessage) => {
      if (ends) await new Promise(() => {});
      const key = `${message.linkId}/${message.id}`;
      if (!history.has(key)) history.set(key, message);
    },
    onChange: vi.fn(),
    defaultNetwork: () => "testnet",
  });
  return { wallet, desk };
}

beforeEach(async () => {
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
  history.clear();
  frames.length = 0;
  const mint = fakeMint();
  // 100 test sats in the wallet.
  mint.paid("q0", 100);
  const quote: StoredQuote = { quote: "q0", mint: MINT, amount: 100, invoice: "lnbc", createdAt: Date.now(), expiresAt: null };
  await transact([STORES.quotes], (s) => { s[STORES.quotes].put(quote); });
  await app().wallet.checkQuotes([MINT]);
  expect(await balance()).toBe(100);
});
afterEach(async () => {
  for (const wallet of wallets.splice(0)) await wallet.stop();
  vi.unstubAllGlobals();
});

/** The contact's app: redeems the token at the mint, and says it is paid. */
async function contactRedeems(frame: Payment) {
  const theirs = new Wallet(MINT);
  await theirs.loadMint();
  await theirs.receive(frame.endpoint[1]);
}

const linesFor = (paymentId: string) => [...history.values()].filter((m) => m.paymentId === paymentId);

describe("ecash whose app ended before its chat line was written", () => {
  it("gets its line when the next start sends the token again", async () => {
    const before = app(true);
    void before.desk.send({ linkId: "l1", amount: 13, timestamp: 1_000, network: "testnet" });
    await vi.waitFor(async () => expect((await all<StoredPayment>(STORES.payments)).map((p) => p.state)).toEqual(["pending"]));
    expect(frames).toHaveLength(0);
    expect(await balance()).toBe(87);
    const [stored] = await all<StoredPayment>(STORES.payments);

    // The next start.
    const after = app();
    await after.desk.start();
    await after.desk.replay("l1");
    expect(frames).toHaveLength(1);
    await contactRedeems(frames[0]!);
    await after.desk.onPaymentResult("l1", { id: stored!.id, ok: true });

    expect((await all<StoredPayment>(STORES.payments))[0]?.state).toBe("settled");
    expect(linesFor(stored!.id)).toEqual([expect.objectContaining({ linkId: "l1", id: "me_1000", sender: "me", timestamp: 1_000, paymentId: stored!.id, text: "⚡ 13 test sats" })]);
    expect(await balance()).toBe(87);
    expect((await all<WalletTx>(STORES.walletTx)).map((t) => t.kind).sort()).toEqual(["ecash-out", "lightning-in"]);
  });

  it("is never written twice: a send whose line was written, sent again, keeps its one line", async () => {
    const { desk } = app();
    const { paymentId } = await desk.send({ linkId: "l1", amount: 13, timestamp: 2_000, network: "testnet" });
    const line = linesFor(paymentId);
    expect(line).toHaveLength(1);
    await desk.replay("l1");
    expect(frames).toHaveLength(2);
    expect(linesFor(paymentId)).toEqual(line);
    expect(history.size).toBe(1);
  });
});
