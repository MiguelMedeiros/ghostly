import { afterEach, describe, expect, it, vi } from "vitest";
import { base64urlnopad } from "@scure/base";
import { createIdentity } from "../src/identity";
import {
  RING_LIFETIME, RING_RELAY, inspectRingStatement, openRing, ringAuthorization, ringChannel, ringClaims, ringEvidence, ringReceive, ringSend, sealRing,
  validRingKey, verifyRingAuthorization, verifyRingEvidence,
} from "../src/pubkyRing";
import { createRingInputRouter } from "../src/ringInput";
import { createRingLink, parseRingLink } from "../src/ringLink";

// covers: core.ring-link, proofs.pubky

const root = createIdentity(), delegate = createIdentity();
const iat = 1_800_000_000, exp = iat + RING_LIFETIME;
const statement = "the statement";
const authorization = ringAuthorization(ringClaims(statement, root.pubKeyZ32, delegate.pubKeyZ32, iat, exp), root.seed);
const secret = new Uint8Array(32).fill(4);
const enc = (s: string) => base64urlnopad.encode(new TextEncoder().encode(s));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Ring authorizations", () => {
  it("verifies the exact authorization and returns its claims", () => {
    expect(verifyRingAuthorization(authorization, statement, root.pubKeyZ32, iat, exp)).toMatchObject({ iss: root.pubKeyZ32, cnf: delegate.pubKeyZ32 });
  });

  it("refuses to sign claims for an issuer that is not the signing key", () => {
    expect(() => ringAuthorization(ringClaims(statement, delegate.pubKeyZ32, delegate.pubKeyZ32, iat, exp), root.seed)).toThrow("Ring identity mismatch");
  });

  it("refuses a non-string, an oversized one, extra or missing parts and a foreign header", () => {
    const [h, p, s] = authorization.split(".");
    expect(() => verifyRingAuthorization(5 as unknown as string, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid Ring authorization");
    expect(() => verifyRingAuthorization("a".repeat(2401), statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid Ring authorization");
    for (const bad of [`${authorization}.x`, `${h}.${p}`, `${h}..${s}`, `${h}.${p}.`, `${enc('{"alg":"none"}')}.${p}.${s}`]) {
      expect(() => verifyRingAuthorization(bad, statement, root.pubKeyZ32, iat, exp)).toThrow("Unsupported Ring authorization");
    }
  });

  it("refuses claims that are not an object with a valid delegate key", () => {
    const [h, , s] = authorization.split(".");
    for (const claims of ["null", "5", JSON.stringify({ cnf: 5 }), JSON.stringify({ cnf: "not-a-key" })]) {
      expect(() => verifyRingAuthorization(`${h}.${enc(claims)}.${s}`, statement, root.pubKeyZ32, iat, exp)).toThrow("Ring did not authorize this exact conversation");
    }
  });

  it("refuses another statement, another lifetime, another issuer, and a re-encoded signature", () => {
    const expected = "Ring did not authorize this exact conversation";
    expect(() => verifyRingAuthorization(authorization, "another", root.pubKeyZ32, iat, exp)).toThrow(expected);
    expect(() => verifyRingAuthorization(authorization, statement, root.pubKeyZ32, iat, exp + 1)).toThrow(expected);
    expect(() => verifyRingAuthorization(authorization, statement, root.pubKeyZ32, iat + 1, exp + 1)).toThrow(expected);
    expect(() => verifyRingAuthorization(authorization, statement, "not-a-key", iat, exp)).toThrow();
    const [h, p, s] = authorization.split(".");
    const flipped = base64urlnopad.decode(s);
    flipped[0] ^= 1;
    expect(() => verifyRingAuthorization(`${h}.${p}.${base64urlnopad.encode(flipped)}`, statement, root.pubKeyZ32, iat, exp)).toThrow(expected);
    expect(() => verifyRingAuthorization(`${h}.${p}.${s.slice(0, -2)}`, statement, root.pubKeyZ32, iat, exp)).toThrow();
  });

  it("refuses evidence whose envelope, id or possession signature does not match", () => {
    const evidence = ringEvidence(authorization, statement, delegate.seed);
    verifyRingEvidence(evidence, statement, root.pubKeyZ32, iat, exp);
    for (const bad of [null, { ...evidence, scheme: "x" }, { ...evidence, signature: 5 }, { ...evidence, signature: evidence.signature.slice(1) }]) {
      expect(() => verifyRingEvidence(bad as typeof evidence, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid Ring proof");
    }
    expect(() => verifyRingEvidence({ ...evidence, id: "0".repeat(64) }, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid delegated proof of possession");
    const byRoot = ringEvidence(authorization, statement, root.seed);
    expect(() => verifyRingEvidence(byRoot, statement, root.pubKeyZ32, iat, exp)).toThrow("Invalid delegated proof of possession");
  });

  it("accepts only canonical, well-formed keys", () => {
    expect(validRingKey(root.pubKeyZ32)).toBe(true);
    expect(validRingKey(root.pubKeyZ32.slice(1))).toBe(false);
    expect(validRingKey("0".repeat(52))).toBe(false);
    // The last character carries four padding bits; a non-zero padding is another spelling of the same key.
    const last = root.pubKeyZ32.at(-1)!;
    const alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
    const alias = root.pubKeyZ32.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expect(validRingKey(alias)).toBe(false);
  });
});

describe("conversation statements", () => {
  const now = iat;
  const subject = createIdentity().pubKeyZ32, audience = createIdentity().pubKeyZ32;
  const make = (patch: Record<number, unknown> = {}) => {
    const p: unknown[] = ["ghostly-peer-proof", 1, "delegated-conversation-proof", "pubky-ring", root.pubKeyZ32, subject, audience, "a".repeat(64), "b".repeat(64), "Z".repeat(43), now, now + RING_LIFETIME];
    for (const [i, v] of Object.entries(patch)) p[Number(i)] = v;
    return JSON.stringify(p);
  };

  it("reads a valid statement", () => {
    expect(inspectRingStatement(make(), root.pubKeyZ32, now)).toEqual({ subject, audience, context: "a".repeat(64), issuedAt: now, expiresAt: now + RING_LIFETIME });
  });

  it.each([
    ["an oversized statement", () => "x".repeat(1601)],
    ["a subject equal to the audience", () => make({ 6: subject })],
    ["another issuer", () => make({ 4: delegate.pubKeyZ32 })],
    ["an uppercase context", () => make({ 7: "A".repeat(64) })],
    ["a short nonce", () => make({ 9: "Z".repeat(42) })],
    ["a wrong lifetime", () => make({ 11: now + RING_LIFETIME + 1 })],
    ["a statement issued too far ahead", () => make({ 10: now + 31, 11: now + 31 + RING_LIFETIME })],
    ["a statement issued too long ago", () => make({ 10: now - 301, 11: now - 301 + RING_LIFETIME })],
    ["a non-canonical encoding", () => make().replace(",", ", ")],
  ])("refuses %s", (_, statementOf) => {
    expect(() => inspectRingStatement(statementOf(), root.pubKeyZ32, now)).toThrow("Invalid conversation request");
  });
});

describe("Ring relay envelopes", () => {
  it("refuses to seal more than 4 KiB and to open envelopes of impossible sizes", () => {
    expect(() => sealRing(secret, "identity", "x".repeat(4095))).toThrow("Ring message too large");
    expect(openRing(secret, "identity", sealRing(secret, "identity", "x".repeat(4094)))).toBe("x".repeat(4094));
    expect(() => openRing(secret, "identity", new Uint8Array(27))).toThrow("Invalid Ring message size");
    expect(() => openRing(secret, "identity", new Uint8Array(4125))).toThrow("Invalid Ring message size");
  });

  it("posts the sealed value to the slot's channel, without credentials or referrer", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await ringSend(secret, "challenge", { hi: 1 }, new AbortController().signal);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RING_RELAY}/${ringChannel(secret, "challenge")}`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(openRing(secret, "challenge", init.body as Uint8Array)).toEqual({ hi: 1 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(ringSend(secret, "challenge", {}, new AbortController().signal)).rejects.toThrow("Ring relay unavailable");
  });

  it("waits through relay timeouts, opens the envelope and deletes it", async () => {
    const body = sealRing(secret, "approval", { ok: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 408 }))
      .mockResolvedValueOnce(new Response(body as BodyInit))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await ringReceive(secret, "approval", new AbortController().signal)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
  });

  it("reads a body without a stream reader, and ignores a failed delete", async () => {
    const body = sealRing(secret, "identity", 7);
    const noStream = { ok: true, status: 200, headers: new Headers(), body: null, arrayBuffer: async () => body.slice().buffer } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(noStream).mockRejectedValueOnce(new Error("offline")));
    expect(await ringReceive(secret, "identity", new AbortController().signal)).toBe(7);
  });

  it("refuses an unavailable relay, a declared or streamed oversized body, and gives up after eight timeouts", async () => {
    const signal = new AbortController().signal;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 502 })));
    await expect(ringReceive(secret, "identity", signal)).rejects.toThrow("Ring relay unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(10) as BodyInit, { headers: { "content-length": "5000" } })));
    await expect(ringReceive(secret, "identity", signal)).rejects.toThrow("Ring response too large");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(5000) as BodyInit)));
    await expect(ringReceive(secret, "identity", signal)).rejects.toThrow("Ring response too large");
    const timeouts = vi.fn(async () => new Response(null, { status: 408 }));
    vi.stubGlobal("fetch", timeouts);
    await expect(ringReceive(secret, "identity", signal)).rejects.toThrow("Ring approval timed out");
    expect(timeouts).toHaveBeenCalledTimes(8);
  });

  it("stops before asking the relay once cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    abort.abort();
    await expect(ringReceive(secret, "identity", abort.signal)).rejects.toThrow("Ring request cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an envelope sealed for another slot or tampered with", async () => {
    const body = sealRing(secret, "identity", 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body as BodyInit)));
    await expect(ringReceive(secret, "approval", new AbortController().signal)).rejects.toThrow();
  });
});

describe("Ring links and their dispatch", () => {
  const now = 1_800_000_000;

  it("refuses to create a link with a bad secret, delegate or expiry", () => {
    expect(() => createRingLink(new Uint8Array(31), delegate.pubKeyZ32, now)).toThrow("Invalid Ring request");
    expect(() => createRingLink(secret, "bad", now)).toThrow("Invalid Ring request");
    expect(() => createRingLink(secret, delegate.pubKeyZ32, 1.5)).toThrow("Invalid Ring request");
  });

  it("refuses an input over 1536 characters before parsing it", () => {
    const link = createRingLink(secret, delegate.pubKeyZ32, now + 100);
    expect(() => parseRingLink(link + "&" + "x".repeat(1536), now)).toThrow("Invalid Ring request. Copy a new connection link from Ghostly.");
  });

  it("refuses a missing value, a non-canonical secret, and an expiry that is not ten digits", () => {
    const link = createRingLink(secret, delegate.pubKeyZ32, now + 100);
    for (const bad of [link.replace("v=1", "v"), link.replace(/secret=[^&]+/, `secret=${base64urlnopad.encode(new Uint8Array(16))}`), link.replace(`expires=${now + 100}`, `expires=0${now + 100}`)]) {
      expect(() => parseRingLink(bad, now)).toThrow("Invalid Ring request");
    }
  });

  it("wipes the secret of an expired request", () => {
    const link = createRingLink(secret, delegate.pubKeyZ32, now);
    expect(() => parseRingLink(link, now)).toThrow("This Ring request expired. Create a new QR code in Ghostly.");
    expect(() => parseRingLink(link, now - 211)).toThrow(/expired/);
    expect(parseRingLink(link, now - 210).expires).toBe(now);
  });

  it("does not claim input that is not a Ring link, and a stale unsubscribe leaves the new listener in place", () => {
    const router = createRingInputRouter();
    expect(router.open("https://example.com")).toBe(false);
    const first = vi.fn(), second = vi.fn();
    const closeFirst = router.subscribe(first);
    router.subscribe(second);
    closeFirst();
    const link = createRingLink(secret, delegate.pubKeyZ32, now + 100);
    expect(router.open(link)).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(link);
  });

  it("keeps only the latest pending link, delivered once", () => {
    vi.useFakeTimers();
    const router = createRingInputRouter();
    const a = createRingLink(secret, delegate.pubKeyZ32, now + 100), b = createRingLink(secret, delegate.pubKeyZ32, now + 101);
    router.open(a); router.open(b);
    const seen = vi.fn();
    const close = router.subscribe(seen);
    expect(seen.mock.calls).toEqual([[b]]);
    close();
    const again = vi.fn();
    router.subscribe(again);
    expect(again).not.toHaveBeenCalled();
  });
});
