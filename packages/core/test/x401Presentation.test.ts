import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { concatBytes, fromBase64Url, toBase64Url, utf8Encode } from "../src/bytes";
import { newX401HolderKey, readX401SdJwtVc, type X401SdJwtVc } from "../src/x401Credential";
import { matchX401Dcql, presentX401SdJwtVc, readX401DcqlQuery, x401VpToken, type X401DcqlQuery } from "../src/x401Presentation";
import { disclosure, issueSdJwtVc } from "./support/sdJwtIssuer";

const holderKey = newX401HolderKey();
const holder = holderKey.jwk;
const LICENCE = "https://issuer.example/licence";

function vcOf(text: string): X401SdJwtVc {
  const r = readX401SdJwtVc(text);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const licence = vcOf(issueSdJwtVc({ holder }));
const other = vcOf(issueSdJwtVc({ holder, payload: { vct: "https://issuer.example/membership" } }));
const expired = vcOf(issueSdJwtVc({ holder, payload: { exp: 1_700_000_000 } }));
const notYet = vcOf(issueSdJwtVc({ holder, payload: { nbf: 1_900_000_000 } }));

function query(value: unknown): X401DcqlQuery {
  const r = readX401DcqlQuery(value);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const sdJwt = (id: string, claims?: unknown[], extra: Record<string, unknown> = {}) =>
  ({ id, format: "dc+sd-jwt", meta: { vct_values: [LICENCE] }, ...(claims ? { claims } : {}), ...extra });
const reason = (value: unknown) => { const r = readX401DcqlQuery(value); return r.ok ? "read" : r.reason; };

describe("reading a DCQL query", () => {
  it("reads credential queries, claim sets and credential sets, keeping unknown members", () => {
    const q = query({
      credentials: [sdJwt("pid", [{ id: "a", path: ["given_name"] }, { id: "b", path: ["nationalities", null], values: ["XX"] }], { claim_sets: [["a", "b"], ["a"]], future: 1 })],
      credential_sets: [{ options: [["pid"]] }],
    });
    expect(q.credentials[0].claim_sets).toEqual([["a", "b"], ["a"]]);
  });

  it("refuses a query it cannot answer as written", () => {
    expect(reason(null)).toMatch(/credentials/);
    expect(reason({ credentials: [] })).toMatch(/credentials/);
    expect(reason({ credentials: [sdJwt("a b")] })).toMatch(/id/);
    expect(reason({ credentials: [sdJwt("x"), sdJwt("x")] })).toMatch(/twice/);
    expect(reason({ credentials: [{ id: "x" }] })).toMatch(/format/);
    expect(reason({ credentials: [sdJwt("x", [{ path: [] }])] })).toMatch(/path/);
    expect(reason({ credentials: [sdJwt("x", [{ path: ["a", -1] }])] })).toMatch(/path/);
    expect(reason({ credentials: [sdJwt("x", [{ path: ["a"], values: [{}] }])] })).toMatch(/values/);
    expect(reason({ credentials: [sdJwt("x", [{ id: "a", path: ["a"] }, { id: "a", path: ["b"] }])] })).toMatch(/twice/);
    expect(reason({ credentials: [sdJwt("x", [{ id: "a", path: ["a"] }], { claim_sets: [["b"]] })] })).toMatch(/claim_sets/);
    expect(reason({ credentials: [sdJwt("x", undefined, { claim_sets: [["a"]] })] })).toMatch(/claim_sets/);
    expect(reason({ credentials: [sdJwt("x")], credential_sets: [{ options: [["y"]] }] })).toMatch(/credential_sets/);
    expect(reason({ credentials: [sdJwt("x")], credential_sets: [{ options: [] }] })).toMatch(/credential_sets/);
  });
});

describe("matching a DCQL query against kept credentials", () => {
  const held = [{ id: "c-other", vc: other }, { id: "c-old", vc: expired }, { id: "c-licence", vc: licence }];

  it("takes the credential of the asked type, with the concrete paths of the claims asked", () => {
    const r = matchX401Dcql(query({ credentials: [sdJwt("pid", [{ path: ["given_name"] }, { path: ["address", "street"] }])] }), held);
    expect(r).toEqual({ ok: true, matches: [{ query: "pid", credential: "c-licence", claims: [["given_name"], ["address", "street"]] }] });
  });

  it("skips an expired credential and one of another type or format, and says what was asked", () => {
    const asked = { credentials: [sdJwt("pid", [{ path: ["given_name"] }])] };
    const r = matchX401Dcql(query(asked), [{ id: "c-other", vc: other }, { id: "c-old", vc: expired }], 1_800_000_000_000);
    expect(r).toEqual({ ok: false, asked: [{ query: "pid", format: "dc+sd-jwt", types: [LICENCE], claims: [["given_name"]] }] });
    expect(matchX401Dcql(query({ credentials: [{ ...sdJwt("pid"), format: "mso_mdoc" }] }), held).ok).toBe(false);
  });

  it("skips a credential before its nbf, and takes it from that second on", () => {
    const asked = query({ credentials: [sdJwt("pid", [{ path: ["given_name"] }])] });
    expect(matchX401Dcql(asked, [{ id: "c-soon", vc: notYet }], 1_899_999_999_000).ok).toBe(false);
    expect(matchX401Dcql(asked, [{ id: "c-soon", vc: notYet }, { id: "c-licence", vc: licence }], 1_899_999_999_000))
      .toEqual({ ok: true, matches: [{ query: "pid", credential: "c-licence", claims: [["given_name"]] }] });
    expect(matchX401Dcql(asked, [{ id: "c-soon", vc: notYet }], 1_900_000_000_000))
      .toEqual({ ok: true, matches: [{ query: "pid", credential: "c-soon", claims: [["given_name"]] }] });
  });

  it("asks a claim's value to be one of `values`, and `null` for every element of an array", () => {
    const one = (claim: unknown) => matchX401Dcql(query({ credentials: [sdJwt("pid", [claim])] }), held);
    expect(one({ path: ["licence_number"], values: ["TEST-0001"] }).ok).toBe(true);
    expect(one({ path: ["licence_number"], values: ["OTHER"] }).ok).toBe(false);
    expect(one({ path: ["nationalities", null] })).toMatchObject({ ok: true, matches: [{ claims: [["nationalities", 0], ["nationalities", 1]] }] });
    expect(one({ path: ["nationalities", null], values: ["YY"] })).toMatchObject({ ok: true, matches: [{ claims: [["nationalities", 1]] }] });
    expect(one({ path: ["nationalities", 5] }).ok).toBe(false);
    expect(one({ path: ["missing"] }).ok).toBe(false);
    expect(one({ path: ["family_name", "deeper"] }).ok).toBe(false);
  });

  it("asks no claim when the query names none", () => {
    expect(matchX401Dcql(query({ credentials: [sdJwt("pid")] }), held)).toMatchObject({ ok: true, matches: [{ claims: [] }] });
  });

  it("takes the first claim set it can answer, in the verifier's order", () => {
    const q = query({ credentials: [sdJwt("pid", [{ id: "n", path: ["missing"] }, { id: "g", path: ["given_name"] }, { id: "f", path: ["family_name"] }], { claim_sets: [["n", "g"], ["g"], ["f"]] })] });
    expect(matchX401Dcql(q, held)).toMatchObject({ ok: true, matches: [{ claims: [["given_name"]] }] });
  });

  it("answers each required credential set with its first option it can, and leaves optional sets out", () => {
    const q = query({
      credentials: [sdJwt("a", [{ path: ["missing"] }]), sdJwt("b", [{ path: ["given_name"] }]), sdJwt("c", [{ path: ["family_name"] }])],
      credential_sets: [{ options: [["a"], ["b"]] }, { options: [["c"]], required: false }],
    });
    expect(matchX401Dcql(q, held)).toEqual({ ok: true, matches: [{ query: "b", credential: "c-licence", claims: [["given_name"]] }] });
    const none = query({ credentials: [sdJwt("a", [{ path: ["missing"] }])], credential_sets: [{ options: [["a"]] }] });
    expect(matchX401Dcql(none, held).ok).toBe(false);
  });

  it("needs every credential query when there is no credential set", () => {
    const q = query({ credentials: [sdJwt("a", [{ path: ["given_name"] }]), sdJwt("b", [{ path: ["missing"] }])] });
    expect(matchX401Dcql(q, held)).toMatchObject({ ok: false, asked: [{ query: "a" }, { query: "b" }] });
  });
});

describe("presenting an SD-JWT VC", () => {
  const binding = { holderSecret: holderKey.secret, aud: "x509_san_dns:verifier.example", nonce: "n-123", iat: 1_760_000_100 };
  const parts = (presentation: string) => {
    const all = presentation.split("~");
    return { jwt: all[0], disclosures: all.slice(1, -1), kb: all[all.length - 1], prefix: presentation.slice(0, presentation.lastIndexOf("~") + 1) };
  };
  const shown = (presentation: string) => vcOf(parts(presentation).prefix).claims;

  it("gives only the disclosures for the claims approved", () => {
    const p = presentX401SdJwtVc(licence, [["given_name"]], binding);
    expect(parts(p).jwt).toBe(licence.jwt);
    expect(shown(p)).toEqual({ family_name: "Test", address: { country: "XX" }, nationalities: ["YY"], given_name: "Alice" });
  });

  it("gives a nested claim's disclosure only when it is asked, or its parent is", () => {
    expect(shown(presentX401SdJwtVc(licence, [["address", "country"]], binding)).address).toEqual({ country: "XX" });
    expect(shown(presentX401SdJwtVc(licence, [["address"]], binding)).address).toEqual({ country: "XX", street: "1 Test Road" });
    expect(shown(presentX401SdJwtVc(licence, [["nationalities", 1]], binding)).nationalities).toEqual(["YY"]);
  });

  it("gives a disclosed parent with the child asked inside it", () => {
    const phone = disclosure("phone", "+00 0000");
    const contact = disclosure("contact", { _sd: [phone.digest], kind: "work" });
    const vc = vcOf(issueSdJwtVc({ holder, sd: [contact.digest], extra: [contact.text, phone.text] }));
    const p = presentX401SdJwtVc(vc, [["contact", "phone"]], binding);
    expect(parts(p).disclosures.sort()).toEqual([contact.text, phone.text].sort());
    expect(shown(p).contact).toEqual({ kind: "work", phone: "+00 0000" });
  });

  it("ends with a Key Binding JWT the holder key signed, for this verifier, nonce and presentation", () => {
    const p = presentX401SdJwtVc(licence, [["given_name"], ["licence_number"]], binding);
    const { kb, prefix } = parts(p);
    const [head, body, signature] = kb.split(".");
    const json = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    expect(json(head)).toEqual({ alg: "ES256", typ: "kb+jwt" });
    expect(json(body)).toEqual({ iat: 1_760_000_100, aud: binding.aud, nonce: "n-123", sd_hash: toBase64Url(sha256(utf8Encode(prefix))) });
    const publicKey = concatBytes(new Uint8Array([4]), fromBase64Url(holder.x), fromBase64Url(holder.y));
    expect(p256.verify(fromBase64Url(signature), utf8Encode(`${head}.${body}`), publicKey)).toBe(true);
  });

  it("presents the JWT alone when no claim is asked", () => {
    const p = presentX401SdJwtVc(licence, [], binding);
    expect(parts(p).disclosures).toEqual([]);
    expect(parts(p).prefix).toBe(`${licence.jwt}~`);
  });

  it("puts each presentation in the vp_token under its credential query id", () => {
    expect(x401VpToken([{ query: "pid", presentation: "p1" }, { query: "other", presentation: "p2" }])).toEqual({ pid: ["p1"], other: ["p2"] });
  });

  it("the vp_token takes a query id that names a member of every object (valid DCQL) as any other", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(readX401DcqlQuery({ credentials: [{ id, format: "dc+sd-jwt" }] }).ok).toBe(true);
      const token = x401VpToken([{ query: id, presentation: "p1" }, { query: id, presentation: "p2" }]);
      expect(Object.keys(token)).toEqual([id]);
      expect(Object.getPrototypeOf(token)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(token))).toEqual(JSON.parse(`{${JSON.stringify(id)}:["p1","p2"]}`));
    }
  });
});
