import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import {
  decodeBolt11, fetchLnurlJson, findLightningDestination, invoiceCallbackUrl, parseInvoiceCallback, parseLightningDestination, parsePayParams,
  requestLnurlInvoice, resolveLightningDestination, type LightningDestination,
} from "../src";
import { testInvoice } from "./invoice";
// covers: wallet.lnurl.protocol

const METADATA = JSON.stringify([["text/plain", "Pay alice"], ["text/identifier", "alice@ln.example.com"]]);
const PARAMS = { tag: "payRequest", callback: "https://ln.example.com/lnurlp/alice/callback", minSendable: 1000, maxSendable: 100_000_000, metadata: METADATA, commentAllowed: 64 };
const ALICE: LightningDestination = { kind: "address", text: "alice@ln.example.com", url: "https://ln.example.com/.well-known/lnurlp/alice", domain: "ln.example.com", name: "alice" };
const lnurl = (url: string) => bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2048);
const metadataHash = () => sha256(new TextEncoder().encode(METADATA));

/** A fetch that answers from a table, and records what was asked. */
function fakeFetch(answers: Record<string, unknown | ((url: URL) => unknown)>, status = 200) {
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url.href);
    const key = Object.keys(answers).find((k) => url.href.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const answer = answers[key];
    const body = typeof answer === "function" ? (answer as (url: URL) => unknown)(url) : answer;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("what is pasted", () => {
  it("reads a Lightning address, lower-cased, into its well-known URL", () => {
    expect(parseLightningDestination("  Alice@LN.Example.com ")).toEqual(ALICE);
    expect(parseLightningDestination("lightning:alice@ln.example.com")).toEqual(ALICE);
    expect(parseLightningDestination("⚡ alice@ln.example.com")).toEqual(ALICE);
  });
  it("lets a local test server be plain HTTP, and a hidden service too, but nothing else", () => {
    expect(parseLightningDestination("bob@127.0.0.1:45911")).toMatchObject({ kind: "address", url: "http://127.0.0.1:45911/.well-known/lnurlp/bob", domain: "127.0.0.1:45911" });
    expect(parseLightningDestination("bob@localhost")).toMatchObject({ url: "http://localhost/.well-known/lnurlp/bob" });
    expect(parseLightningDestination("bob@abcdefghijklmnop.onion")).toMatchObject({ url: "http://abcdefghijklmnop.onion/.well-known/lnurlp/bob" });
    expect(() => parseLightningDestination("lnurlp://user:pw@ln.example.com/x")).toThrow(/credentials/);
    expect(() => parseLightningDestination(lnurl("http://ln.example.com/pay"))).toThrow(/HTTPS/);
  });
  it("reads an lnurl1 string (LUD-01) and an lnurlp:// one (LUD-17)", () => {
    expect(parseLightningDestination(lnurl("https://ln.example.com/lnurlp/alice").toUpperCase())).toMatchObject({ kind: "lnurl", url: "https://ln.example.com/lnurlp/alice", domain: "ln.example.com" });
    expect(parseLightningDestination("lnurlp://ln.example.com/lnurlp/alice?x=1")).toMatchObject({ kind: "lnurl", url: "https://ln.example.com/lnurlp/alice?x=1" });
    expect(parseLightningDestination("lnurlp://127.0.0.1:45911/lnurlp/alice")).toMatchObject({ url: "http://127.0.0.1:45911/lnurlp/alice" });
    expect(() => parseLightningDestination("lnurl1qqqqqqqq")).toThrow(/not valid/);
  });
  it("is null for text that is neither, without throwing", () => {
    for (const text of ["", "hello", "not an address", "alice@localdomain", "https://ln.example.com", "lnbc1..."]) expect(parseLightningDestination(text)).toBeNull();
  });
  it("finds a destination inside a message and keeps the rest", () => {
    expect(findLightningDestination("tip me: alice@ln.example.com, thanks!")).toEqual({ destination: ALICE, rest: "tip me: , thanks!" });
    expect(findLightningDestination(`pay ${lnurl("https://ln.example.com/p")} now`)).toMatchObject({ destination: { kind: "lnurl" }, rest: "pay  now" });
    expect(findLightningDestination("an email is not money bob@localdomain")).toBeNull();
    expect(findLightningDestination(`bad ${lnurl("http://plain.example.com/p")}`)).toBeNull();
  });
});

describe("the pay request (LUD-06)", () => {
  it("is checked field by field, and the amounts are shown in whole sats", () => {
    const params = parsePayParams(PARAMS, ALICE);
    expect(params).toMatchObject({ callback: PARAMS.callback, callbackDomain: "ln.example.com", minSat: 1, maxSat: 100_000, description: "Pay alice", identifier: "alice@ln.example.com", commentAllowed: 64, metadata: METADATA });
    expect(params.descriptionHash).toBe(Array.from(metadataHash(), (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(parsePayParams({ ...PARAMS, minSendable: 1500, maxSendable: 2900 }, ALICE)).toMatchObject({ minSat: 2, maxSat: 2 });
    expect(parsePayParams({ ...PARAMS, commentAllowed: undefined }, ALICE).commentAllowed).toBe(0);
  });
  it("refuses what is not a pay request, plain callbacks, bad limits, missing text/plain, another address", () => {
    expect(() => parsePayParams({ ...PARAMS, tag: "withdrawRequest" }, ALICE)).toThrow(/other than a pay request \(withdrawRequest\)/);
    expect(() => parsePayParams({ ...PARAMS, callback: "http://ln.example.com/cb" }, ALICE)).toThrow(/HTTPS/);
    expect(() => parsePayParams({ ...PARAMS, minSendable: 0 }, ALICE)).toThrow(/amount limits/);
    expect(() => parsePayParams({ ...PARAMS, minSendable: 5000, maxSendable: 4000 }, ALICE)).toThrow(/amount limits/);
    expect(() => parsePayParams({ ...PARAMS, minSendable: 100, maxSendable: 900 }, ALICE)).toThrow(/fractions of a sat/);
    expect(() => parsePayParams({ ...PARAMS, metadata: JSON.stringify([["image/png;base64", "x"]]) }, ALICE)).toThrow(/text\/plain/);
    expect(() => parsePayParams({ ...PARAMS, metadata: "not json" }, ALICE)).toThrow(/not JSON/);
    expect(() => parsePayParams({ ...PARAMS, metadata: JSON.stringify([["text/plain", "x"], ["text/identifier", "mallory@ln.example.com"]]) }, ALICE)).toThrow(/answered for mallory@ln.example.com/);
    expect(() => parsePayParams("nope", ALICE)).toThrow(/did not answer with a pay request/);
  });
  it("builds the callback within the limits, with a comment only when one is taken", () => {
    const params = parsePayParams(PARAMS, ALICE);
    expect(invoiceCallbackUrl(params, 21)).toBe(`${PARAMS.callback}?amount=21000`);
    expect(invoiceCallbackUrl(params, 21, " hello ")).toBe(`${PARAMS.callback}?amount=21000&comment=hello`);
    expect(() => invoiceCallbackUrl(params, 0)).toThrow(/whole number/);
    expect(() => invoiceCallbackUrl(params, 100_001)).toThrow(/between 1 and 100,000 sats/);
    expect(() => invoiceCallbackUrl(params, 21, "x".repeat(65))).toThrow(/at most 64/);
    expect(() => invoiceCallbackUrl({ ...params, commentAllowed: 0 }, 21, "hi")).toThrow(/does not take a comment/);
    expect(() => invoiceCallbackUrl({ ...params, minSat: 21, maxSat: 21 }, 22)).toThrow(/exactly 21 sats/);
    // A callback that already has a query keeps it.
    expect(invoiceCallbackUrl({ ...params, callback: "https://ln.example.com/cb?k=v" }, 5)).toBe("https://ln.example.com/cb?k=v&amount=5000");
  });
});

describe("the invoice the service answers with", () => {
  const params = parsePayParams(PARAMS, ALICE);
  it("is accepted with the h tag committing to the metadata, or with the metadata as its description", () => {
    const hashed = testInvoice({ sats: 21, descriptionHash: metadataHash() });
    expect(parseInvoiceCallback({ pr: hashed, routes: [] }, params, 21).invoice.paymentHash).toBe(decodeBolt11(hashed)!.paymentHash);
    const plain = testInvoice({ sats: 21, description: METADATA });
    expect(parseInvoiceCallback({ pr: plain }, params, 21).invoice.amountSat).toBe(21);
  });
  it("refuses another amount, no commitment, an expired invoice, and garbage", () => {
    expect(() => parseInvoiceCallback({ pr: testInvoice({ sats: 22, descriptionHash: metadataHash() }) }, params, 21)).toThrow(/asks for 22 sats, not the 21 sats/);
    expect(() => parseInvoiceCallback({ pr: testInvoice({ msat: 21_500n, descriptionHash: metadataHash() }) }, params, 21)).toThrow(/not the 21 sats/);
    expect(() => parseInvoiceCallback({ pr: testInvoice({ sats: 21, description: "Pay alice" }) }, params, 21)).toThrow(/does not commit/);
    expect(() => parseInvoiceCallback({ pr: testInvoice({ sats: 21, descriptionHash: sha256(new TextEncoder().encode("other")) }) }, params, 21)).toThrow(/does not commit/);
    expect(() => parseInvoiceCallback({ pr: testInvoice({ sats: 21, descriptionHash: metadataHash(), createdAt: 1_600_000_000, expirySeconds: 60 }) }, params, 21)).toThrow(/expired/);
    expect(() => parseInvoiceCallback({ pr: "lnbc1notaninvoice" }, params, 21)).toThrow(/does not decode/);
    expect(() => parseInvoiceCallback({ status: "OK" }, params, 21)).toThrow(/did not answer with an invoice/);
  });
  it("keeps a success message, and an https success URL, nothing else", () => {
    const pr = testInvoice({ sats: 21, descriptionHash: metadataHash() });
    expect(parseInvoiceCallback({ pr, successAction: { tag: "message", message: "Thanks!" } }, params, 21).successAction).toEqual({ tag: "message", message: "Thanks!" });
    expect(parseInvoiceCallback({ pr, successAction: { tag: "url", description: "Receipt", url: "https://ln.example.com/r/1" } }, params, 21).successAction).toEqual({ tag: "url", description: "Receipt", url: "https://ln.example.com/r/1" });
    expect(parseInvoiceCallback({ pr, successAction: { tag: "url", url: "javascript:alert(1)" } }, params, 21).successAction).toBeUndefined();
    expect(parseInvoiceCallback({ pr, successAction: { tag: "aes", ciphertext: "x" } }, params, 21).successAction).toBeUndefined();
  });
});

describe("fetching", () => {
  it("resolves an address and asks for the invoice, sending no credentials and reading JSON only", async () => {
    const hash = metadataHash();
    const { fetch, asked } = fakeFetch({
      "https://ln.example.com/.well-known/lnurlp/alice": PARAMS,
      "https://ln.example.com/lnurlp/alice/callback": (url: URL) => ({ pr: testInvoice({ sats: Number(url.searchParams.get("amount")) / 1000, descriptionHash: hash }), successAction: { tag: "message", message: url.searchParams.get("comment") ?? "" } }),
    });
    const params = await resolveLightningDestination("alice@ln.example.com", { fetch });
    const { invoice, successAction } = await requestLnurlInvoice(params, 21, "gm", { fetch });
    expect(invoice.amountSat).toBe(21);
    expect(successAction).toEqual({ tag: "message", message: "gm" });
    expect(asked).toEqual(["https://ln.example.com/.well-known/lnurlp/alice", "https://ln.example.com/lnurlp/alice/callback?amount=21000&comment=gm"]);
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: "application/json" } });
  });
  it("says which domain refused, could not be reached, or did not answer with JSON", async () => {
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: fakeFetch({ "https://ln.example.com/x": { status: "ERROR", reason: "no such user" } }).fetch })).rejects.toThrow(/ln.example.com refused: no such user/);
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: fakeFetch({ "https://ln.example.com/x": "<html>" }).fetch })).rejects.toThrow(/did not answer with JSON/);
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: fakeFetch({}).fetch })).rejects.toThrow(/HTTP 404/);
    const failing = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: failing })).rejects.toThrow(/Could not reach ln.example.com.*CORS/);
  });
  it("bounds the answer in size and time, and refuses a redirect to plain HTTP", async () => {
    const big = vi.fn(async () => new Response(`{"pad":"${"x".repeat(70_000)}"}`, { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: big })).rejects.toThrow(/too large/);
    const slow = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: slow, timeoutMs: 20 })).rejects.toThrow(/took too long/);
    const redirected = vi.fn(async () => { const r = new Response("{}", { status: 200 }); Object.defineProperty(r, "url", { value: "http://evil.example.com/x" }); return r; }) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: redirected })).rejects.toThrow(/HTTPS/);
  });
});
