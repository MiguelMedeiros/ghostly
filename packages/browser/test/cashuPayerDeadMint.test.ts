import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PaymentReview } from "@ghostly/core";
import { deriveKeysetId } from "@cashu/cashu-ts";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
// covers: payments.chat.reconcile

/**
 * A chat's Cashu payment approved while its mint could not be reached: no token, the review stays unknown, and only the
 * mint can say whether the swap ever happened. The payment poll reconciled each one every 10 s, and every round loaded
 * the mint again (a failed load was forgotten at once): 18 mint requests a minute per payment, for as long as the mint
 * stayed gone. Now such a payment backs off as one whose token went out (10 s while its swap may still land, then
 * twice as late up to 10 min), and a failed load of a mint is shared by every caller of the same round. Real wallet,
 * a mint stub that refuses every connection, test sats only.
 */
const MINUTE = 60_000, ROUND = 10_000;
const KEYS = { 1: `02${"ab".repeat(32)}`, 2: `03${"cd".repeat(32)}` };
const KEYSET = deriveKeysetId(KEYS);

const nodes: GhostlyNode[] = [];
let requests = 0;
afterEach(async () => { vi.useRealTimers(); for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  requests = 0;
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});

async function setup(payments: number, withToken = false) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  // The mint is gone: every request to it fails to connect.
  vi.stubGlobal("fetch", vi.fn(async () => { requests += 1; throw new TypeError("Failed to fetch"); }));
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { automaticWallets: false });
  nodes.push(node);
  const wallet = node["wallet"];
  vi.spyOn(wallet, "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  const host = node["desk"]["host"];
  vi.spyOn(host, "getLink").mockReturnValue(undefined);
  vi.spyOn(host, "storeMessage").mockResolvedValue();
  const ids: string[] = [];
  for (let i = 0; i < payments; i++) ids.push(await pay(node, withToken ? `cashuBtoken${i}` : undefined));
  return { node, wallet, ids };
}

/** A chat payment at the dead mint, approved now: its review is unknown, with the token that went out if any. */
async function pay(node: GhostlyNode, token?: string): Promise<string> {
  const now = Date.now(), id = crypto.randomUUID();
  const review = { id, linkId: "chat", payee: "peer", amount: 10, fee: 0, feeCap: 2, state: "unknown", createdAt: now, submittedAt: now, expiresAt: now + MINUTE,
    method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "request", asset: "BTC", unit: "sat" } as PaymentReview;
  await intentRepository.put({ review, prepared: { mint: TEST_MINT, swap: {}, attemptEndedAt: now, ...(token ? { token } : {}) } });
  node["noteOpenReviews"]([review]);
  return id;
}

/** The poll's rounds, one every 10 s for `minutes`: the mint requests of each minute. */
async function rounds(node: GhostlyNode, minutes: number): Promise<number[]> {
  const perMinute: number[] = [];
  for (let m = 0; m < minutes; m++) {
    const before = requests;
    for (let r = 0; r < MINUTE / ROUND; r++) { await node["pollPaymentStatus"](); vi.setSystemTime(Date.now() + ROUND); }
    perMinute.push(requests - before);
  }
  return perMinute;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

it("one payment with no token at a dead mint backs off to a few requests an hour", async () => {
  const { node } = await setup(1);
  const perMinute = await rounds(node, 30);
  // Its swap may still land for the first minutes: asked at 10 s, never more than one mint load a round.
  expect(perMinute[0]).toBeGreaterThan(0);
  expect(perMinute[0]).toBeLessThanOrEqual(18);
  // Then twice as late each time: the last 10 min hold a load or two, not 180 requests.
  expect(sum(perMinute.slice(20))).toBeLessThanOrEqual(6);
  expect(sum(perMinute)).toBeLessThan(200);
}, 60_000);

it("fifty payments with no token at the same dead mint cost one load a round, then back off", async () => {
  const { node } = await setup(50);
  const perMinute = await rounds(node, 30);
  // One failed load of the mint serves the whole round: not 50 loads, 900 requests a minute.
  expect(perMinute[0]).toBeLessThanOrEqual(18);
  expect(sum(perMinute.slice(20))).toBeLessThanOrEqual(6);
  expect(sum(perMinute)).toBeLessThan(200);
}, 60_000);

it("payments with no token approved at different times still ask the dead mint at its own backoff", async () => {
  const { node } = await setup(0);
  // One approved each minute for 30 min while the mint stays gone: their own backoffs are out of step, and most rounds
  // had one due, each loading the mint again (a hundred such payments: about 400 requests an hour, every minute).
  for (let r = 0; r < 30 * MINUTE / ROUND; r++) {
    if (r % 6 === 0) await pay(node);
    await node["pollPaymentStatus"]();
    vi.setSystemTime(Date.now() + ROUND);
  }
  const perMinute = await rounds(node, 30);
  // The mint has a pace of its own, at its 10 min cap by now: a load or so every 10 min, whatever is due.
  expect(sum(perMinute)).toBeLessThanOrEqual(12);
  expect(perMinute.filter((n) => n > 0).length).toBeLessThanOrEqual(4);
}, 60_000);

it("payments approved at different times go on within their own 10 min once the dead mint answers", async () => {
  const { node, wallet } = await setup(0);
  const ids: string[] = [];
  for (let r = 0; r < 30 * MINUTE / ROUND; r++) {
    if (r % 6 === 0) ids.push(await pay(node));
    await node["pollPaymentStatus"]();
    vi.setSystemTime(Date.now() + ROUND);
  }
  // The mint is back (its info and keys answer), and reads the ecash sent as spent: the contact took it.
  const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/info") return answer({ name: "Test", version: "cdk-mintd/0.17.7", nuts: { 4: { methods: [], disabled: false }, 5: { methods: [], disabled: false } } });
    if (path === "/v1/keysets") return answer({ keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${KEYSET}`) return answer({ keysets: [{ id: KEYSET, unit: "sat", keys: KEYS }] });
    return new Response("not found", { status: 404 });
  }));
  vi.spyOn(wallet, "reviewedCashuSpent").mockImplementation(async (prepared) => { await wallet["wallet"](prepared.mint, true); return true; });
  await rounds(node, 10);
  for (const id of ids) expect((await intentRepository.get(id))?.review.state).toBe("settled");
}, 60_000);

it("fifty payments whose token went out still back off at the same dead mint", async () => {
  const { node } = await setup(50, true);
  const perMinute = await rounds(node, 30);
  expect(perMinute[0]).toBeLessThanOrEqual(18);
  expect(sum(perMinute.slice(10))).toBeLessThanOrEqual(12);
}, 60_000);

it("a mint answering again is still heard within the cap, and the payment settles", async () => {
  const { node, wallet, ids } = await setup(3);
  await rounds(node, 30);
  // The mint is back, and reads the ecash sent as spent: the contact took it.
  vi.spyOn(wallet, "reviewedCashuSpent").mockResolvedValue(true);
  await rounds(node, 11);
  for (const id of ids) expect((await intentRepository.get(id))?.review.state).toBe("settled");
}, 60_000);
