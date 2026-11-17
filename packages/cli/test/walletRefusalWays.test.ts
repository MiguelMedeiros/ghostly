import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBlindSignature, createNewMintKeys, deriveKeysetId, getEncodedToken, hashToCurve, pointFromHex } from "@cashu/cashu-ts";
import type { SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { TEST_MINT } from "@ghostly/browser/shared/mints";
import { callApi, type ApiContext } from "../src/api";
import { asCliError } from "../src/errors";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.wallets, headless.payments

/**
 * `pay` and `wallet redeem` refusals as a bot reads them: a real engine set up as the CLI daemon runs it, its Testnet
 * Cashu wallet at a fake test mint (real blind signatures, NUT-04/05/07) behind a `fetch` stub. No real mint is asked.
 */
const json = { "content-type": "application/json" };
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: json });
const refuse = (code: number, detail: string) => new Response(JSON.stringify({ code, detail }), { status: 400, headers: json });
interface Output { id: string; amount: number; B_: string }
interface Coin { id: string; amount: number; secret: string; C: string }

function fakeMint() {
  const { pubKeys: keys, privKeys } = createNewMintKeys(7, new Uint8Array(32).fill(9));
  const pubKeys = Object.fromEntries(Object.entries(keys).map(([a, k]) => [a, Buffer.from(k as Uint8Array).toString("hex")]));
  const id = deriveKeysetId(pubKeys, { input_fee_ppk: 0, unit: "sat", versionByte: 1 });
  const spent = new Set<string>();
  const pending = new Set<string>();
  const quotes = new Map<string, { amount: number; state: string }>();
  const melts = new Map<string, { request: string; amount: number; fee_reserve: number; state: string; expiry: number }>();
  /** `melt`: what the mint does with a melt. `down`: paths whose fetch fails, as a mint that is not there. */
  const cfg = { melt: "pay" as "pay" | "pending" | "fail", down: [] as string[] };
  const Y = (secret: string) => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const sum = (items: { amount: number | string }[]) => items.reduce((s, i) => s + Number(i.amount), 0);
  const sign = (outputs: Output[]) => outputs.map((o) => ({ id: o.id, amount: Number(o.amount), C_: createBlindSignature(pointFromHex(o.B_), privKeys[String(o.amount)] as Uint8Array, o.id).C_.toHex(true) }));
  const meltAnswer = (q: string) => { const m = melts.get(q)!; return answer({ quote: q, request: m.request, amount: m.amount, fee_reserve: m.fee_reserve, unit: "sat", state: m.state, expiry: m.expiry, change: [] }); };
  const respond = (path: string, body: Record<string, unknown>): Response => {
    if (path === "/v1/info") {
      const bolt11 = { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false };
      return answer({ name: "Fake", version: "cdk-mintd/0.17.7", nuts: { 4: bolt11, 5: bolt11, 7: { supported: true }, 8: { supported: true }, 9: { supported: true } } });
    }
    if (path === "/v1/keysets") return answer({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${id}`) return answer({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0, keys: pubKeys }] });
    if (path.startsWith("/v1/mint/quote/bolt11/")) {
      const q = path.slice("/v1/mint/quote/bolt11/".length);
      const quote = quotes.get(q)!;
      return answer({ quote: q, request: fakeInvoice(quote.amount, new Uint8Array(32).fill(1)), amount: quote.amount, unit: "sat", state: quote.state, expiry: Math.floor(Date.now() / 1000) + 600 });
    }
    if (path === "/v1/mint/quote/bolt11") {
      // A test mint pays its own invoices.
      const q = `mint${quotes.size + 1}`;
      quotes.set(q, { amount: Number(body.amount), state: "PAID" });
      return respond(`/v1/mint/quote/bolt11/${q}`, {});
    }
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(String(body.quote))!;
      if (quote.state !== "PAID") return refuse(20002, "Quote not paid");
      quote.state = "ISSUED";
      return answer({ signatures: sign(body.outputs as Output[]) });
    }
    if (path === "/v1/melt/quote/bolt11") {
      const request = String(body.request);
      const q = `mq${melts.size + 1}`;
      melts.set(q, { request, amount: Number(/^lnbcrt(\d+)n/.exec(request)![1]) / 10, fee_reserve: 2, state: "UNPAID", expiry: Math.floor(Date.now() / 1000) + 600 });
      return meltAnswer(q);
    }
    if (path.startsWith("/v1/melt/quote/bolt11/")) return meltAnswer(path.slice("/v1/melt/quote/bolt11/".length));
    if (path === "/v1/melt/bolt11") {
      const m = melts.get(String(body.quote))!;
      const inputs = body.inputs as Coin[];
      if (m.state !== "UNPAID") return refuse(20005, "Quote is pending");
      if (inputs.some((p) => spent.has(Y(p.secret)) || pending.has(Y(p.secret)))) return refuse(11001, "Token already spent");
      if (sum(inputs) < m.amount + m.fee_reserve) return refuse(11005, "Not enough inputs");
      if (cfg.melt === "fail") return refuse(20000, "Lightning payment failed");
      for (const p of inputs) (cfg.melt === "pending" ? pending : spent).add(Y(p.secret));
      m.state = cfg.melt === "pending" ? "PENDING" : "PAID";
      return meltAnswer(String(body.quote));
    }
    if (path === "/v1/swap") {
      const inputs = body.inputs as Coin[];
      if (inputs.some((p) => spent.has(Y(p.secret)) || pending.has(Y(p.secret)))) return refuse(11001, "Token already spent");
      if (sum(inputs) !== sum(body.outputs as Output[])) return refuse(11002, "Transaction is not balanced");
      for (const p of inputs) spent.add(Y(p.secret));
      return answer({ signatures: sign(body.outputs as Output[]) });
    }
    if (path === "/v1/checkstate") return answer({ states: (body.Ys as string[]).map((y) => ({ Y: y, state: spent.has(y) ? "SPENT" : pending.has(y) ? "PENDING" : "UNSPENT", witness: null })) });
    if (path === "/v1/restore") return answer({ outputs: [], signatures: [] });
    return new Response("not found", { status: 404 });
  };
  /** Another wallet's ecash of these keys, naming `mint` as its mint. */
  const token = (amount: number, mint: string) => {
    const proofs: Coin[] = [];
    for (let bit = 64; bit >= 1; bit /= 2) if (amount & bit) {
      const secret = crypto.randomUUID().replace(/-/g, "");
      const k = BigInt("0x" + Buffer.from(privKeys[String(bit)] as Uint8Array).toString("hex"));
      proofs.push({ id, amount: bit, secret, C: hashToCurve(new TextEncoder().encode(secret)).multiply(k).toHex(true) });
    }
    return getEncodedToken({ mint, proofs, unit: "sat" } as unknown as Parameters<typeof getEncodedToken>[0]);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(TEST_MINT).origin) return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
    if (cfg.down.some((p) => url.pathname.startsWith(p))) throw new TypeError("Failed to fetch");
    return respond(url.pathname, init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {});
  }));
  return { cfg, token };
}

const invoice = (sats: number, fill: number) => fakeInvoice(sats, new Uint8Array(32).fill(fill), "", 3600);
const fakeDht = () => ({ get: async (): Promise<SignedPacket | null> => null, put: async () => 8, destroy: async () => {} }) as unknown as Mainline;

let node: GhostlyNode;
let ctx: ApiContext;
let mint: ReturnType<typeof fakeMint>;
/** What the CLI prints for a refused call: `{code, message, details?}`. */
const refusal = (method: string, params: Record<string, unknown>) => callApi(ctx, method, params).then(
  (out) => { throw new Error(`${method} answered ${JSON.stringify(out)}`); },
  (error: unknown) => asCliError(error).toJSON());

describe("pay and wallet redeem refusals, at a fake test mint", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    mint = fakeMint();
    vi.stubGlobal("RTCPeerConnection", undefined);
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const transport = new RelaysAndDht(fakeDht(), { relays: ["https://relay-one.test"], fetch: globalThis.fetch, log: () => {} }, true);
    node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, { transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true });
    await node.start();
    ctx = { runtime: { server: { node }, paths: { name: "refusals" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0 }, mode: "daemon", version: "t" } as unknown as ApiContext;
    await callApi(ctx, "wallet.create", { type: "cashu" });
    expect(await callApi(ctx, "wallet.faucet", { type: "cashu" })).toMatchObject({ amount: 10_000 });
  });
  afterAll(async () => { await node?.shutdown(); vi.unstubAllGlobals(); });

  // Found in a bug hunt: the refusal named the token mint's host only, and no command: a person at a terminal had to
  // rebuild the URL (its path too) to add it.
  it("ecash from a mint not added names the whole mint URL in the command that adds it", async () => {
    // `refused`: sending the same token again changes nothing. Before, `engine`, which a bot reads as the engine failing.
    expect(await refusal("wallet.redeem", { token: mint.token(4, "https://other-mint.example/cashu") })).toEqual({
      code: "refused",
      message: "Ecash from other-mint.example is not accepted: its mint is not one of yours (if you trust it to hold your sats: ghostly wallet add-mint https://other-mint.example/cashu)",
      details: { reason: "mint_not_added", mint: "https://other-mint.example/cashu" },
    });
    // A URL a shell would read as more than a word is offered quoted; one no quoting survives is not printed.
    expect((await refusal("wallet.redeem", { token: mint.token(4, "https://odd-mint.example/$(id)") })).message)
      .toBe("Ecash from odd-mint.example is not accepted: its mint is not one of yours (if you trust it to hold your sats: ghostly wallet add-mint 'https://odd-mint.example/$(id)')");
    expect((await refusal("wallet.redeem", { token: mint.token(4, "https://odd-mint.example/it's") })).message)
      .toBe("Ecash from odd-mint.example is not accepted: its mint is not one of yours (if you trust it to hold your sats: ghostly wallet add-mint <the token's mint URL>)");
    // Not printed in the words, the URL is still in `details` for a bot.
    expect((await refusal("wallet.redeem", { token: mint.token(4, "https://odd-mint.example/it's") })).details).toEqual({ reason: "mint_not_added", mint: "https://odd-mint.example/it's" });
    // Nothing was taken: the balance is the faucet's.
    expect(node.getState().wallet.networks?.testnet.balance).toBe(10_000);
  });

  it("a token of one of the mints is still taken", async () => {
    expect(await callApi(ctx, "wallet.redeem", { token: mint.token(8, TEST_MINT) })).toEqual({ amount: 8, fee: 0 });
  });

  // Found in a bug hunt: the Cashu card threw the mint's refusal again with its words only, so `pay` said `engine`
  // where the same refusal is `refused` everywhere else.
  it("pay whose melt the mint refuses is refused: nothing left the wallet, and sending it again changes nothing", async () => {
    const before = node.getState().wallet.networks?.testnet.balance;
    mint.cfg.melt = "fail";
    try {
      expect(await refusal("pay", { target: invoice(10, 6) })).toEqual({ code: "refused", message: "The mint refused this Lightning payment, and no sats left your wallet: it is safe to try again. The mint said: Lightning payment failed" });
    } finally { mint.cfg.melt = "pay"; }
    expect(node.getState().wallet.networks?.testnet.balance).toBe(before);
  });

  // Found in a bug hunt: the same mint outage was `unavailable` for `wallet receive` and `engine` for `pay` and the faucet.
  it("a mint that does not answer pay's quote or the faucet is unavailable, as wallet receive's", async () => {
    mint.cfg.down = ["/v1/melt/quote"];
    try {
      expect(await refusal("pay", { target: invoice(10, 7) })).toEqual({ code: "unavailable", message: "testnut.cashu.space could not take this payment right now, and no sats left your wallet: try again later. The mint said: Failed to fetch at https://testnut.cashu.space" });
    } finally { mint.cfg.down = []; }
    mint.cfg.down = ["/v1/mint/quote"];
    try {
      expect(await refusal("wallet.faucet", { type: "cashu" })).toEqual({ code: "unavailable", message: "testnut.cashu.space could not give test coins right now: try again later. The mint said: Failed to fetch at https://testnut.cashu.space" });
      expect((await refusal("wallet.receive", { amount: 10 })).code).toBe("unavailable");
    } finally { mint.cfg.down = []; }
  });

  // Last: it leaves a melt pending at the mint.
  it("paying an invoice again while its first payment is pending is refused, never paid twice", async () => {
    mint.cfg.melt = "pending";
    const target = invoice(10, 10);
    try {
      expect(await callApi(ctx, "pay", { target })).toMatchObject({ amount: 10, paid: false });
      expect(await refusal("pay", { target })).toEqual({ code: "refused", message: "This invoice is already being paid" });
    } finally { mint.cfg.melt = "pay"; }
  });

});
