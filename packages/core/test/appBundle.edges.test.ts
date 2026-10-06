import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  APP_BUNDLE_MAGIC, buildAppBundle, canonicalJson, canonicalJsonBytes, checkAppManifest, readAppBundle, readAppRevocation, readAppStore,
  readCanonicalJson, signAppStore, utf8Encode, type AppStoreIndex,
} from "../src/index";
import { APPS_NOW, DRAFT, ENTRY, appKey, appSigner, file } from "./appVectors";
// covers: apps.bundle, apps.store

/*
 * Fuzzing the readers of WISP 1200: no input makes one throw, no changed byte of a signed bundle or index is accepted,
 * and the canonical form is one fixed point, as RFC 8785 writes it.
 */

const publisher = appSigner("publisher");
const RUNS = { numRuns: 300 };

describe("canonical JSON (RFC 8785)", () => {
  it("writes RFC 8785's own example as the RFC does", () => {
    const value = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}');
    expect(canonicalJson(value)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  it("sorts keys by UTF-16 code units", () => {
    // RFC 8785 § 3.2.3: "€" (euro) sorts before "😀" (an emoji, a surrogate pair) and after "é".
    expect(canonicalJson({ "😀": 1, "€": 2, "é": 3, a: 4, B: 5 })).toBe('{"B":5,"a":4,"é":3,"€":2,"😀":1}');
  });

  it("refuses what JSON cannot hold", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson("\ud800")).toThrow();
    expect(() => canonicalJson({ "\udc00": 1 })).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow();
  });

  it("is a fixed point: reading canonical bytes gives back a value with the same bytes", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      let bytes: Uint8Array;
      try { bytes = canonicalJsonBytes(value); } catch { return; }
      const read = readCanonicalJson(bytes);
      expect(read.ok).toBe(true);
      if (read.ok) expect(canonicalJson(read.value)).toBe(new TextDecoder().decode(bytes));
    }), RUNS);
  });

  it("refuses any other text of the same value", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.integer({ min: 1, max: 4 }), (value, indent) => {
      let canonical: string;
      try { canonical = canonicalJson(value); } catch { return; }
      const pretty = JSON.stringify(value, null, indent);
      if (pretty === canonical) return;
      expect(readCanonicalJson(utf8Encode(pretty)).ok).toBe(false);
    }), RUNS);
  });
});

describe("readers never throw", () => {
  it("on any bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
      expect(readAppBundle(bytes).ok).toBe(false);
      expect(readAppStore(bytes, bytes, APPS_NOW).ok).toBe(false);
      readCanonicalJson(bytes);
    }), RUNS);
  });

  it("on any bytes after the magic, with lengths that point anywhere", () => {
    const magic = utf8Encode(APP_BUNDLE_MAGIC);
    fc.assert(fc.property(fc.uint8Array({ maxLength: 512 }), (rest) => {
      const bytes = new Uint8Array(magic.length + rest.length);
      bytes.set(magic); bytes.set(rest, magic.length);
      expect(readAppBundle(bytes).ok).toBe(false);
    }), RUNS);
  });

  it("on any JSON value as a manifest, a revocation or a store index", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      checkAppManifest(value);
      readAppRevocation(value);
      try { readAppStore(canonicalJsonBytes(value), utf8Encode("{}"), APPS_NOW); } catch (error) { expect(String(error)).toMatch(/JSON/); }
    }), RUNS);
  });

  it("on manifests one field away from a valid one", async () => {
    const built = await buildAppBundle(DRAFT, [ENTRY], publisher);
    const keys = Object.keys(built.manifest);
    fc.assert(fc.property(fc.constantFrom(...keys), fc.jsonValue(), (key, value) => {
      const changed = { ...built.manifest, [key]: value };
      const result = checkAppManifest(JSON.parse(JSON.stringify(changed)));
      if (result.ok) expect(canonicalJson(result.manifest)).toBe(canonicalJson(JSON.parse(JSON.stringify(changed))));
    }), RUNS);
  });
});

describe("a changed byte is never accepted", () => {
  it("anywhere in a signed bundle", async () => {
    const { bytes } = await buildAppBundle({ ...DRAFT, permissions: ["chat", "name"] }, [ENTRY, file("data/a.json", "[1,2,3]")], publisher);
    expect(readAppBundle(bytes).ok).toBe(true);
    fc.assert(fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (at, xor) => {
      const changed = new Uint8Array(bytes);
      changed[at] = changed[at]! ^ xor;
      expect(readAppBundle(changed).ok).toBe(false);
    }), { numRuns: 1000 });
  });

  it("cut short or grown at any length", async () => {
    const { bytes } = await buildAppBundle(DRAFT, [ENTRY], publisher);
    fc.assert(fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), (length) => {
      expect(readAppBundle(bytes.subarray(0, length)).ok).toBe(false);
    }), RUNS);
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (tail) => {
      const grown = new Uint8Array(bytes.length + tail.length);
      grown.set(bytes); grown.set(tail, bytes.length);
      const read = readAppBundle(grown);
      expect(read.ok ? "accepted" : read.reason).toBe("trailing-bytes");
    }), RUNS);
  });

  it("anywhere in a signed store index", async () => {
    const index: AppStoreIndex = { ghostlyStore: 1, key: appKey("store"), name: "Fuzz", kind: "curated", sequence: 1, expires: APPS_NOW, apps: [], removed: [], revoked: [] };
    const { indexBytes, sigBytes } = await signAppStore(index, appSigner("store"));
    fc.assert(fc.property(fc.integer({ min: 0, max: indexBytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (at, xor) => {
      const changed = new Uint8Array(indexBytes);
      changed[at] = changed[at]! ^ xor;
      expect(readAppStore(changed, sigBytes, APPS_NOW).ok).toBe(false);
    }), RUNS);
  });
});

describe("valid bundles round trip", () => {
  it("for any set of files and texts within the bounds", async () => {
    const path = fc.stringMatching(/^[a-z0-9_-]{1,12}(\/[a-z0-9_.-]{1,12}){0,2}$/).filter((p) => p.split("/").every((s) => s !== "." && s !== "..") && !p.startsWith("screenshots") && p !== "icon.png");
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(path, { maxLength: 8, selector: (p) => p.toLowerCase() }),
      fc.string({ minLength: 1, maxLength: 40 }).filter((t) => !/\p{Cc}/u.test(t) && !/[\ud800-\udfff]/.test(t)),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      async (paths, title, sequence) => {
        const files = [ENTRY, ...paths.filter((p) => p.toLowerCase() !== "index.html").map((p) => file(p, p))];
        const titled = [...title].length <= 40 ? title : "Chess";
        const built = await buildAppBundle({ ...DRAFT, title: titled, sequence }, files, publisher);
        const read = readAppBundle(built.bytes);
        expect(read.ok && read.bundle.digest).toBe(built.digest);
        expect(read.ok && read.bundle.manifest.sequence).toBe(sequence);
        expect(read.ok && read.bundle.files.size).toBe(files.length);
      },
    ), { numRuns: 50 });
  });
});
