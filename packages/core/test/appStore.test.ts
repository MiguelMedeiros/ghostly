import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_PREFIXES, APP_STORE_LIMITS, appRef, appStoreDecision, appUpdateDecision, buildAppBundle, canonicalJson, canonicalJsonBytes, readAppListing,
  readAppStore, signAppObject, signAppRevocation, signAppStore, utf8Encode, type AppStoreDecision, type AppStoreIndex, type AppStoreVersion,
  type AppUpdateDecision, type AppVersion,
} from "../src/index";
import { APPS_NOW, DRAFT, ENTRY, appKey, appSigner, matchVectorFile } from "./appVectors";
// covers: apps.store

/*
 * A store index (WISP 1200 · Stores): `ghostly-store.json` with `ghostly-store.sig`, a `listing.json`, and the
 * reader's update rule for indexes and apps. Pinned by `vectors/app-store.json`; write it again with
 * `APPS_VECTORS_WRITE=1 npx vitest run test/appStore.test.ts`.
 */

const FILE = fileURLToPath(new URL("./vectors/app-store.json", import.meta.url));
const store = appSigner("store");
const publisher = appSigner("publisher");
const REF = appRef(appKey("publisher"), "chess");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RAW = "https://raw.githubusercontent.com/ghostly-vectors/chess/HEAD/app.ghostlyapp";
const PINNED = `https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@${COMMIT}/app.ghostlyapp`;
const DAY = 24 * 60 * 60;

interface Valid { name: string; index: string; sig: string; heldKey?: string; read: { digest: string; expired: boolean; index: AppStoreIndex } }
interface Invalid { name: string; refusal: string; index: string; sig: string; heldKey?: string }
interface Vectors {
  about: Record<string, string>;
  inputs: { keys: Record<string, { label: string; key: string }>; now: number };
  valid: Valid[];
  invalid: Invalid[];
  listings: { valid: { name: string; json: string }[]; invalid: { name: string; refusal: string; json: string }[] };
  storeDecisions: { name: string; held: AppStoreVersion | null; read: AppStoreVersion; decision: AppStoreDecision }[];
  appDecisions: { name: string; installed: AppVersion; candidate: AppVersion; decision: AppUpdateDecision }[];
}

async function build(): Promise<Vectors> {
  const v1 = await buildAppBundle(DRAFT, [ENTRY], publisher);
  const v2 = await buildAppBundle({ ...DRAFT, version: "1.1.0", sequence: 2 }, [ENTRY], publisher);
  const v2b = await buildAppBundle({ ...DRAFT, version: "1.1.0", sequence: 2, tagline: "Another build of 2" }, [ENTRY], publisher);
  const revoked = await signAppRevocation({ ghostlyRevoke: 1, app: REF, digests: [v1.digest], reason: "Moves could be forged" }, publisher);
  const listing = {
    ref: REF, sequence: 2, digest: v2.digest, urls: [RAW, PINNED], title: "Chess", tagline: "Play chess with a contact",
    category: "games", developer: "Ghostly vectors", submitter: "Ana", repo: "https://github.com/ghostly-vectors/chess", support: "https://github.com/ghostly-vectors/chess/issues",
  };
  const base: AppStoreIndex = {
    ghostlyStore: 1, key: appKey("store"), name: "Vector store", description: "Apps for the vectors.\nCurated by hand.", kind: "curated",
    sequence: 3, expires: APPS_NOW + 30 * DAY, apps: [listing], removed: [{ ref: REF, digest: v1.digest, reason: "Malware: forged moves", at: APPS_NOW - DAY }], revoked: [revoked],
  };
  const signed = async (index: unknown, signer = store, prefix = APP_PREFIXES.store) => {
    const { bytes, signature } = await signAppObject(prefix, index, signer);
    return { index: new TextDecoder().decode(bytes), sig: canonicalJson(signature) };
  };

  const valid: Valid[] = [];
  const yes = async (name: string, index: AppStoreIndex, heldKey?: string) => {
    const { indexBytes, sigBytes } = await signAppStore(index, store);
    const read = readAppStore(indexBytes, sigBytes, APPS_NOW, heldKey);
    if (!read.ok) throw new Error(`${name}: ${read.reason}`);
    valid.push({ name, index: new TextDecoder().decode(indexBytes), sig: new TextDecoder().decode(sigBytes), ...(heldKey ? { heldKey } : {}), read: read.store });
  };
  await yes("a curated index with apps, removed and revoked", base, appKey("store"));
  await yes("an indexed index", { ...base, kind: "indexed", name: "Vector index", description: undefined } as AppStoreIndex);
  await yes("an empty index", { ...base, apps: [], removed: [], revoked: [] });
  await yes("expires exactly 90 days ahead", { ...base, expires: APPS_NOW + APP_STORE_LIMITS.expiresAheadS });
  await yes("past expires: read, and marked expired", { ...base, expires: APPS_NOW - 1 });
  await yes("a listing with only the required fields", { ...base, apps: [{ ref: REF, sequence: 1, digest: v1.digest, urls: [RAW], title: "Chess", tagline: "Chess" }] });

  const invalid: Invalid[] = [];
  const no = async (name: string, refusal: string, index: unknown, options: { signer?: typeof store; prefix?: typeof APP_PREFIXES.store; heldKey?: string; text?: string } = {}) => {
    const s = await signed(index, options.signer, options.prefix);
    invalid.push({ name, refusal, index: options.text ?? s.index, sig: s.sig, ...(options.heldKey ? { heldKey: options.heldKey } : {}) });
  };
  const good = await signed(base);
  invalid.push({ name: "bytes that are not canonical", refusal: "not-canonical", index: JSON.stringify(base, null, 2), sig: good.sig });
  invalid.push({ name: "keys out of order", refusal: "not-canonical", index: JSON.stringify(base), sig: good.sig });
  invalid.push({ name: "a signature statement that is not canonical", refusal: "bad-signature-statement", index: good.index, sig: JSON.stringify(JSON.parse(good.sig), null, 1) });
  invalid.push({ name: "a bad signature", refusal: "bad-signature", index: good.index.replace("Vector store", "Vector stork"), sig: good.sig });
  await no("signed by another key, named", "signature-key", base, { signer: appSigner("other store") });
  await no("signed as a manifest", "bad-signature", base, { prefix: APP_PREFIXES.app as unknown as typeof APP_PREFIXES.store });
  await no("another key than the store the reader holds", "store-key", base, { heldKey: appKey("other store") });
  await no("expires more than 90 days ahead", "expires-too-far", { ...base, expires: APPS_NOW + APP_STORE_LIMITS.expiresAheadS + 1 });
  const url = (u: string) => ({ ...base, apps: [{ ...listing, urls: [u] }] });
  await no("a jsDelivr URL on a branch", "bad-field", url("https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@main/app.ghostlyapp"));
  await no("a jsDelivr URL on a tag", "bad-field", url("https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@v1.0.0/app.ghostlyapp"));
  await no("a jsDelivr URL at latest", "bad-field", url("https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@latest/app.ghostlyapp"));
  await no("a jsDelivr URL on a version range", "bad-field", url("https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@1/app.ghostlyapp"));
  await no("a jsDelivr URL with a short commit", "bad-field", url(`https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@${COMMIT.slice(0, 7)}/app.ghostlyapp`));
  await no("a URL over http", "bad-field", url("http://example.org/app.ghostlyapp"));
  await no("five URLs", "bad-field", { ...base, apps: [{ ...listing, urls: [RAW, RAW, RAW, RAW, RAW] }] });
  await no("an unknown key in the index", "unknown-key", { ...base, promoted: [] });
  await no("an unknown key in a listing", "unknown-key", { ...base, apps: [{ ...listing, icon: "https://example.org/icon.png" }] });
  await no("no expires", "missing-key", { ...base, expires: undefined });
  await no("format version 2", "unsupported-format", { ...base, ghostlyStore: 2 });
  await no("another kind", "bad-field", { ...base, kind: "official" });
  await no("sequence 0", "bad-field", { ...base, sequence: 0 });
  await no("a listing whose ref is not one", "bad-field", { ...base, apps: [{ ...listing, ref: "chess" }] });
  await no("one app listed twice", "duplicate-app", { ...base, apps: [listing, { ...listing, sequence: 1, digest: v1.digest }] });
  await no("a removal without a reason", "missing-key", { ...base, removed: [{ ref: REF, digest: v1.digest, at: APPS_NOW }] });
  await no("a revocation that does not verify", "bad-revocation", { ...base, revoked: [{ ...revoked, statement: { ...revoked.statement, reason: "Changed by the store" } }] });
  await no("a revocation signed by the store", "bad-revocation", { ...base, revoked: [await signAppRevocation({ ghostlyRevoke: 1, app: appRef(appKey("store"), "chess"), upTo: 1 }, store).then((r) => ({ ...r, statement: { ...r.statement, app: REF } }))] });
  invalid.push({ name: "bytes that are not JSON", refusal: "not-json", index: "ghostly-store", sig: good.sig });

  const listings = {
    valid: [{ name: "a listing.json", json: JSON.stringify(listing, null, 2) }],
    invalid: [
      { name: "a listing with a store's key", refusal: "unknown-key", json: JSON.stringify({ ...listing, expires: 1 }) },
      { name: "a listing without urls", refusal: "missing-key", json: JSON.stringify({ ...listing, urls: undefined }) },
      { name: "a listing with a jsDelivr branch", refusal: "bad-field", json: JSON.stringify({ ...listing, urls: ["https://cdn.jsdelivr.net/gh/o/r@main/app.ghostlyapp"] }) },
    ],
  };

  const held = { key: appKey("store"), sequence: 3, digest: valid[0]!.read.digest };
  const storeDecisions: Vectors["storeDecisions"] = [
    { name: "none held", held: null, read: held, decision: "new" },
    { name: "a higher sequence", held, read: { ...held, sequence: 4, digest: valid[2]!.read.digest }, decision: "update" },
    { name: "the same index", held, read: held, decision: "same" },
    { name: "a lower sequence than the one held", held, read: { ...held, sequence: 2, digest: valid[2]!.read.digest }, decision: "rollback" },
    { name: "the same sequence, other bytes", held, read: { ...held, digest: valid[2]!.read.digest }, decision: "equivocation" },
    { name: "another store's key", held, read: { ...held, key: appKey("other store"), sequence: 9 }, decision: "other-key" },
  ];
  const installed = { ref: REF, sequence: 2, digest: v2.digest };
  const appDecisions: Vectors["appDecisions"] = [
    { name: "a higher sequence", installed: { ref: REF, sequence: 1, digest: v1.digest }, candidate: installed, decision: "update" },
    { name: "the version installed", installed, candidate: installed, decision: "same" },
    { name: "a lower sequence", installed, candidate: { ref: REF, sequence: 1, digest: v1.digest }, decision: "rollback" },
    { name: "two different versions 2", installed, candidate: { ref: REF, sequence: 2, digest: v2b.digest }, decision: "equivocation" },
    { name: "the same name under another key", installed, candidate: { ref: appRef(appKey("other publisher"), "chess"), sequence: 9, digest: v2b.digest }, decision: "other-app" },
  ];

  return {
    about: {
      pins: "ghostly-store.json with ghostly-store.sig (ghostly-store/1), a listing.json, and the reader's update rule for store indexes and apps",
      wisp: "WISP 1200, Stores, Updates and rollback and Test vectors",
      test: "packages/core/test/appStore.test.ts (APPS_VECTORS_WRITE=1 writes this file again)",
      index: "The exact bytes of ghostly-store.json and ghostly-store.sig, as UTF-8 text; times are Unix seconds and `now` is the reader's clock",
    },
    inputs: { keys: Object.fromEntries(["store", "other store", "publisher", "other publisher"].map((label) => [label.replace(" ", "-"), { label, key: appKey(label) }])), now: APPS_NOW },
    valid, invalid, listings, storeDecisions, appDecisions,
  };
}

describe("app store vectors", () => {
  it("match the checked-in file, and a reader reads each case as it says", async () => {
    const v = matchVectorFile(FILE, await build());
    for (const c of v.valid) {
      const read = readAppStore(utf8Encode(c.index), utf8Encode(c.sig), v.inputs.now, c.heldKey);
      expect(read, c.name).toEqual({ ok: true, store: c.read });
    }
    for (const c of v.invalid) {
      const read = readAppStore(utf8Encode(c.index), utf8Encode(c.sig), v.inputs.now, c.heldKey);
      expect(read.ok ? "accepted" : read.reason, c.name).toBe(c.refusal);
    }
    for (const c of v.listings.valid) expect(readAppListing(c.json).ok, c.name).toBe(true);
    for (const c of v.listings.invalid) { const read = readAppListing(c.json); expect(read.ok ? "accepted" : read.reason, c.name).toBe(c.refusal); }
    for (const c of v.storeDecisions) expect(appStoreDecision(c.held, c.read), c.name).toBe(c.decision);
    for (const c of v.appDecisions) expect(appUpdateDecision(c.installed, c.candidate), c.name).toBe(c.decision);
  });
});

describe("signing a store", () => {
  it("refuses to sign another store's index or a bad one", async () => {
    const index: AppStoreIndex = { ghostlyStore: 1, key: appKey("store"), name: "S", kind: "curated", sequence: 1, expires: APPS_NOW, apps: [], removed: [], revoked: [] };
    await expect(signAppStore(index, appSigner("other store"))).rejects.toThrow(/its own key/);
    await expect(signAppStore({ ...index, name: "" }, store)).rejects.toThrow(/bad-field/);
    const { indexBytes, sigBytes } = await signAppStore(index, store);
    expect(new TextDecoder().decode(indexBytes)).toBe(new TextDecoder().decode(canonicalJsonBytes(index)));
    expect(readAppStore(indexBytes, sigBytes, APPS_NOW).ok).toBe(true);
  });

  it("refuses an index past 16 MiB before reading it", () => {
    const read = readAppStore(new Uint8Array(APP_STORE_LIMITS.indexBytes + 1), new Uint8Array(0), APPS_NOW);
    expect(read.ok ? "accepted" : read.reason).toBe("too-large");
  });
});
