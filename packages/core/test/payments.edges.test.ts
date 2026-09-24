import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ENDPOINT, cashuRequestPayload, findEndpoint, parseCashuRequestPayload } from "../src/payments";

// covers: payments.cashu.request, payments.targets

describe("the mints a cashu request names", () => {
  it("round-trips a list of mints", () => {
    const mints = ["https://mint.example.com", "http://127.0.0.1:3338"];
    expect(parseCashuRequestPayload(cashuRequestPayload(mints))).toEqual(mints);
  });

  it("yields none for anything malformed, never throwing", () => {
    for (const payload of ["", "not json", "null", "42", '"https://mint.example.com"', "[]", '{"mints":"https://mint.example.com"}', '{"mints":null}', '{"mint":["https://m.example.com"]}'])
      expect(parseCashuRequestPayload(payload), payload).toEqual([]);
  });

  it("keeps only http(s) URLs given as strings, at most eight", () => {
    const payload = JSON.stringify({ mints: ["javascript:alert(1)", 7, null, { url: "https://x.example.com" }, "ftp://m.example.com", " https://space.example.com", "HTTPS://upper.example.com", "https://ok.example.com"] });
    expect(parseCashuRequestPayload(payload)).toEqual(["https://ok.example.com"]);
    const many = Array.from({ length: 12 }, (_, i) => `https://m${i}.example.com`);
    expect(parseCashuRequestPayload(cashuRequestPayload(many))).toEqual(many.slice(0, 8));
  });

  it("never throws and never returns more than eight http(s) strings, whatever a peer sends", () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 60 }), fc.json({ maxDepth: 2 }), fc.array(fc.oneof(fc.constantFrom("https://", "http://", "ftp://").chain(s => fc.string({ maxLength: 20 }).map(r => s + r)), fc.string({ maxLength: 20 }), fc.integer()), { maxLength: 12 }).map(mints => JSON.stringify({ mints }))), payload => {
      const mints = parseCashuRequestPayload(payload);
      expect(mints.length).toBeLessThanOrEqual(8);
      for (const m of mints) expect(m).toMatch(/^https?:\/\//);
    }), { numRuns: 300 });
  });
});

describe("finding an endpoint", () => {
  it("returns the first payload for the identifier, and nothing for an unknown one", () => {
    const endpoints: [string, string][] = [[ENDPOINT.cashu, "first"], [ENDPOINT.bolt11, "lnbc1"], [ENDPOINT.cashu, "second"]];
    expect(findEndpoint(endpoints, ENDPOINT.cashu)).toBe("first");
    expect(findEndpoint(endpoints, ENDPOINT.bolt11)).toBe("lnbc1");
    expect(findEndpoint(endpoints, ENDPOINT.bitcoin)).toBeUndefined();
    expect(findEndpoint([], ENDPOINT.cashu)).toBeUndefined();
  });

  it("matches identifiers exactly, not by prefix or case", () => {
    expect(findEndpoint([["btc-arkade/10", "x"], ["CASHU", "y"]], ENDPOINT.arkade)).toBeUndefined();
    expect(findEndpoint([["CASHU", "y"]], ENDPOINT.cashu)).toBeUndefined();
  });
});
