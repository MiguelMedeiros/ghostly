import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, deriveKeysetId, pointFromHex } from "@cashu/cashu-ts";
import { type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { TEST_MINT } from "@ghostly/browser/shared/mints";
import { callApi, type ApiContext } from "../src/api";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";

// covers: headless.wallets
//
// A `pay` the mint leaves pending (or whose answer is lost) answered `{paid: false}` and nothing else: no word of what
// it means, of the sats set aside for it, or of where to look. A real engine as the CLI daemon runs it, with a fake
// Testnet Cashu mint (real BDHKE keys, NUT-04/05) behind a `fetch` stub: no real mint is asked.

const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });
interface Output { id: string; amount: number; B_: string }
interface Melt { request: string; amount: number; fee_reserve: number; state: string; expiry: number }

function fakeMint() {
  const { pubKeys: keys, privKeys } = createNewMintKeys(7, new Uint8Array(32).fill(9));
  const pubKeys = Object.fromEntries(Object.entries(keys).map(([a, k]) => [a, Buffer.from(k as Uint8Array).toString("hex")]));
  const id = deriveKeysetId(pubKeys, { input_fee_ppk: 0, unit: "sat", versionByte: 1 });
  const quotes = new Map<string, { amount: number; state: string }>();
  const melts = new Map<string, Melt>();
  /** `pay`: paid at once; `pending`: the mint holds it; `lost`: the melt request gets no answer. */
  const cfg = { melt: "pay" as "pay" | "pending" | "lost" };
  const sign = (outputs: Output[]) => outputs.map((o) => ({ id: o.id, amount: Number(o.amount), C_: createBlindSignature(pointFromHex(o.B_), privKeys[String(o.amount)] as Uint8Array, o.id).C_.toHex(true) }));
  const meltAnswer = (q: string) => {
    const m = melts.get(q)!;
    return answer({ quote: q, request: m.request, amount: m.amount, fee_reserve: m.fee_reserve, unit: "sat", state: m.state, expiry: m.expiry, change: [] });
  };
  const respond = (path: string, body: Record<string, unknown>): Response => {
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.17.7", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${id}`) return answer({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0, keys: pubKeys }] });
    if (path === "/v1/mint/quote/bolt11") {
      // A test mint pays its own invoices.
      const q = `mint${quotes.size + 1}`;
      quotes.set(q, { amount: Number(body.amount), state: "PAID" });
      return respond(`/v1/mint/quote/bolt11/${q}`, {});
    }
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const q = path.slice("/v1/mint/quote/bolt11/".length), quote = quotes.get(q)!;
      return answer({ quote: q, request: fakeInvoice(quote.amount, new Uint8Array(32).fill(1)), amount: quote.amount, unit: "sat", state: quote.state, expiry: Math.floor(Date.now() / 1000) + 600 });
    }
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(String(body.quote))!;
      if (quote.state !== "PAID") return refuse(20002, "Quote not paid");
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs as Output[]) });
    }
    if (path === "/v1/melt/quote/bolt11") {
      const request = String(body.request), q = `mq${melts.size + 1}`;
      melts.set(q, { request, amount: Number(request.match(/^lnbcrt(\d+)n/)![1]) / 10, fee_reserve: 2, state: "UNPAID", expiry: Math.floor(Date.now() / 1000) + 600 });
      return meltAnswer(q);
    }
    if (path.startsWith("/v1/melt/quote/bolt11/")) return meltAnswer(path.slice("/v1/melt/quote/bolt11/".length));
    if (path === "/v1/melt/bolt11") {
      const m = melts.get(String(body.quote))!;
      if (m.state !== "UNPAID") return refuse(20005, "Quote is pending");
      if (cfg.melt === "lost") { m.state = "PENDING"; throw new TypeError("Failed to fetch"); }
      m.state = cfg.melt === "pending" ? "PENDING" : "PAID";
      return meltAnswer(String(body.quote));
    }
    if (path === "/v1/swap") return answer({ signatures: sign(body.outputs as Output[]) });
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((Y) => ({ Y, state: "UNSPENT", witness: null })) });
    if (path === "/v1/restore") return answer({ outputs: [], signatures: [] });
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(TEST_MINT).origin) return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
    return respond(url.pathname, init?.body ? JSON.parse(String(init.body)) : {});
  }));
  return { cfg, melts };
}

const fakeDht = () => ({ get: async (): Promise<SignedPacket | null> => null, put: async () => 8, destroy: async () => {} }) as unknown as Mainline;
const invoice = (sats: number, fill: number) => fakeInvoice(sats, new Uint8Array(32).fill(fill));

let node: GhostlyNode;
let ctx: ApiContext;
let mint: ReturnType<typeof fakeMint>;

describe("pay that the mint has not settled", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    mint = fakeMint();
    vi.stubGlobal("RTCPeerConnection", undefined);
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const transport = new RelaysAndDht(fakeDht(), { relays: ["https://relay-one.test"], fetch: globalThis.fetch, log: () => {} }, true);
    node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, { transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true });
    await node.start();
    ctx = { runtime: { server: { node }, paths: { name: "pay-pending" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0 }, mode: "daemon", version: "t" } as unknown as ApiContext;
    await callApi(ctx, "wallet.create", { type: "cashu" });
    await callApi(ctx, "wallet.faucet", { type: "cashu" });
  });
  afterAll(async () => { await node?.shutdown(); vi.unstubAllGlobals(); });

  it("a paid one says nothing more", async () => {
    mint.cfg.melt = "pay";
    const paid = await callApi(ctx, "pay", { target: invoice(10, 2) }) as Record<string, unknown>;
    expect(paid).toMatchObject({ amount: 10, paid: true });
    expect(paid.note).toBeUndefined();
  });

  it("one the mint holds pending says so: the sats set aside, that it settles by itself, and where to look", async () => {
    mint.cfg.melt = "pending";
    const pending = await callApi(ctx, "pay", { target: invoice(10, 3) }) as Record<string, unknown>;
    expect(pending).toMatchObject({ network: "testnet", amount: 10, feeReserve: 2, paid: false });
    expect(pending.note).toMatch(/^Not paid yet: the mint has not settled this payment\b/);
    expect(pending.note).toContain("12 test sats are set aside for it");
    expect(pending.note).toContain("never pays it twice");
    expect(pending.note).toContain("ghostly wallet history");
  });

  it("one whose answer was lost says the same", async () => {
    mint.cfg.melt = "lost";
    const lost = await callApi(ctx, "pay", { target: invoice(20, 4) }) as Record<string, unknown>;
    expect(lost).toMatchObject({ amount: 20, paid: false });
    expect(lost.note).toMatch(/^Not paid yet: the mint has not settled this payment \(it is pending, or its answer was lost\)/);
    expect(lost.note).toContain("22 test sats are set aside for it");
  });
});
