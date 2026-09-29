import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encode, fromBase64Url, toBase64Url } from "../src/backup/codec";
import { databaseExists, restoreDatabase, snapshotDatabase } from "../src/backup/database";
import { open, seal, type Envelope } from "../src/backup/envelope";
import { S3Store, validateS3Config, type S3Config } from "../src/backup/s3";
import { createdFromName, heldName, manifestName, newSpace } from "../src/backup/storage";
import { decodeBackup, encodeBackup, restoreArkDatabase, snapshotArkDatabase, type ArkDatabaseSnapshot } from "../src/engine/paymentAdapters/backup";
import { wrap } from "../src/shared/idb";
// covers: backup.envelope, backup.passphrase-rules, backup.database-snapshot, storage.s3, wallet.ark.backup

/** PBKDF2 at the real 600,000 rounds is slow on a loaded machine: run fewer, record what was asked. */
const asked: number[] = [];
beforeEach(() => {
  asked.length = 0;
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => {
    asked.push(algorithm.iterations);
    return derive({ ...algorithm, iterations: 1_000 }, ...rest);
  }) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const PASS = "correct horse battery";
const edit = (sealed: string, change: (e: Envelope) => void) => { const e = JSON.parse(sealed) as Envelope; change(e); return JSON.stringify(e); };

describe("the backup envelope", () => {
  it("opens only what it sealed, with the passphrase, at 600,000 rounds", async () => {
    const sealed = await seal("profile payload", PASS);
    expect(await open(sealed, PASS)).toBe("profile payload");
    expect(asked).toEqual([600_000, 600_000]);
    expect(sealed).not.toContain("profile payload");
  });

  it("says plainly when a file is not a Ghostly backup, or comes from a newer Ghostly", async () => {
    const sealed = await seal("x", PASS);
    for (const text of ["not json", "null", "[]", JSON.stringify({ format: "other" })]) await expect(open(text, PASS), text).rejects.toThrow("This is not a Ghostly backup");
    await expect(open(edit(sealed, (e) => { (e as { version: number }).version = 2; }), PASS)).rejects.toThrow("This backup comes from a newer Ghostly; update to restore it");
    expect(asked).toEqual([600_000]);
  });

  it("refuses weaker, unbounded or unknown encryption before deriving any key", async () => {
    const sealed = await seal("x", PASS);
    asked.length = 0;
    const weaker: ((e: Envelope) => void)[] = [
      (e) => { e.kdf.iterations = 599_999; },
      (e) => { e.kdf.iterations = 10_000_001; },
      (e) => { (e.kdf as { name: string }).name = "scrypt"; },
      (e) => { delete (e as Partial<Envelope>).kdf; },
      (e) => { (e.cipher as { name: string }).name = "AES-128-CBC"; },
      (e) => { (e as { compression: string }).compression = "brotli"; },
    ];
    for (const change of weaker) await expect(open(edit(sealed, change), PASS)).rejects.toThrow("Unsupported backup encryption");
    expect(asked).toEqual([]);
  });

  it("a cut, a changed nonce or salt, or a garbled field is caught as a changed backup, never read differently", async () => {
    const sealed = await seal("the whole profile", PASS);
    const changed: ((e: Envelope) => void)[] = [
      (e) => { e.ciphertext = e.ciphertext.slice(0, e.ciphertext.length / 2); },
      (e) => { e.ciphertext = ""; },
      (e) => { e.cipher.iv = toBase64Url(new Uint8Array(12)); },
      (e) => { e.kdf.salt = toBase64Url(new Uint8Array(16)); },
      (e) => { e.ciphertext = `${e.ciphertext.slice(0, -2)}!!`; },
      // More rounds than it was sealed with is allowed, and changes the key: it cannot open.
      (e) => { e.kdf.iterations = 700_000; },
    ];
    for (const change of changed) await expect(open(edit(sealed, change), PASS)).rejects.toThrow("Wrong passphrase, or the backup was changed");
  });

  it("refuses a file too large to be a backup without parsing it", async () => {
    const parse = vi.spyOn(JSON, "parse");
    // The limit is on the text length; a string that long is never built here, only its length is read.
    const huge = { length: 1024 ** 3 * 1.4 + 1 } as unknown as string;
    await expect(open(huge, PASS)).rejects.toThrow("This backup is too large to restore");
    expect(parse).not.toHaveBeenCalled();
  });

  it("where compression is missing, seals uncompressed and still opens", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const sealed = await seal("b".repeat(1_000), PASS);
    expect(JSON.parse(sealed)).toMatchObject({ compression: "none" });
    expect(sealed.length, "not compressed").toBeGreaterThan(1_000);
    expect(await open(sealed, PASS)).toBe("b".repeat(1_000));
  });
});

describe("the backup codec", () => {
  it("round-trips large byte arrays, array buffers, negative bigints and empty blobs", async () => {
    const big = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7919) % 256);
    const value = { big, buffer: new Uint8Array([9, 8, 7]).buffer, n: -123456789012345678901234567890n, empty: new Blob([]), zero: 0n };
    const back = decode(await encode(value)) as { big: Uint8Array; buffer: Uint8Array; n: bigint; empty: Blob; zero: bigint };
    expect(back.big).toEqual(big);
    expect(back.buffer, "an ArrayBuffer comes back as its bytes").toEqual(new Uint8Array([9, 8, 7]));
    expect(back.n).toBe(value.n);
    expect(back.zero).toBe(0n);
    expect(back.empty.size).toBe(0);
    expect(back.empty.type).toBe("");
  });

  it("an unknown or malformed tag stays as it was", () => {
    const text = JSON.stringify({ a: { $ghostly: "date", value: "2026" }, b: { $ghostly: "blob", value: "aGk", type: 5 }, c: { $ghostly: "object", entries: [["ok", 1], [2, "no"], "bad"] }, d: { $ghostly: "bytes", value: 5 } });
    const back = decode(text) as Record<string, unknown>;
    expect(back.a).toEqual({ $ghostly: "date", value: "2026" });
    expect((back.b as Blob).type, "a blob with a strange type keeps no type").toBe("");
    expect(back.c).toEqual({ ok: 1 });
    expect(back.d).toEqual({ $ghostly: "bytes", value: 5 });
  });

  it("base64url refuses anything outside its alphabet", () => {
    expect(() => fromBase64Url("abc+")).toThrow("Invalid base64url");
    expect(() => fromBase64Url("ab=")).toThrow("Invalid base64url");
    expect(fromBase64Url(toBase64Url(new Uint8Array([251, 255])))).toEqual(new Uint8Array([251, 255]));
    expect(toBase64Url(new Uint8Array([251, 255]))).toBe("-_8");
  });
});

describe("backup names", () => {
  it("are random where they must be, and read back their date only when they are a backup's", () => {
    expect(newSpace()).toMatch(/^[a-z2-7]{16}$/);
    expect(newSpace()).not.toBe(newSpace());
    expect(heldName("abcdefghijklmnop", "m".repeat(22), 123_456_789)).toMatch(/\/123456789-[a-z2-7]{8}\.ghostly-held$/);
    expect(manifestName("abcdefghijklmnop", "mbox")).toBe("abcdefghijklmnop/hold/mbox/manifest.ghostly-held");
    expect(createdFromName("abcdefghijklmnop/backups/probe-1.txt")).toBe(0);
    expect(createdFromName("abcdefghijklmnop/backups/20260101T000000Z-UPPERCAS.ghostly-backup")).toBe(0);
  });
});

async function make(name: string, version: number, build: (db: IDBDatabase) => void) {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => build(request.result);
  (await wrap(request)).close();
}
async function read(name: string, store: string) {
  const db = await wrap(indexedDB.open(name));
  try { const s = db.transaction(store).objectStore(store); return { keys: await wrap(s.getAllKeys()), values: await wrap(s.getAll()), indexes: Array.from(s.indexNames), keyPath: s.keyPath }; } finally { db.close(); }
}

describe("database snapshots", () => {
  it("a database with no store has nothing to back up", async () => {
    await make("empty-db", 1, () => {});
    expect(await snapshotDatabase("empty-db")).toBeNull();
  });

  it("where the browser cannot list databases, a database is assumed to exist rather than skipped", async () => {
    Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
    try {
      expect(await databaseExists("whatever")).toBe(true);
    } finally {
      delete (indexedDB as { databases?: unknown }).databases;
    }
    expect(typeof indexedDB.databases).toBe("function");
  });

  it("a snapshot the browser cannot build from fails as it is, and leaves no half-made database behind", async () => {
    const snapshot = { version: 1, stores: [{ name: "s", keyPath: "id", autoIncrement: false, indexes: [{ name: "i", keyPath: ["a", "b"], unique: false, multiEntry: true }], keys: [], values: [] }] };
    await expect(restoreDatabase("bad-index", snapshot as never)).rejects.not.toThrow("already exists");
    expect((await snapshotDatabase("bad-index"))).toBeNull();
  });
});

describe("the Ark wallet database in a backup", () => {
  const STORES = ["vtxos", "utxos", "transactions", "walletState", "contracts", "contractsCollections"];

  it("carries bigints and bytes through the backup text", () => {
    const value = { amount: 21_000_000_00000000n, script: new Uint8Array([0, 20, 255]), nested: [{ n: -1n }] };
    expect(decodeBackup(encodeBackup(value))).toEqual(value);
  });

  it("restores out-of-line keys, key paths and indexes exactly", async () => {
    await make("ghostly-ark-src", 3, (db) => {
      for (const name of STORES.slice(1)) db.createObjectStore(name, { keyPath: "id" }).put({ id: `${name}-1`, at: 5n });
      const vtxos = db.createObjectStore("vtxos");
      vtxos.createIndex("bySpent", "spent", { unique: false, multiEntry: false });
      vtxos.put({ spent: false, script: new Uint8Array([1, 2]) }, "outpoint:0");
    });
    const snapshot = decodeBackup(encodeBackup(await snapshotArkDatabase("src"))) as ArkDatabaseSnapshot;
    await restoreArkDatabase("dst", snapshot);
    expect(await read("ghostly-ark-dst", "vtxos")).toEqual({ keys: ["outpoint:0"], values: [{ spent: false, script: new Uint8Array([1, 2]) }], indexes: ["bySpent"], keyPath: null });
    expect(await read("ghostly-ark-dst", "walletState")).toMatchObject({ keys: ["walletState-1"], values: [{ id: "walletState-1", at: 5n }], keyPath: "id" });
  });

  it("refuses snapshots that are not exactly the SDK's schema, and never writes over an older wallet", async () => {
    await make("ghostly-ark-base", 3, (db) => { for (const name of STORES) db.createObjectStore(name, { keyPath: "id" }); });
    const snapshot = await snapshotArkDatabase("base");
    const bad: ArkDatabaseSnapshot[] = [
      { ...snapshot, stores: [...snapshot.stores, snapshot.stores[0]] },
      { ...snapshot, stores: [{ ...snapshot.stores[0], keys: ["extra"] }, ...snapshot.stores.slice(1)] },
      { ...snapshot, stores: [{ ...snapshot.stores[0], values: "x" as never }, ...snapshot.stores.slice(1)] },
      { ...snapshot, stores: "x" as never },
      { ...snapshot, stores: [...snapshot.stores, ...["intents", "virtualTxs", "vtxoBranches", "a"].map((name) => ({ ...snapshot.stores[0], name }))] },
    ];
    for (const s of bad) await expect(restoreArkDatabase("never", s)).rejects.toThrow("Unsupported Ark backup schema");
    expect(await databaseExists("ghostly-ark-never")).toBe(false);

    // A wallet database left at an older version is upgraded by nothing: the restore refuses it.
    await make("ghostly-ark-older", 2, (db) => db.createObjectStore("vtxos").put("mine", "k"));
    await expect(restoreArkDatabase("older", snapshot)).rejects.toThrow("An Ark database for older already exists");
    expect((await read("ghostly-ark-older", "vtxos")).values).toEqual(["mine"]);
  });
});

describe("S3 storage", () => {
  const CONFIG: S3Config = { endpoint: "https://s3.example.com", region: "eu-west-1", bucket: "bkt", prefix: "", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/SECRET" };
  const NAME = "abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup";
  type Seen = { method: string; url: string; headers: Record<string, string>; body?: Uint8Array };
  function s3(answer: (seen: Seen) => Response | Promise<Response>, config: Partial<S3Config> = {}) {
    const seen: Seen[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => { const s = { method: init.method!, url: String(url), headers: init.headers as Record<string, string>, body: init.body as Uint8Array | undefined }; seen.push(s); return answer(s); }) as unknown as typeof fetch;
    return { store: new S3Store({ ...CONFIG, ...config }, fetcher), seen };
  }

  it("says in plain words when the place cannot be reached or refuses, and never shows the secret key", async () => {
    const offline = s3(() => { throw new TypeError("Failed to fetch"); });
    await expect(offline.store.get(NAME)).rejects.toThrow("Could not reach s3.example.com: offline, or the bucket's CORS rules do not allow this app");
    await expect(s3(() => new Response("", { status: 500 })).store.put(NAME, new Uint8Array([1]))).rejects.toThrow(/^S3 refused \(500\)$/);
    const unreadable = s3(() => ({ ok: false, status: 503, text: () => Promise.reject(new Error("stream broke")) }) as unknown as Response);
    await expect(unreadable.store.remove(NAME)).rejects.toThrow(/^S3 refused \(503\)$/);
    await expect(s3(() => new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 })).store.get(NAME)).rejects.toThrow(/^S3 refused \(503 SlowDown\)$/);
    const { store, seen } = s3(() => new Response(null, { status: 204 }));
    await store.put(NAME, new Uint8Array([1]));
    expect(JSON.stringify(seen)).not.toContain("wJalrXUtnFEMI");
    expect(seen[0].headers.authorization).toContain("Credential=AKIDEXAMPLE/");
  });

  it("writes, reads and removes one object in its own folder, typed as a backup", async () => {
    const { store, seen } = s3((s) => new Response(s.method === "GET" ? new Uint8Array([1, 2, 3]) : null, { status: s.method === "GET" ? 200 : 204 }), { prefix: "/ghostly/" });
    expect(store.description).toBe("S3 · bkt/ghostly");
    await store.put(NAME, new Uint8Array([7]));
    expect(await store.get(NAME)).toEqual(new Uint8Array([1, 2, 3]));
    await store.remove(NAME);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["PUT", "GET", "DELETE"].map((m) => `${m} https://s3.example.com/bkt/ghostly/${NAME}`));
    expect(seen[0].headers["content-type"]).toBe("application/vnd.ghostly.backup+json");
    expect(s3(() => new Response()).store.description).toBe("S3 · bkt");
  });

  it("reads listed names, sizes and dates, with XML escapes undone", async () => {
    const { store } = s3(() => new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>abcdefghijklmnop/backups/20260102T000000Z-bbbbbbbb.ghostly-backup</Key><Size>20</Size><LastModified>2026-01-02T00:00:05.000Z</LastModified></Contents>
      <Contents><Key>abcdefghijklmnop/backups/a&amp;b.ghostly-backup</Key></Contents>
      <Contents><Key>abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup</Key><Size>x</Size></Contents>
    </ListBucketResult>`));
    const listed = await store.list("abcdefghijklmnop");
    expect(listed).toEqual([
      { name: "abcdefghijklmnop/backups/20260101T000000Z-aaaaaaaa.ghostly-backup", size: undefined, modified: undefined, created: Date.UTC(2026, 0, 1) },
      { name: "abcdefghijklmnop/backups/20260102T000000Z-bbbbbbbb.ghostly-backup", size: 20, modified: Date.parse("2026-01-02T00:00:05Z"), created: Date.UTC(2026, 0, 2) },
    ]);
  });

  it("a truncated listing without a continuation token ends instead of asking forever", async () => {
    const { store, seen } = s3(() => new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"));
    expect(await store.list("abcdefghijklmnop")).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("proves a place works by writing, reading back, listing and removing a probe", async () => {
    const objects = new Map<string, Uint8Array>();
    const place = (list = true, corrupt = false, removeFails = false) => s3((s) => {
      const url = new URL(s.url);
      if (s.method === "PUT") { objects.set(url.pathname, s.body!); return new Response(null); }
      if (s.method === "DELETE") return removeFails ? new Response("", { status: 403 }) : (objects.delete(url.pathname), new Response(null));
      if (url.searchParams.get("list-type")) return new Response(list ? [...objects.keys()].map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") : "<ListBucketResult/>");
      return new Response((corrupt ? new TextEncoder().encode("something else") : objects.get(url.pathname)) as BodyInit | undefined);
    }, { prefix: "g" });
    const good = place();
    await good.store.test("abcdefghijklmnop");
    expect(good.seen.map((s) => s.method)).toEqual(["PUT", "GET", "GET", "DELETE"]);
    expect(objects.size, "the probe is gone").toBe(0);
    await expect(place(true, true).store.test("abcdefghijklmnop")).rejects.toThrow("S3 returned different bytes than were stored");
    await expect(place(false).store.test("abcdefghijklmnop")).rejects.toThrow("S3 did not list the object just stored");
    await expect(place(true, false, true).store.test("abcdefghijklmnop"), "a probe that cannot be removed is not a failure").resolves.toBeUndefined();
  });

  it("a presigned read lasts at least a second, and settings with no key, bad endpoint or odd prefix are refused", async () => {
    const { store } = s3(() => new Response());
    const url = new URL(await store.presign("abcdefghijklmnop/hold/abcdefghijklmnopqrstuv/manifest.ghostly-held", 0));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("1");
    expect(url.toString()).not.toContain("wJalrXUtnFEMI");
    expect(() => validateS3Config({ ...CONFIG, endpoint: "not a url" })).toThrow("Enter the endpoint as a URL");
    expect(() => validateS3Config({ ...CONFIG, endpoint: "https://s3.example.com/?x=1" })).toThrow("credentials in their own fields");
    expect(() => validateS3Config({ ...CONFIG, secretAccessKey: "  " })).toThrow("Enter the access key and its secret");
    expect(() => validateS3Config({ ...CONFIG, prefix: "a b" })).toThrow("prefix");
    expect(() => validateS3Config({ ...CONFIG, prefix: "a//b" })).toThrow("prefix");
    expect(validateS3Config({ ...CONFIG, endpoint: "http://[::1]:9000", prefix: "a/b/" })).toMatchObject({ endpoint: "http://[::1]:9000", prefix: "a/b/" });
  });
});
