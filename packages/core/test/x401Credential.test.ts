import { p256 } from "@noble/curves/nist.js";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url, utf8Encode } from "../src/bytes";
import { newX401HolderKey, readX401SdJwtVc, sameX401HolderJwk, X401_CREDENTIAL_LIMITS } from "../src/x401Credential";
import { disclosure, issueSdJwtVc } from "./support/sdJwtIssuer";

const { jwk: holder } = newX401HolderKey();
const read = (text: string) => readX401SdJwtVc(text);
const reason = (text: string) => { const r = read(text); return r.ok ? "read" : r.reason; };

describe("x401 holder keys", () => {
  it("are P-256, and the JWK is the secret's public key", () => {
    const { secret, jwk } = newX401HolderKey();
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    const point = p256.getPublicKey(secret, false);
    expect(fromBase64Url(jwk.x)).toEqual(point.slice(1, 33));
    expect(fromBase64Url(jwk.y)).toEqual(point.slice(33));
    expect(sameX401HolderJwk(jwk, newX401HolderKey().jwk)).toBe(false);
  });
});

describe("reading an issued SD-JWT VC", () => {
  it("puts every disclosure in its place, keeps decoys hidden and the JWT's own members out", () => {
    const r = read(issueSdJwtVc({ holder }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.value).toMatchObject({ format: "dc+sd-jwt", type: "https://issuer.example/licence", issuer: "https://issuer.example", issuedAt: 1_760_000_000, expiresAt: 4_102_444_800 });
    expect(sameX401HolderJwk(r.value.holder, holder)).toBe(true);
    expect(r.value.claims).toEqual({ family_name: "Test", given_name: "Alice", licence_number: "TEST-0001", address: { country: "XX", street: "1 Test Road" }, nationalities: ["XX", "YY"] });
    expect(r.value.disclosable).toEqual([["address", "street"], ["nationalities", 0], ["given_name"], ["licence_number"]]);
    expect(r.value.disclosures).toHaveLength(4);
    expect(r.value.disclosedBy).toHaveLength(4);
    expect(new Set(r.value.disclosedBy)).toEqual(new Set(r.value.disclosures));
  });

  it("takes the older typ vc+sd-jwt", () => {
    expect(reason(issueSdJwtVc({ holder, header: { typ: "vc+sd-jwt" } }))).toBe("read");
  });

  it("refuses a presentation (a key binding JWT after the last ~)", () => {
    expect(reason(`${issueSdJwtVc({ holder })}eyJhbGciOiJFUzI1NiJ9.e30.c2ln`)).toMatch(/presentation/);
  });

  it("refuses what is not an SD-JWT VC", () => {
    expect(reason("hello")).toMatch(/no ~/);
    expect(reason("a.b~")).toMatch(/not a signed JWT/);
    expect(reason(issueSdJwtVc({ holder, header: { typ: "JWT" } }))).toMatch(/typ/);
    expect(reason(issueSdJwtVc({ holder, header: { alg: "none" } }))).toMatch(/algorithm/);
    expect(reason(issueSdJwtVc({ holder, payload: { _sd_alg: "sha-512" } }))).toMatch(/sha-256 only/);
    expect(reason(issueSdJwtVc({ holder, payload: { iss: undefined } }))).toMatch(/no iss/);
    expect(reason(issueSdJwtVc({ holder, payload: { vct: "" } }))).toMatch(/no vct/);
    expect(reason(issueSdJwtVc({ holder, payload: { exp: "soon" } }))).toMatch(/exp is not a time/);
    expect(reason("x".repeat(X401_CREDENTIAL_LIMITS.chars + 1))).toMatch(/over 64 KiB/);
  });

  it("refuses a cnf that is no P-256 key, or not a point of the curve", () => {
    expect(reason(issueSdJwtVc({ holder, payload: { cnf: { kid: "x" } } }))).toMatch(/cnf/);
    expect(reason(issueSdJwtVc({ holder: { ...holder, crv: "P-384" as "P-256" } }))).toMatch(/cnf/);
    expect(reason(issueSdJwtVc({ holder: { ...holder, y: toBase64Url(new Uint8Array(32).fill(1)) } }))).toMatch(/cnf/);
  });

  it("refuses a disclosure no digest names, one given twice, or one not shaped as SD-JWT says", () => {
    expect(reason(issueSdJwtVc({ holder, extra: [disclosure("extra", "x").text] }))).toMatch(/named by no digest/);
    const twice = issueSdJwtVc({ holder }).split("~");
    expect(reason([...twice.slice(0, 2), twice[1], ...twice.slice(2)].join("~"))).toMatch(/given twice/);
    expect(reason(issueSdJwtVc({ holder, extra: [toBase64Url(utf8Encode(JSON.stringify({ a: 1 })))] }))).toMatch(/\[salt, name, value\]/);
    expect(reason(issueSdJwtVc({ holder, extra: ["not*base64"] }))).toMatch(/not base64url/);
    const sd = disclosure("_sd", "x");
    expect(reason(issueSdJwtVc({ holder, payload: { _sd: [sd.digest] }, extra: [sd.text] }))).toMatch(/names _sd/);
  });

  // `out[key] = value` made a member named __proto__ the claims' prototype: the person never saw it (the list, the
  // approval), and every presentation carried it to the verifier, in the issuer's JWT.
  it("keeps a claim named __proto__ as a claim, plain or disclosed, where the person and a query see it", () => {
    const hidden = JSON.parse('{"__proto__": {"nationality": "XX"}}') as Record<string, unknown>;
    const inner = disclosure("__proto__", { over_18: true });
    const r = read(issueSdJwtVc({ holder, payload: { ...hidden, extras: { kind: "test", _sd: [inner.digest] } }, extra: [inner.text] }));
    if (!r.ok) throw new Error(r.reason);
    expect(Object.keys(r.value.claims)).toContain("__proto__");
    expect(Object.getOwnPropertyDescriptor(r.value.claims, "__proto__")?.value).toEqual({ nationality: "XX" });
    expect(Object.getPrototypeOf(r.value.claims)).toBe(Object.prototype);
    const extras = r.value.claims.extras as Record<string, unknown>;
    expect(Object.keys(extras)).toEqual(["kind", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(extras, "__proto__")?.value).toEqual({ over_18: true });
    expect(r.value.disclosable).toContainEqual(["extras", "__proto__"]);
  });

  it("refuses a disclosed member the JWT also has, or a digest named twice", () => {
    const name = disclosure("family_name", "Other");
    expect(reason(issueSdJwtVc({ holder, payload: { _sd: [name.digest] }, extra: [name.text] }))).toMatch(/family_name is given twice/);
    const one = disclosure("x", 1);
    expect(reason(issueSdJwtVc({ holder, payload: { _sd: [one.digest, one.digest] }, extra: [one.text] }))).toMatch(/named twice/);
  });
});
