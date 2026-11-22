import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_STATEMENT_LIMITS, appRef, canonicalJson, canonicalJsonBytes, canonicalJsonListEntries, readAppRevocation, readAppRevocations, readCanonicalJson,
  signAppRevocation, toBase64Url, utf8Decode, utf8Encode, type SignedAppRevocation,
} from "../src/index";
import { sha256 } from "@noble/hashes/sha2.js";
import { appKey, appSigner } from "./appVectors";
// covers: apps.bundle

/*
 * `ghostly-revoke.json` is read one entry at a time, each found by a scan that parses nothing: a file is refused at its
 * first bad entry, its 4097th, or an entry larger than any revocation can be, however large the file is. Reading it
 * entry by entry refuses exactly the files reading it whole refuses.
 */

const publisher = appSigner("publisher");
const REF = appRef(appKey("publisher"), "chess");
const digest = (n: number) => toBase64Url(sha256(utf8Encode(`version ${n}`)));

/** Each signature is checked once, so lists of 4096 copies read fast. */
const checked = new Set<string>();

/** The reader before the split: the whole file parsed and checked canonical, then each entry. */
function readWhole(bytes: Uint8Array): { ok: boolean } {
  const read = readCanonicalJson(bytes);
  if (!read.ok) return read;
  if (!Array.isArray(read.value) || read.value.length > APP_STATEMENT_LIMITS.revocations) return { ok: false };
  return { ok: read.value.every((entry) => readAppRevocation(entry, checked).ok) };
}

/** The longest text JSON.parse was given while `run` ran. */
function longestParse(run: () => void): number {
  const parse = vi.spyOn(JSON, "parse");
  try {
    run();
    return Math.max(0, ...parse.mock.calls.map(([text]) => String(text).length));
  } finally { parse.mockRestore(); }
}

const junk = (entry: string, bytes: number) => utf8Encode(`[${Array.from({ length: Math.floor((bytes - 2) / (entry.length + 1)) }, () => entry).join(",")}]`);

afterEach(() => { vi.restoreAllMocks(); });

describe("a ghostly-revoke.json is split before it is parsed", () => {
  it("a 16 MiB list of junk entries is refused with nothing larger than one entry parsed", () => {
    const file = junk("{}", 16 * 1024 * 1024 - 1);
    expect(file.length).toBeGreaterThan(15 * 1024 * 1024);
    let read: ReturnType<typeof readAppRevocations> | undefined;
    expect(longestParse(() => { read = readAppRevocations(file); })).toBeLessThanOrEqual(APP_STATEMENT_LIMITS.revocationBytes);
    expect(read).toMatchObject({ ok: false, reason: "bad-revocation" });
  });

  it("an entry larger than any revocation can be is refused before it is parsed", () => {
    const file = utf8Encode(`[[${Array.from({ length: 1024 * 1024 }, () => "0").join(",")}]]`);
    expect(longestParse(() => expect(readAppRevocations(file)).toMatchObject({ ok: false, reason: "bad-revocation" }))).toBe(0);
  });

  it("the largest revocation a publisher can sign fits under the entry limit", async () => {
    const statement = { ghostlyRevoke: 1 as const, app: appRef(appKey("publisher"), "a".repeat(32)), digests: Array.from({ length: 64 }, (_, n) => digest(n)), reason: "😀".repeat(200) };
    const signed = await signAppRevocation(statement, publisher);
    const size = canonicalJsonBytes(signed).length;
    expect(size).toBeGreaterThan(4000);
    expect(size * 2).toBeLessThanOrEqual(APP_STATEMENT_LIMITS.revocationBytes);
    const read = readAppRevocations(canonicalJsonBytes([signed, signed]));
    expect(read.ok && read.revocations).toEqual([signed, signed]);
  });

  it("refuses and takes exactly the files reading them whole does", async () => {
    const r1 = await signAppRevocation({ ghostlyRevoke: 1, app: REF, digests: [digest(1)], reason: "Leaks, [chats] and {keys} \"here\" \\" }, publisher);
    const r2 = await signAppRevocation({ ghostlyRevoke: 1, app: REF, upTo: 3 }, publisher);
    const list = canonicalJson([r1, r2]);
    const files = [
      list, canonicalJson([r1]), "[]", canonicalJson(r1), JSON.stringify([r1, r2], null, 2), ` ${list}`, `${list}\n`, `${list}]`, `[${list}`,
      list.replace("],", "],,"), `${list.slice(0, -1)},]`, `[,${list.slice(1)}`, "[ ]", "[,]", "[\"\\]", "[\"]", "[}{]", "[{]}", "[1]", "[\"a\"]",
      `[${canonicalJson(r1)}${canonicalJson(r2)}]`, list.replace("\"statement\"", "\"statement\" "), "[", "]", "",
      canonicalJson(Array.from({ length: 4096 }, () => r2)), canonicalJson(Array.from({ length: 4097 }, () => r2)),
    ];
    for (const text of files) {
      const bytes = utf8Encode(text);
      expect({ text: text.slice(0, 40), ok: readAppRevocations(bytes, checked).ok }).toEqual({ text: text.slice(0, 40), ok: readWhole(bytes).ok });
    }
    expect((readAppRevocations(utf8Encode(list)) as { revocations: SignedAppRevocation[] }).revocations).toEqual([r1, r2]);
  });

  it("splits a canonical list into its entries' own bytes, commas and brackets in strings left whole", () => {
    const value = [{ a: "x,]}[{\"\\" }, [1, [2, 3]], "s", 4, null];
    const scan = (text: string, maxEntries: number) => {
      const entries = canonicalJsonListEntries(utf8Encode(text), maxEntries, 100);
      const found: string[] = [];
      let next = entries.next();
      for (; !next.done; next = entries.next()) found.push(utf8Decode(next.value));
      return { found, end: next.value };
    };
    expect(scan(canonicalJson(value), 10)).toEqual({ found: value.map((v) => canonicalJson(v)), end: null });
    expect(scan(canonicalJson(value), 4)).toEqual({ found: value.slice(0, 4).map((v) => canonicalJson(v)), end: "not-list" });
    expect(scan("[]", 10)).toEqual({ found: [], end: null });
    expect(scan("[\"\\]", 10)).toEqual({ found: [], end: "not-json" });
    expect(scan("[1,{]", 10)).toEqual({ found: ["1"], end: "not-json" });
    expect(scan(`["${"a".repeat(99)}"]`, 10)).toEqual({ found: [], end: "not-list" });
    expect(scan(`["${"a".repeat(98)}"]`, 10)).toEqual({ found: [`"${"a".repeat(98)}"`], end: null });
  });
});
