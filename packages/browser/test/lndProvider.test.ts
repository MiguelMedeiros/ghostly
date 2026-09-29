import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { decodeBolt11 } from "@ghostly/core";
import type { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { LND_BAKE, LndLightning, fetchTransport, isFinalLine, lnd, lndSettings, macaroonScope, parseCertificate, parseMacaroon, parseNodeUrl, tauriTransport, type LndTransport } from "../src/engine/paymentAdapters/providers/lnd";
import { LightningService } from "../src/engine/paymentAdapters/providers/lightningService";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { NothingSpentError, type ProviderHost } from "../src/engine/paymentAdapters/providers/types";
import { LIGHTNING_PROVIDERS, offeredIn } from "../src/engine/paymentAdapters/providers/registry";
import { describeLightningProvider } from "./helpers/providerContract";
import { ADMIN, FakeLndNode, bakeMacaroon } from "./helpers/fakeLnd";
import { container, endpoints } from "../../../e2e/infra/env.mjs";
// covers: wallet.lightning.lnd.connect, wallet.lightning.lnd.pay, wallet.lightning.provider-contract
// covers-gated: wallet.lightning.lnd.connect, wallet.lightning.lnd.pay

const SCOPED = bakeMacaroon(["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write"]);
const full = { receive: true, send: true, balance: true };
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
/** A DER-shaped blob: a SEQUENCE long enough to pass for a certificate. */
const DER = new Uint8Array([0x30, 0x82, 0x01, 0x00, ...new Array(80).fill(7)]);
const PEM = `-----BEGIN CERTIFICATE-----\n${base64.encode(DER).replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;

// The contract every Lightning provider passes, against LND's REST API in memory.
describeLightningProvider("LND (REST, mocked)", async () => {
  const node = new FakeLndNode();
  const provider = new LndLightning(node.transport(), full);
  return {
    provider, network: "regtest",
    payIncoming: async (invoice) => node.settle(invoice.paymentHash),
    payable: async (amount) => fakeInvoice(amount, random32()),
    // More than the node holds: LND fails it with INSUFFICIENT_BALANCE before any HTLC.
    refused: async () => fakeInvoice(10_000_000, random32()),
  };
});

describe("the LND macaroon", () => {
  it("reads the permissions LND baked into it, from hex or base64", () => {
    const parsed = parseMacaroon(SCOPED);
    expect(parsed.hex).toBe(SCOPED);
    expect(parsed.ops).toEqual([{ entity: "info", actions: ["read"] }, { entity: "invoices", actions: ["read", "write"] }, { entity: "offchain", actions: ["read", "write"] }]);
    expect(parseMacaroon(base64.encode(hex.decode(SCOPED))).hex).toBe(SCOPED);
    expect(parseMacaroon(` ${SCOPED.toUpperCase()}\n`).hex).toBe(SCOPED);
  });

  it("refuses what is not an LND macaroon", () => {
    expect(() => parseMacaroon("not a macaroon!")).toThrow("hex or base64");
    expect(() => parseMacaroon("0201")).toThrow("not an LND macaroon");
    expect(() => parseMacaroon(hex.encode(random32()))).toThrow("not an LND macaroon");
  });

  it("says what the provider may do with it, and what it allows beyond that", () => {
    expect(macaroonScope(parseMacaroon(SCOPED).ops)).toEqual({ info: true, receive: true, send: true, balance: true, excess: [] });
    const receiveOnly = macaroonScope(parseMacaroon(bakeMacaroon(["info:read", "invoices:read", "invoices:write"])).ops);
    expect(receiveOnly).toMatchObject({ receive: true, send: false, balance: false, excess: [] });
    expect(macaroonScope(parseMacaroon(bakeMacaroon([...ADMIN])).ops).excess).toEqual(expect.arrayContaining(["onchain:write", "macaroon:generate", "signer:generate", "info:write"]));
    // Read-only extras move no money; method-scoped macaroons are read by method.
    expect(macaroonScope(parseMacaroon(bakeMacaroon(["info:read", "invoices:read", "invoices:write", "onchain:read", "peers:read"])).ops).excess).toEqual([]);
    const byUri = macaroonScope(parseMacaroon(bakeMacaroon(["uri:/lnrpc.Lightning/GetInfo", "uri:/routerrpc.Router/SendPaymentV2", "uri:/routerrpc.Router/TrackPaymentV2"])).ops);
    expect(byUri).toMatchObject({ info: true, send: true, receive: false, balance: false, excess: [] });
    expect(macaroonScope(parseMacaroon(bakeMacaroon(["info:read", "uri:/lnrpc.Lightning/SendCoins"])).ops).excess).toEqual(["/lnrpc.Lightning/SendCoins"]);
  });
});

describe("the LND form", () => {
  const settings = (url: string, macaroon = SCOPED, certificate?: string) => ({ config: { url }, secrets: { macaroon, ...(certificate ? { certificate } : {}) } });

  it("wants https, or plain http only for a node on this machine, and nothing but the address", () => {
    expect(parseNodeUrl("https://mynode.local:8080/")).toBe("https://mynode.local:8080");
    expect(parseNodeUrl("mynode.local:8080")).toBe("https://mynode.local:8080");
    expect(parseNodeUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parseNodeUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(() => parseNodeUrl("http://mynode.local:8080")).toThrow("https://");
    expect(() => parseNodeUrl("https://user:pw@mynode.local:8080")).toThrow("credentials");
    expect(() => parseNodeUrl("https://mynode.local:8080/v1/getinfo")).toThrow("only the node's address");
  });

  it("takes the certificate as PEM (even with its line breaks lost), base64 or hex", () => {
    const b64 = base64.encode(DER);
    expect(parseCertificate(PEM)).toBe(b64);
    expect(parseCertificate(PEM.replace(/\n/g, ""))).toBe(b64);
    expect(parseCertificate(b64)).toBe(b64);
    expect(parseCertificate(hex.encode(DER))).toBe(b64);
    expect(() => parseCertificate("hello")).toThrow();
    expect(() => parseCertificate(base64.encode(new Uint8Array(100)))).toThrow("not a TLS certificate");
  });

  it("refuses the admin macaroon, and one that allows nothing Ghostly does, before contacting anything", () => {
    expect(() => lndSettings(settings("https://n:8080", bakeMacaroon(ADMIN)))).toThrow(`can do more than Ghostly needs`);
    expect(() => lndSettings(settings("https://n:8080", bakeMacaroon(ADMIN)))).toThrow(LND_BAKE);
    expect(() => lndSettings(settings("https://n:8080", bakeMacaroon(["info:read", "offchain:read"])))).toThrow("does not allow what Ghostly needs");
    expect(() => lndSettings(settings("https://n:8080", bakeMacaroon(["invoices:read", "invoices:write"])))).toThrow("does not allow");
    expect(lndSettings(settings("https://n:8080", SCOPED, PEM))).toMatchObject({ url: "https://n:8080", certificate: base64.encode(DER), scope: { receive: true, send: true } });
    expect(() => lnd.validate!(settings("https://n:8080", bakeMacaroon(ADMIN)), "testnet")).toThrow();
  });

  it("is registered, on every platform, on both networks, with its credentials as secrets", () => {
    expect(LIGHTNING_PROVIDERS.map((d) => d.id)).toContain("lnd");
    for (const platform of ["web", "extension", "desktop"] as const) for (const mode of ["mainnet", "testnet"] as const) expect(offeredIn(lnd, platform, mode)).toBe(true);
    expect(lnd.fields.filter((f) => f.kind === "secret").map((f) => f.name)).toEqual(["macaroon", "certificate"]);
  });
});

describe("the LND provider", () => {
  it("maps LND's chains to networks and refuses what is not Bitcoin", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), full);
    for (const [network, expected] of [["mainnet", "bitcoin"], ["testnet", "testnet"], ["testnet4", "testnet"], ["signet", "signet"], ["regtest", "regtest"]]) {
      node.network = network;
      expect((await provider.info()).network).toBe(expected);
    }
    node.network = "simnet";
    await expect(provider.info()).rejects.toThrow("simnet");
    node.network = "mainnet"; node.chain = "litecoin";
    await expect(provider.info()).rejects.toThrow("litecoin");
  });

  it("reads no balance with a macaroon that cannot, and says it can only receive", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), { receive: true, send: false, balance: false });
    expect(provider.capabilities).toEqual({ receive: true, send: false, balance: false, lookup: true });
    expect((await provider.info()).balance).toBeUndefined();
    expect(node.requests.map((r) => r.path)).toEqual(["/v1/getinfo"]);
  });

  it("asks LND for exactly the invoice it was asked for, and pays within the fee limit", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), full);
    const invoice = await provider.createInvoice(42, "for the pizza");
    expect(node.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/invoices", body: { value: "42", memo: "for the pizza", expiry: "3600" } });
    expect(decodeBolt11(invoice.invoice)).toMatchObject({ amountSat: 42, paymentHash: invoice.paymentHash });
    const target = fakeInvoice(100, random32());
    await provider.payInvoice(target, 7);
    expect(node.requests.at(-1)).toMatchObject({ method: "POST", path: "/v2/router/send", stream: "final", body: { payment_request: target, fee_limit_sat: "7", allow_self_payment: false } });
  });

  it("sees an unpaid invoice of the past as expired, and a canceled one too", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), full);
    const invoice = await provider.createInvoice(5);
    node.invoices.get(invoice.paymentHash)!.created -= 7200;
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "expired" });
    const other = await provider.createInvoice(5);
    node.invoices.get(other.paymentHash)!.state = "CANCELED";
    expect(await provider.invoiceStatus(other)).toEqual({ state: "expired" });
  });

  it("FAILED is nothing spent; a payment still in flight at the deadline is pending, and is asked about later", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), full);
    node.pays = "fail";
    await expect(provider.payInvoice(fakeInvoice(10, random32()), 5)).rejects.toThrow(new NothingSpentError("No route to the recipient within the fee limit"));
    node.pays = "hang";
    const hash = random32(), invoice = fakeInvoice(10, hash);
    expect(await provider.payInvoice(invoice, 5)).toEqual({ state: "pending" });
    expect(await provider.paymentStatus({ invoice, paymentHash: hex.encode(hash) })).toEqual({ state: "pending" });
    node.payments.set(hex.encode(hash), { status: "SUCCEEDED", fee_sat: "2", payment_preimage: "ab".repeat(32) });
    expect(await provider.paymentStatus({ invoice, paymentHash: hex.encode(hash) })).toEqual({ state: "paid", fee: 2, preimage: "ab".repeat(32) });
    // A payment LND never started is not going anywhere.
    expect(await provider.paymentStatus({ invoice, paymentHash: hex.encode(random32()) })).toEqual({ state: "failed" });
  });

  it("an error the node answered is checked by payment hash: nothing spent only when LND never started it", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), full);
    node.pays = "error";
    await expect(provider.payInvoice(fakeInvoice(10, random32()), 5)).rejects.toBeInstanceOf(NothingSpentError);
    node.sendError = { message: "invoice is already paid", registers: "SUCCEEDED" };
    expect(await provider.payInvoice(fakeInvoice(10, random32()), 5)).toMatchObject({ state: "paid" });
    node.sendError = { message: "payment is in transition", registers: "IN_FLIGHT" };
    expect(await provider.payInvoice(fakeInvoice(10, random32()), 5)).toEqual({ state: "pending" });
  });

  it("no answer at all is an unknown outcome, never NothingSpentError", async () => {
    const node = new FakeLndNode(), provider = new LndLightning(node.transport(), full);
    node.pays = "lost";
    const error = await provider.payInvoice(fakeInvoice(10, random32()), 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NothingSpentError);
    // A lookup that cannot be answered is not "failed" either.
    const silent: LndTransport = { request: async () => { throw new Error("offline"); }, close() {} };
    await expect(new LndLightning(silent, full).paymentStatus({ invoice: "", paymentHash: "ab".repeat(32) })).rejects.toThrow("offline");
    // A proxy's "not found" in front of the node is not LND saying it never started the payment.
    const proxy: LndTransport = { request: async ({ path }) => ({ status: path.startsWith("/v2/router/track") ? 404 : 502, lines: [{ error: { message: "404 page not found" } }], timedOut: false }), close() {} };
    expect(await new LndLightning(proxy, full).payInvoice(fakeInvoice(10, random32()), 5).catch((e: unknown) => e)).not.toBeInstanceOf(NothingSpentError);
    const deadline: LndTransport = { request: async () => ({ status: 200, lines: [], timedOut: true }), close() {} };
    const unknown = await new LndLightning(deadline, full).payInvoice(fakeInvoice(10, random32()), 5).catch((e: unknown) => e);
    expect(unknown).not.toBeInstanceOf(NothingSpentError);
  });

  it("goes through the Lightning journal: a lost answer is reconciled by hash and never paid twice", async () => {
    const node = new FakeLndNode();
    const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() };
    const cashu = { view: async () => ({ balance: 0, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
    const descriptor = { ...lnd, create: async () => new LndLightning(node.transport(), full) };
    const service = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu }), events, CASHU_MINT_SOURCE);
    await service.start();
    await service.sources.set("lnd", { url: "https://127.0.0.1:1", macaroon: SCOPED });
    await vi.waitFor(() => expect(service.view).toMatchObject({ providerId: "lnd", status: "ready", network: "regtest", balance: 100_000 }));

    node.pays = "lost";
    const hash = random32(), invoice = fakeInvoice(50, hash);
    expect(await service.pay((await service.quote(invoice)).quote)).toBe(false);
    expect((await service.list()).find((op) => op.direction === "out")).toMatchObject({ state: "unknown" });
    await expect(service.quote(invoice).then((q) => service.pay(q.quote))).rejects.toThrow("already being paid");
    node.payments.set(hex.encode(hash), { status: "SUCCEEDED", fee_sat: "1" });
    await service.reconcile();
    expect((await service.list()).find((op) => op.direction === "out")).toMatchObject({ state: "paid", fee: 1 });
    expect(events.resolved).toHaveBeenCalledWith(expect.objectContaining({ providerId: "lnd" }), true);
    await service.stop();
  });
});

describe("reaching LND", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const stream = (chunks: string[], hang = false) => new ReadableStream<Uint8Array>({
    async start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); if (!hang) controller.close(); },
  });

  it("fetch: sends the macaroon header, reads a unary answer, and a stream up to its final update", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(stream(['{"alias":', '"a"}'])));
    vi.stubGlobal("fetch", fetch);
    const transport = fetchTransport("https://n:8080", "0201ab");
    expect(await transport.request({ method: "GET", path: "/v1/getinfo", timeoutMs: 1000 })).toEqual({ status: 200, lines: [{ alias: "a" }], timedOut: false });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://n:8080/v1/getinfo");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", headers: { "Grpc-Metadata-macaroon": "0201ab" } });

    fetch.mockImplementationOnce(async () => new Response(stream(['{"result":{"status":"IN_FLIGHT"}}\n{"result":{"sta', 'tus":"SUCCEEDED"}}\n'], true)));
    const paid = await transport.request({ method: "POST", path: "/v2/router/send", body: { a: 1 }, stream: "final", timeoutMs: 5000 });
    expect(paid).toEqual({ status: 200, lines: [{ result: { status: "IN_FLIGHT" } }, { result: { status: "SUCCEEDED" } }], timedOut: false });
    expect(fetch.mock.calls[1][1]).toMatchObject({ body: '{"a":1}', headers: { "Content-Type": "application/json" } });
  });

  it("fetch: at the deadline a stream reports what it saw; before any answer it is an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"result":{"status":"IN_FLIGHT"}}\n')); init.signal!.addEventListener("abort", () => c.error(init.signal!.reason)); } });
      return new Response(body);
    }));
    const transport = fetchTransport("https://n:8080", "ab");
    expect(await transport.request({ method: "POST", path: "/v2/router/send", stream: "final", timeoutMs: 50 })).toEqual({ status: 200, lines: [{ result: { status: "IN_FLIGHT" } }], timedOut: true });
    await expect(transport.request({ method: "GET", path: "/v1/getinfo", timeoutMs: 50 })).rejects.toThrow();

    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))));
    await expect(transport.request({ method: "POST", path: "/v2/router/send", stream: "final", timeoutMs: 50 })).rejects.toThrow("did not answer in time");
  });

  it("fetch: a blocked request says what the node must allow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    vi.stubGlobal("location", { origin: "https://app.ghostly.tools" });
    await expect(fetchTransport("https://n:8080", "ab").request({ method: "GET", path: "/v1/getinfo", timeoutMs: 1000 })).rejects.toThrow("restcors=https://app.ghostly.tools");
  });

  it("desktop: the Tauri command gets the request and the pinned certificate; the web gets fetch", async () => {
    const invoke = vi.fn(async () => ({ status: 200, lines: ['{"alias":"desk"}'], timed_out: false }));
    const transport = tauriTransport(invoke as unknown as NonNullable<ProviderHost["invoke"]>, "https://n:8080", "ab", "Y2VydA==");
    expect(await transport.request({ method: "POST", path: "/v2/router/send", body: { x: 1 }, stream: "final", timeoutMs: 30_000 })).toEqual({ status: 200, lines: [{ alias: "desk" }], timedOut: false });
    expect(invoke).toHaveBeenCalledWith("lnd_request", { url: "https://n:8080", macaroon: "ab", certificate: "Y2VydA==", method: "POST", path: "/v2/router/send", body: '{"x":1}', stream: "final", timeoutMs: 30_000 });
    transport.close();
    await expect(transport.request({ method: "GET", path: "/v1/getinfo", timeoutMs: 1 })).rejects.toThrow("closed");

    const host = (platform: ProviderHost["platform"]) => ({ platform, mode: "testnet" as const, cashu: {} as CashuWallet, signal: new AbortController().signal, invoke: invoke as unknown as ProviderHost["invoke"] });
    const settings = { config: { url: "https://n:8080" }, secrets: { macaroon: SCOPED, certificate: PEM } };
    invoke.mockClear();
    await (await lnd.create(settings, host("desktop"))).info().catch(() => {});
    expect(invoke).toHaveBeenCalledWith("lnd_request", expect.objectContaining({ path: "/v1/getinfo", certificate: base64.encode(DER), macaroon: SCOPED }));
    const fetch = vi.fn(async () => new Response('{"chains":[{"chain":"bitcoin","network":"regtest"}]}'));
    vi.stubGlobal("fetch", fetch);
    invoke.mockClear();
    await (await lnd.create(settings, host("web"))).info().catch(() => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
  });

  it("knows when a payment stream is over", () => {
    expect(isFinalLine({ result: { status: "IN_FLIGHT" } })).toBe(false);
    expect(isFinalLine({ result: { status: "SUCCEEDED" } }) && isFinalLine({ result: { status: "FAILED" } }) && isFinalLine({ error: {} })).toBe(true);
  });
});

// -- a real node ---------------------------------------------------------------------------------------

/**
 * GHOSTLY_LND_REGTEST=1, with e2e/infra up (npm run e2e:infra:up): the provider on Alice's
 * node, Bob's node on the other end of their channel. Node's https (the certificate as the trusted CA) stands
 * in for the browser's fetch, which a test process cannot make trust LND's certificate. Nothing is printed.
 */
const REGTEST = process.env.GHOSTLY_LND_REGTEST === "1";
const docker = (node: string, ...args: string[]) => execFileSync("docker", ["exec", container(`lnd-${node}`), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lncli = (node: string, ...args: string[]) => JSON.parse(docker(node, "lncli", "--network=regtest", ...args));

function httpsTransport(url: string, macaroon: string, ca: string): LndTransport {
  return {
    request: ({ method, path, body, stream, timeoutMs }) => new Promise((resolve, reject) => {
      const lines: unknown[] = [];
      let buffer = "", settled = false;
      const done = (timedOut: boolean, status: number) => { if (!settled) { settled = true; req.destroy(); resolve({ status, lines, timedOut }); } };
      const req = httpsRequest(url + path, { method, ca, headers: { "Grpc-Metadata-macaroon": macaroon, "Content-Type": "application/json" } }, (res) => {
        const status = res.statusCode ?? 0;
        const timer = setTimeout(() => (stream ? done(true, status) : reject(new Error("timeout"))), timeoutMs);
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          if (!stream) return;
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const text = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (!text) continue;
            lines.push(JSON.parse(text));
            if (stream === "first" || isFinalLine(lines[lines.length - 1])) { clearTimeout(timer); return done(false, status); }
          }
        });
        res.on("end", () => { clearTimeout(timer); if (buffer.trim()) lines.push(JSON.parse(buffer)); done(false, status); });
      });
      req.on("error", (error) => { if (!settled) reject(error); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    }),
    close() {},
  };
}

describe.runIf(REGTEST)("LND on regtest (GHOSTLY_LND_REGTEST=1)", { timeout: 60_000 }, () => {
  const alice = () => {
    const macaroon = docker("alice", "cat", "/root/.lnd/ghostly-scoped.macaroon.hex");
    const scope = macaroonScope(parseMacaroon(macaroon).ops);
    return new LndLightning(httpsTransport(endpoints.lnd.alice, macaroon, docker("alice", "cat", "/root/.lnd/tls.cert")), scope);
  };

  it("the macaroon the stack baked is read as scoped, and the admin one is refused", () => {
    expect(macaroonScope(parseMacaroon(docker("alice", "cat", "/root/.lnd/ghostly-scoped.macaroon.hex")).ops)).toEqual({ info: true, receive: true, send: true, balance: true, excess: [] });
    const admin = docker("alice", "xxd", "-p", "-c", "100000", "/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon");
    expect(macaroonScope(parseMacaroon(admin).ops).excess).toEqual(expect.arrayContaining(["onchain:write", "macaroon:generate"]));
  });

  describeLightningProvider("LND (regtest)", async () => ({
    provider: alice(), network: "regtest",
    payIncoming: async (invoice) => { lncli("bob", "payinvoice", "--force", "--json", invoice.invoice); },
    payable: async (amount) => lncli("bob", "addinvoice", "--amt", String(amount), "--memo", "contract").payment_request,
    // More than the whole channel: LND finds no route before sending any HTLC.
    refused: async () => lncli("bob", "addinvoice", "--amt", "5000000").payment_request,
  }), { timeout: 30_000 });

  it("balances move by what was paid, and a hash is reconciled after the fact", async () => {
    const provider = alice();
    const before = (await provider.info()).balance!;
    const invoice = lncli("bob", "addinvoice", "--amt", "1234").payment_request as string;
    const paid = await provider.payInvoice(invoice, 10);
    expect(paid.state).toBe("paid");
    const fee = paid.state === "paid" ? paid.fee ?? 0 : 0;
    // Right after SUCCEEDED the channel may still carry the HTLC's share of the commitment fee: wait for it to settle.
    await vi.waitFor(async () => expect((await provider.info()).balance).toBe(before - 1234 - fee), { timeout: 10_000, interval: 250 });
    expect(await provider.paymentStatus({ invoice, paymentHash: decodeBolt11(invoice)!.paymentHash! })).toMatchObject({ state: "paid" });
    // Paying it again is not a second payment: LND knows the hash, and says it is paid.
    expect(await provider.payInvoice(invoice, 10)).toMatchObject({ state: "paid" });
    expect((await provider.info()).balance).toBe(before - 1234 - fee);
  }, 60_000);
});
