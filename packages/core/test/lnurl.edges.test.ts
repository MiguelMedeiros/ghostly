import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import {
  LNURL_LIMITS, fetchLnurlJson, findLightningDestination, invoiceCallbackUrl, parseInvoiceCallback, parseLightningDestination, parsePayParams,
  resolveLightningDestination, type LightningDestination,
} from "../src";
import { testInvoice } from "./invoice";

// covers: wallet.lnurl.protocol

const METADATA = JSON.stringify([["text/plain", "Pay alice"], ["text/identifier", "alice@ln.example.com"]]);
const PARAMS = { tag: "payRequest", callback: "https://ln.example.com/cb", minSendable: 1000, maxSendable: 100_000_000, metadata: METADATA, commentAllowed: 64 };
const ALICE: LightningDestination = { kind: "address", text: "alice@ln.example.com", url: "https://ln.example.com/.well-known/lnurlp/alice", domain: "ln.example.com", name: "alice" };
const LNURL_DEST: LightningDestination = { kind: "lnurl", text: "lnurl1x", url: "https://ln.example.com/p", domain: "ln.example.com" };
const lnurl = (url: string) => bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 4096);
const metadataHash = sha256(new TextEncoder().encode(METADATA));
const respond = (body: string, init: ResponseInit = { status: 200 }) => vi.fn(async () => new Response(body, init)) as unknown as typeof globalThis.fetch;

/** An invoice with only the fields given (no signature check happens on decode), for amounts or hashes a real one would carry. */
function rawInvoice(hrp: string, fields: [tag: number, bytes: Uint8Array][]) {
  const now = Math.floor(Date.now() / 1000);
  const words: number[] = [];
  for (let v = now, i = 0; i < 7; i++, v = Math.floor(v / 32)) words.unshift(v % 32);
  for (const [tag, bytes] of fields) { const data = bech32.toWords(bytes); words.push(tag, data.length >> 5, data.length & 31, ...data); }
  return bech32.encode(hrp, [...words, ...new Array(104).fill(0)], false);
}
const P = 1, H = 23;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("what is pasted", () => {
  it("bounds what is pasted: an lnurl1 string of at most 2048 characters, a URL of at most 2048", () => {
    // 1272 URL bytes are 2036 bech32 words: with "lnurl1" and the checksum, exactly 2048 characters.
    const base = "https://ln.example.com/";
    const at = base + "a".repeat(1272 - base.length);
    expect(lnurl(at)).toHaveLength(LNURL_LIMITS.maxUrlLength);
    expect(parseLightningDestination(lnurl(at))).toMatchObject({ url: at });
    expect(() => parseLightningDestination(lnurl(`${at}a`))).toThrow("That LNURL is not valid");
    const path = "a".repeat(LNURL_LIMITS.maxUrlLength - "https://ln.example.com/".length);
    expect(parseLightningDestination(`lnurlp://ln.example.com/${path}`)).toMatchObject({ kind: "lnurl" });
    expect(() => parseLightningDestination(`lnurlp://ln.example.com/${path}a`)).toThrow("That LNURL is too long");
  });

  it("refuses an LNURL that decodes to no URL at all, or to one with credentials", () => {
    expect(() => parseLightningDestination(lnurl("not a url"))).toThrow("That LNURL does not point to a valid address");
    expect(() => parseLightningDestination(lnurl("https://u:p@ln.example.com/"))).toThrow(/credentials/);
    expect(() => parseLightningDestination(lnurl("ftp://ln.example.com/"))).toThrow(/HTTPS/);
    expect(() => parseLightningDestination(lnurl("http://ln.example.com.onion.evil.com/"))).toThrow(/HTTPS/);
  });

  it("keeps address names and domains to what LUD-16 allows", () => {
    expect(parseLightningDestination(`${"a".repeat(64)}@ln.example.com`)).toMatchObject({ name: "a".repeat(64) });
    for (const text of [`${"a".repeat(65)}@ln.example.com`, "alice@ln..example.com", "al ice@ln.example.com", "alice@ln.example.com/path", "alice@-", "@ln.example.com"])
      expect(parseLightningDestination(text), text).toBeNull();
    expect(parseLightningDestination("alice@[::1]")).toBeNull();
  });

  it("finds nothing when what looks like a destination does not parse", () => {
    expect(findLightningDestination("lightning:hello there")).toBeNull();
    expect(findLightningDestination("see lnurl1invalidchecksum")).toBeNull();
    expect(findLightningDestination("nothing to see")).toBeNull();
  });

  it("never yields a plain-HTTP URL except for a hidden service or this machine, nor credentials", () => {
    const hosts = fc.constantFrom("ln.example.com", "127.0.0.1:8080", "localhost", "abc.onion", "evil.com", "u:p@ln.example.com", "onion", "localhost.evil.com");
    const path = fc.oneof(fc.constantFrom("", "/", "/p?x=1", "#frag", "@evil.com/", ":80/p", "/%2F.."), fc.string({ maxLength: 12 }));
    const text = fc.oneof(
      fc.tuple(fc.constantFrom("http://", "https://", "ftp://", ""), hosts, path).map(([s, h, p]) => lnurl(`${s}${h}${p}`)),
      fc.tuple(hosts, path).map(([h, p]) => `lnurlp://${h}${p}`),
      fc.tuple(fc.stringMatching(/^[a-z0-9._+-]{1,70}$/), hosts).map(([n, h]) => `${n}@${h}`),
      fc.string({ maxLength: 80 }),
    );
    fc.assert(fc.property(text, t => {
      let d: LightningDestination | null;
      try { d = parseLightningDestination(t); } catch (e) { expect(e).toBeInstanceOf(Error); return; }
      if (!d) return;
      const url = new URL(d.url);
      expect(url.username + url.password).toBe("");
      if (url.protocol !== "https:") {
        expect(url.protocol).toBe("http:");
        expect(url.hostname.endsWith(".onion") || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)).toBe(true);
      }
      expect(d.domain).toBe(url.host);
    }), { numRuns: 200 });
  });
});

describe("fetching", () => {
  it("reads a body without a stream, bounded the same way", async () => {
    const plain = (text: string) => vi.fn(async () => ({ ok: true, status: 200, url: "", body: null, text: async () => text }) as unknown as Response) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: plain('{"a":1}') })).resolves.toEqual({ a: 1 });
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: plain(`"${"x".repeat(100)}"`), maxBytes: 100 })).rejects.toThrow("The server's answer is too large");
  });

  it("bounds a streamed body at exactly the limit", async () => {
    const body = `"${"x".repeat(98)}"`;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: respond(body), maxBytes: 100 })).resolves.toBe("x".repeat(98));
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: respond(`${body} `), maxBytes: 100 })).rejects.toThrow("too large");
  });

  it("says so when there is no network to use", async () => {
    vi.stubGlobal("fetch", undefined);
    await expect(fetchLnurlJson("https://ln.example.com/x")).rejects.toThrow("No way to reach the network here");
  });

  it("refuses to fetch plain HTTP or credentials, before any request", async () => {
    const fetch = respond("{}");
    await expect(fetchLnurlJson("http://ln.example.com/x", { fetch })).rejects.toThrow(/HTTPS/);
    await expect(fetchLnurlJson("https://u:p@ln.example.com/x", { fetch })).rejects.toThrow(/credentials/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops when the caller cancels, with the caller's reason or a plain one", async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof globalThis.fetch;
    const withError = new AbortController();
    const first = fetchLnurlJson("https://ln.example.com/x", { fetch: hang, signal: withError.signal });
    withError.abort(new Error("Closed by the person"));
    await expect(first).rejects.toThrow("Closed by the person");
    const withString = new AbortController();
    const second = fetchLnurlJson("https://ln.example.com/x", { fetch: hang, signal: withString.signal });
    withString.abort("gone");
    await expect(second).rejects.toThrow("The request was cancelled");
  });

  it("reports a refusal without a reason, a sanitized reason, and an HTTP error with a JSON body", async () => {
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: respond('{"status":"ERROR"}') })).rejects.toThrow("ln.example.com refused: no reason given");
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: respond(JSON.stringify({ status: "ERROR", reason: `a\n\tb${"c".repeat(300)}` })) }))
      .rejects.toThrow(/^ln.example.com refused: a bc{197}$/);
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: respond('{"ok":false}', { status: 500 }) })).rejects.toThrow("ln.example.com answered HTTP 500");
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: respond("oops", { status: 502 }) })).rejects.toThrow("did not answer with JSON (HTTP 502)");
  });

  it("refuses a redirect that lands on credentials", async () => {
    const redirected = vi.fn(async () => { const r = new Response("{}"); Object.defineProperty(r, "url", { value: "https://u:p@ln.example.com/x" }); return r; }) as unknown as typeof globalThis.fetch;
    await expect(fetchLnurlJson("https://ln.example.com/x", { fetch: redirected })).rejects.toThrow(/credentials/);
  });

  it("refuses to resolve text that is no destination, without fetching", async () => {
    const fetch = respond("{}");
    await expect(resolveLightningDestination("hello", { fetch })).rejects.toThrow("That is not a Lightning address or an LNURL");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the pay request", () => {
  it("names the tag it got only when it is text", () => {
    expect(() => parsePayParams({ ...PARAMS, tag: 7 }, ALICE)).toThrow(/^ln.example.com answered with something other than a pay request$/);
    expect(() => parsePayParams(null, ALICE)).toThrow(/did not answer with a pay request/);
    expect(() => parsePayParams([PARAMS], ALICE)).toThrow(/did not answer with a pay request/);
  });

  it("refuses a missing callback, and limits that are not whole millisats", () => {
    expect(() => parsePayParams({ ...PARAMS, callback: undefined }, ALICE)).toThrow("The pay request has no callback");
    for (const change of [{ minSendable: 1.5 }, { maxSendable: "100000" }, { minSendable: -1000 }, { maxSendable: 2 ** 53 }])
      expect(() => parsePayParams({ ...PARAMS, ...change }, ALICE), JSON.stringify(change)).toThrow("The pay request has invalid amount limits");
  });

  it("refuses metadata that is missing, too long or not a list of typed entries", () => {
    expect(() => parsePayParams({ ...PARAMS, metadata: undefined }, ALICE)).toThrow("no usable metadata");
    const padded = JSON.stringify([["text/plain", "x".repeat(LNURL_LIMITS.maxMetadataLength)]]);
    expect(() => parsePayParams({ ...PARAMS, metadata: padded }, ALICE)).toThrow("no usable metadata");
    for (const metadata of ['{"text/plain":"x"}', '["text/plain"]', "[[1, \"x\"]]", "[[\"text/plain\", \"x\"], \"y\"]"])
      expect(() => parsePayParams({ ...PARAMS, metadata }, ALICE), metadata).toThrow("The pay request's metadata is malformed");
    const exactly = JSON.stringify([["text/plain", "x".repeat(LNURL_LIMITS.maxMetadataLength - 19)]]);
    expect(exactly).toHaveLength(LNURL_LIMITS.maxMetadataLength);
    expect(parsePayParams({ ...PARAMS, metadata: exactly }, ALICE).description).toHaveLength(280);
  });

  it("checks the identifier against an address, case-insensitively, and not against an LNURL", () => {
    const email = JSON.stringify([["text/plain", "x"], ["text/email", "ALICE@ln.example.com"]]);
    expect(parsePayParams({ ...PARAMS, metadata: email }, ALICE).identifier).toBe("alice@ln.example.com");
    const other = JSON.stringify([["text/plain", "x"], ["text/identifier", "bob@ln.example.com"]]);
    expect(parsePayParams({ ...PARAMS, metadata: other }, LNURL_DEST).identifier).toBe("bob@ln.example.com");
  });

  it("caps the comment length a service may ask for", () => {
    expect(parsePayParams({ ...PARAMS, commentAllowed: 1e9 }, ALICE).commentAllowed).toBe(LNURL_LIMITS.maxComment);
    for (const commentAllowed of [-5, 1.5, "10"]) expect(parsePayParams({ ...PARAMS, commentAllowed }, ALICE).commentAllowed).toBe(0);
  });
});

describe("the invoice callback", () => {
  const params = parsePayParams({ ...PARAMS, minSendable: 21_000, maxSendable: 42_000 }, ALICE);

  it("accepts the limits themselves and refuses one sat past them", () => {
    expect(invoiceCallbackUrl(params, 21)).toContain("amount=21000");
    expect(invoiceCallbackUrl(params, 42)).toContain("amount=42000");
    expect(() => invoiceCallbackUrl(params, 20)).toThrow("between 21 and 42 sats");
    expect(() => invoiceCallbackUrl(params, 43)).toThrow("between 21 and 42 sats");
    for (const amount of [21.5, Number.NaN, -21]) expect(() => invoiceCallbackUrl(params, amount)).toThrow("Enter a whole number of sats");
  });

  it("sends a comment of exactly the allowed length, drops a blank one, and encodes it", () => {
    expect(invoiceCallbackUrl(params, 21, "x".repeat(64))).toContain(`comment=${"x".repeat(64)}`);
    expect(invoiceCallbackUrl(params, 21, "   ")).toBe("https://ln.example.com/cb?amount=21000");
    expect(new URL(invoiceCallbackUrl(params, 21, "a&amount=1")).searchParams.getAll("amount")).toEqual(["21000"]);
  });

  it("refuses an invoice that lets the payer choose, or that has no payment hash", () => {
    const anyAmount = rawInvoice("lnbc", [[P, new Uint8Array(32)], [H, metadataHash]]);
    expect(() => parseInvoiceCallback({ pr: anyAmount }, params, 21)).toThrow("The invoice asks for any amount, not the 21 sats you chose");
    const noHash = rawInvoice("lnbc210n", [[H, metadataHash]]);
    expect(() => parseInvoiceCallback({ pr: noHash }, params, 21)).toThrow("The invoice has no payment hash");
    expect(parseInvoiceCallback({ pr: rawInvoice("lnbc210n", [[P, new Uint8Array(32)], [H, metadataHash]]) }, params, 21).invoice.amountSat).toBe(21);
  });

  it("keeps a success message sanitized and bounded, and refuses other success URLs", () => {
    const pr = testInvoice({ sats: 21, descriptionHash: metadataHash });
    const action = (successAction: unknown) => parseInvoiceCallback({ pr, successAction }, params, 21).successAction;
    expect(action({ tag: "message", message: `Thanks\n\n${"!".repeat(300)}` })).toEqual({ tag: "message", message: `Thanks ${"!".repeat(193)}` });
    expect(action({ tag: "message", message: 5 })).toBeUndefined();
    expect(action({ tag: "url", url: "http://ln.example.com/r" })).toBeUndefined();
    expect(action({ tag: "url", url: `https://ln.example.com/${"r".repeat(LNURL_LIMITS.maxUrlLength)}` })).toBeUndefined();
    expect(action({ tag: "url", url: "https://ln.example.com/r", description: 7 })).toEqual({ tag: "url", url: "https://ln.example.com/r", description: "" });
    expect(action(["message"])).toBeUndefined();
  });
});
