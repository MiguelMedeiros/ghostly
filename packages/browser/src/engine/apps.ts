import { sha256 } from "@noble/hashes/sha2.js";
import {
  APP_BUNDLE_LIMITS, APP_BUNDLE_MAGIC, appDigest, appViewOf, appFingerprint, appRef, appStoreDecision, appUpdateDecision,
  canonicalJson, checkAppBeforeRun, isAppKey, isAppRef, planAppUpdate, readAppBundle, readAppRevocations, readAppStore,
  toBase64Url, utf8Decode, utf8Encode,
  type AppBundle, type AppListing, type AppManifest, type AppPermission, type AppRemoval, type AppStoreIndex, type AppStoreKind,
  type AppStoreView, type AppViewMode, type AppVersion, type JsonValue, type SignedAppRevocation,
} from "@ghostly/core";
import { APP_STORAGE_SCOPE_INDEX, STORES, openDb, store, wrap } from "../shared/idb";
import { FILE_BYTES_STEP, fileBytes, fileBytesOf, type FileBytes, type FileBytesKind } from "../shared/fileBytes";
import { APP_FETCH_LIMITS, AppFetchError, appPasteUrl, besideUrl, isAppFetchUrl, isGitHubPage, type AppFetcher } from "./appFetch";
import { DEFAULT_APP_STORES } from "./appDefaults";

/*
 * The engine's app store (WISP 1200 § Updates and rollback, § Stores, § Permissions): the mini-apps installed in this
 * profile, the stores the person added, and each app's own storage per chat.
 *
 * - A bundle is kept whole, by digest, in file storage (`app-<digest>`), the same storage as chat files, but with no
 *   `files` row: a backup carries the installed list, the stores and the storage, never the bundles, and a restored
 *   profile shows "Needs its files" until a source answers again.
 * - The installed list (reference, publisher, the `sequence` and digest installed, the permissions granted, the
 *   manifest), the stores (URL and pinned key, with the last index read) and the storage rows are in the profile's
 *   database (`STORES.apps`, `STORES.appStores`, `STORES.appStorage`).
 * - Nothing is read from the network until the person asks (a store added or opened, an app fetched) or an app is
 *   installed; then at start and every 24 hours. Reads go only to the hosts of `appFetch.ts`.
 * - Nothing installs before the person saw the checked bundle: `preview` fetches, checks and keeps it in memory,
 *   `install` stores it. An update that adds permissions waits for the person (`acceptUpdate`); a lower `sequence` is
 *   never installed; the same `sequence` with another digest is refused and marked.
 */

/** The scope of an app opened alone, outside every chat. Other scopes are the link ids of 1:1 chats. */
export const APP_SCOPE_ALONE = "alone";

export const APP_STORAGE_LIMITS = {
  /** A key, in UTF-8 bytes. */
  keyBytes: 256,
  /** A value, as compact JSON in UTF-8 bytes. */
  valueBytes: 64 * 1024,
  /** Every key and value of one app in one scope. */
  scopeBytes: 5 * 1024 * 1024,
} as const;

export const APP_CHECK_TIMINGS = {
  /** After the engine starts, so the chats come up first. */
  afterStartMs: 60_000,
  everyMs: 24 * 60 * 60 * 1000,
  /** A check at start is skipped when every app was checked this recently (a page reloaded several times). */
  freshMs: 60 * 60 * 1000,
} as const;

/** A fetched bundle kept for its install screen: at most this many, for this long. */
const STAGED = { max: 4, ms: 10 * 60 * 1000 } as const;
/** The first bytes of a bundle: magic, the manifest's length and the largest manifest. */
const PEEK_BYTES = APP_BUNDLE_MAGIC.length + 4 + APP_BUNDLE_LIMITS.manifestBytes;

const bundleId = (digest: string) => `app-${digest}`;

/** One installed app, by reference (`STORES.apps`). */
export interface InstalledApp {
  ref: string;
  publisher: string;
  name: string;
  /** The version installed: the highest `sequence` installed, and its digest. */
  sequence: number;
  digest: string;
  /** What the person granted. */
  permissions: AppPermission[];
  manifest: AppManifest;
  /** Where the bundle's bytes are kept. */
  bytes: FileBytesKind;
  /** The URL the installed version was read from. */
  from: string;
  installedAt: number;
  updatedAt: number;
  /** Revocations signed by its publisher, read beside its sources and kept (a store's are read from the store). */
  revocations?: SignedAppRevocation[];
  /** Another bundle with an installed or waiting `sequence` and another digest: refused, the one held kept. */
  equivocation?: { sequence: number; digest: string; at: number };
  /** A newer version that adds permissions: kept until the person accepts them. */
  pending?: { sequence: number; digest: string; manifest: AppManifest; added: AppPermission[]; bytes: FileBytesKind; from: string; at: number };
  checkedAt?: number;
}

/** A store the person added, by its key (`STORES.appStores`). A store is its key: another key at the URL is another store. */
export interface AddedAppStore {
  key: string;
  url: string;
  addedAt: number;
  /** A default store of this build. */
  preloaded?: true;
  /** A default store the person removed: kept, without its index, so it does not come back. */
  removed?: true;
  index?: AppStoreIndex;
  /** SHA-256 of the index's bytes. */
  digest?: string;
  fetchedAt?: number;
  equivocation?: { sequence: number; digest: string; at: number };
  /** What went wrong at the last read: a refusal code, or the fetch error's. */
  problem?: string;
}

/** One key of one app's storage in one scope (`STORES.appStorage`): the value as JSON, and the bytes it counts. */
export interface AppStorageRow { ref: string; scope: string; key: string; value: string; size: number }

/** Whether an installed app may run now: `needs-files` when its bundle is not on this device (a restored profile). */
export type AppRunStatus =
  | { status: "ok" }
  | { status: "revoked"; reason?: string }
  | { status: "removed"; by: { store: string; name: string; reason: string; at: number }[] }
  | { status: "needs-files" };

/** Stores that list an app, and whether one of them is curated (only a curated store clears "Unknown publisher"). */
export interface AppListedBy { key: string; name: string; kind: AppStoreKind }

export interface InstalledAppView {
  ref: string;
  name: string;
  publisher: string;
  fingerprint: string;
  title: string;
  tagline: string;
  description?: string;
  version: string;
  sequence: number;
  digest: string;
  permissions: AppPermission[];
  /** Where it shows: in a 1:1 chat only, or full screen (`chat` when its manifest names none). */
  view: AppViewMode;
  /** The URL the installed version was read from: what an app card sent in a chat names (WISP 405 § An app). */
  from: string;
  /** The bundle has an `icon.png` (read with `appFile`, no request). */
  icon: boolean;
  installedAt: number;
  updatedAt: number;
  run: AppRunStatus;
  listedBy: AppListedBy[];
  /** No curated store of the person's lists it (phase 1 has no publisher proofs). */
  unknownPublisher: boolean;
  pending?: { sequence: number; version: string; added: AppPermission[] };
  equivocation?: { sequence: number; at: number };
  checkedAt?: number;
}

export interface AppStoreSummary {
  key: string;
  fingerprint: string;
  url: string;
  preloaded: boolean;
  name?: string;
  description?: string;
  kind?: AppStoreKind;
  sequence?: number;
  expires?: number;
  /** Past `expires`: it still installs, and the Apps page says when it was last updated. */
  expired: boolean;
  fetchedAt?: number;
  apps: AppListing[];
  removed: AppRemoval[];
  equivocation?: { sequence: number; at: number };
  problem?: string;
}

/** What `previewStore` read, before the person adds it. */
export interface AppStorePreview { url: string; key: string; fingerprint: string; name: string; description?: string; kind: AppStoreKind; sequence: number; expires: number; expired: boolean; apps: number }

/** Where to fetch an app from: a pasted URL, a store's listing, or a chat card's pointer. */
export type AppSource =
  | { url: string }
  | { store: string; ref: string }
  | { card: { ref: string; url: string; sequence?: number; digest?: string } };

/** What the install screen shows, from the checked bundle. Nothing is stored yet. */
export interface AppPreview {
  digest: string;
  ref: string;
  publisher: string;
  fingerprint: string;
  manifest: AppManifest;
  from: string;
  /** `icon.png`, checked square, or null. */
  icon: Uint8Array | null;
  /** Next to what is installed: `new`, `update`, `same`; `rollback` and `equivocation` are not installed. */
  install: "new" | "update" | "same" | "rollback" | "equivocation";
  /** The permissions the person is asked for: all of them for a new app, the added ones for an update. */
  asks: AppPermission[];
  run: AppRunStatus;
  listedBy: AppListedBy[];
  unknownPublisher: boolean;
}

export type AppCheckOutcome = "updated" | "ask" | "equivocation" | "none";
export interface AppCheckResult { ref: string; outcome: AppCheckOutcome; run: AppRunStatus }

/** What the runner gets: the checked entry and what the broker needs to answer the app. */
export interface AppRunEntry { ref: string; digest: string; version: string; title: string; permissions: AppPermission[]; view: AppViewMode; entry: string }

/** An app's storage in one scope, as the WISP's export file. */
export interface AppDataExport { ghostlyAppData: 1; app: string; scope: string; entries: Record<string, JsonValue> }

export interface AppsHost {
  fetch: AppFetcher;
  /** Whether a scope other than `alone` is a 1:1 chat of this profile (its link id). */
  isChat(scope: string): boolean;
  /** Whether the scheduled checks may go out now (network on, not limited). */
  online(): boolean;
  now?: () => number;
  defaults?: readonly { url: string; key: string }[];
  /** After every update check (the scheduled one included): the pages read the installed apps again. */
  checked?(results: AppCheckResult[]): void;
}

interface Staged { bundle: AppBundle; bytes: Uint8Array; from: string; at: number }

/** An error whose message starts with its code (`<code>: words`), as it crosses the engine's RPC. */
function fail(code: string, words: string): never {
  throw new Error(`${code}: ${words}`);
}

/**
 * Why a pasted link is not read: a github.com page that is neither a repository nor a file of one (`github-link`), so
 * the person is not told GitHub is off the list; any other host (`host`).
 */
function notReadable(url: unknown, words: string): never {
  if (typeof url === "string" && isGitHubPage(url)) fail("github-link", "Paste the repository's link, or the link to its app file");
  fail("host", words);
}

const versionOf = (manifest: AppManifest, digest: string): AppVersion => ({ ref: appRef(manifest.publisher, manifest.name), sequence: manifest.sequence, digest });
const byteLength = (text: string) => utf8Encode(text).length;

/** Rows of one app (`[ref]`), or of one app in one scope (`[ref, scope]`), in `STORES.appStorage`. */
const rowsOf = (...prefix: string[]) => IDBKeyRange.bound(prefix, [...prefix, []]);

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("App storage failed"));
  });
}

/**
 * The manifest of a bundle's first bytes, unchecked: only to see whether a source holds something newer before reading
 * all of it. Whatever it says, the whole bundle is checked before anything is kept.
 */
export function peekAppManifest(bytes: Uint8Array): { ref: string; sequence: number; digest: string } | null {
  const magic = utf8Encode(APP_BUNDLE_MAGIC);
  if (bytes.length < magic.length + 4 || !magic.every((b, i) => bytes[i] === b)) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length);
  if (length > APP_BUNDLE_LIMITS.manifestBytes || bytes.length < magic.length + 4 + length) return null;
  const manifestBytes = bytes.subarray(magic.length + 4, magic.length + 4 + length);
  try {
    const manifest = JSON.parse(utf8Decode(manifestBytes)) as Partial<AppManifest>;
    const ref = typeof manifest.publisher === "string" && typeof manifest.name === "string" ? appRef(manifest.publisher, manifest.name) : "";
    if (!isAppRef(ref) || typeof manifest.sequence !== "number" || !Number.isSafeInteger(manifest.sequence)) return null;
    return { ref, sequence: manifest.sequence, digest: appDigest(manifestBytes) };
  } catch { return null; }
}

export class Apps {
  private readonly staged = new Map<string, Staged>();
  /** Bundles read back and checked, by digest: the one running is read once, not on every `file`. */
  private readonly verified = new Map<string, AppBundle>();
  /** Bytes used per `ref\0scope`, counted once from the rows and kept in step by the writes here. */
  private readonly usage = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking: Promise<AppCheckResult[]> | null = null;
  /** Runs the person started with Run anyway (`<ref> <digest>`), for this engine's life: a removal does not cut them off. */
  private readonly anyway = new Set<string>();
  private stopped = false;

  constructor(private readonly host: AppsHost) {}

  private now(): number { return (this.host.now ?? Date.now)(); }
  private nowS(): number { return Math.floor(this.now() / 1000); }

  // ---------- life ----------

  /** Preloads the default stores (no request), then checks for updates soon after start and every 24 hours. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.seedDefaults();
    this.schedule(APP_CHECK_TIMINGS.afterStartMs, true);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number, atStart = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void (async () => {
        if (this.stopped) return;
        if (this.host.online()) {
          const apps = await this.installed();
          const fresh = atStart && apps.length > 0 && apps.every((a) => a.checkedAt !== undefined && this.now() - a.checkedAt < APP_CHECK_TIMINGS.freshMs);
          // No app installed: no request, to a store or anywhere (WISP 1200 § Updates and rollback, "When").
          if (apps.length && !fresh) await this.checkUpdates().catch(() => {});
        }
        if (!this.stopped) this.schedule(APP_CHECK_TIMINGS.everyMs);
      })();
    }, ms);
  }

  private async seedDefaults(): Promise<void> {
    for (const d of this.host.defaults ?? DEFAULT_APP_STORES) {
      if (!isAppKey(d.key) || !isAppFetchUrl(d.url)) continue;
      if (await this.storeRecord(d.key)) continue;
      await this.putStore({ key: d.key, url: d.url, addedAt: this.now(), preloaded: true });
    }
  }

  // ---------- records ----------

  private async installed(): Promise<InstalledApp[]> {
    return wrap((await store(STORES.apps, "readonly")).getAll());
  }
  private async app(ref: string): Promise<InstalledApp | undefined> {
    return wrap((await store(STORES.apps, "readonly")).get(ref));
  }
  private async installedOrFail(ref: unknown): Promise<InstalledApp> {
    if (!isAppRef(ref)) fail("bad-ref", "Not an app reference");
    return (await this.app(ref)) ?? fail("not-installed", "This app is not installed");
  }

  /**
   * An installed app that may still run (WISP 1200 § Takedowns): a running app whose version its publisher revoked, or
   * a store of the person's removed (unless this run was started with Run anyway), is cut off with `stopped`, whether
   * or not the page stops its frame.
   */
  private async stillRunnable(app: InstalledApp): Promise<InstalledApp> {
    const run = this.runStatus(app, await this.stores(), app.revocations);
    if (run.status === "revoked") fail("stopped", "Its publisher revoked this version");
    if (run.status === "removed" && !this.anyway.has(`${app.ref} ${app.digest}`)) fail("stopped", `Removed by ${run.by[0]!.name}: ${run.by[0]!.reason}`);
    return app;
  }

  private async runningOrFail(ref: unknown): Promise<InstalledApp> {
    return this.stillRunnable(await this.installedOrFail(ref));
  }

  /**
   * Before an app's frames go to a contact (`appOpen`, `appSend`): refused with `stopped` as its storage is. A reference
   * not installed here (a bot that speaks an app's messages) is not this store's to refuse.
   */
  async chatRunnable({ ref }: { ref: string }): Promise<void> {
    const app = isAppRef(ref) ? await this.app(ref) : undefined;
    if (app) await this.stillRunnable(app);
  }
  private async putApp(app: InstalledApp): Promise<void> {
    await wrap((await store(STORES.apps, "readwrite")).put(app));
  }
  private async storeRecord(key: string): Promise<AddedAppStore | undefined> {
    return wrap((await store(STORES.appStores, "readonly")).get(key));
  }
  private async putStore(record: AddedAppStore): Promise<void> {
    await wrap((await store(STORES.appStores, "readwrite")).put(record));
  }
  /** The stores the person has (a removed default is not one). */
  private async stores(): Promise<AddedAppStore[]> {
    const all = await wrap<AddedAppStore[]>((await store(STORES.appStores, "readonly")).getAll());
    return all.filter((s) => !s.removed);
  }

  private storeViews(stores: AddedAppStore[]): AppStoreView[] {
    return stores.filter((s) => s.index).map((s) => ({ key: s.key, name: s.index!.name, kind: s.index!.kind, removed: s.index!.removed, revoked: s.index!.revoked }));
  }

  private listedBy(ref: string, stores: AddedAppStore[]): AppListedBy[] {
    return stores.filter((s) => s.index?.apps.some((a) => a.ref === ref)).map((s) => ({ key: s.key, name: s.index!.name, kind: s.index!.kind }));
  }

  private runStatus(version: AppVersion, stores: AddedAppStore[], revocations: readonly SignedAppRevocation[] = []): AppRunStatus {
    const check = checkAppBeforeRun(version, this.storeViews(stores), revocations);
    if (check.status === "revoked") return { status: "revoked", ...(check.revocation.statement.reason && { reason: check.revocation.statement.reason }) };
    return check;
  }

  // ---------- bundle bytes ----------

  /**
   * Stores a bundle's bytes. A browser that keeps no files fails here: Safari's Private Browsing (and WebKit's in-memory
   * contexts) refuses a Blob in IndexedDB with "Error preparing Blob/File data to be stored in object store". Any such
   * failure is `storage`, with the browser's own words after it for the logs, and leaves no piece behind.
   */
  private async writeBundle(digest: string, bytes: Uint8Array): Promise<FileBytesKind> {
    const id = bundleId(digest);
    const expected = toBase64Url(sha256(bytes));
    let files: FileBytes | undefined;
    let stored: string | null;
    try {
      files = await fileBytes();
      const size = await files.size(id);
      if (size === bytes.length && (await files.digest(id)) === expected) return files.kind;
      if (size !== null) await files.remove(id);
      for (let at = 0; at < bytes.length; at += FILE_BYTES_STEP) await files.append(id, at, bytes.subarray(at, at + FILE_BYTES_STEP));
      await files.flush(id);
      await files.close(id);
      stored = await files.digest(id);
    } catch (e) {
      await files?.close(id).catch(() => {});
      await files?.remove(id).catch(() => {});
      const words = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.warn("[apps] storage:", words);
      fail("storage", `The app's files could not be stored on this device (${words})`);
    }
    if (stored !== expected) {
      await files.remove(id).catch(() => {});
      fail("storage", "The app's files could not be stored on this device");
    }
    return files.kind;
  }

  private async readBundleBytes(kind: FileBytesKind, digest: string): Promise<Uint8Array | null> {
    const files = await fileBytesOf(kind);
    const id = bundleId(digest);
    const size = files ? await files.size(id) : null;
    if (!files || size === null || size > APP_BUNDLE_LIMITS.bundleBytes) return null;
    const out = new Uint8Array(size);
    for (let at = 0; at < size;) {
      const part = await files.read(id, at, Math.min(FILE_BYTES_STEP, size - at));
      if (!part.length) return null;
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  private async hasBundle(kind: FileBytesKind, digest: string): Promise<boolean> {
    const files = await fileBytesOf(kind);
    return !!files && (await files.size(bundleId(digest))) !== null;
  }

  private async removeBundle(kind: FileBytesKind, digest: string): Promise<void> {
    this.verified.delete(digest);
    await (await fileBytesOf(kind))?.remove(bundleId(digest)).catch(() => {});
  }

  /** The installed bundle read back and checked again before it runs (WISP 1200 § Signatures: "again before it runs one"). */
  private async verifiedBundle(app: InstalledApp): Promise<AppBundle> {
    const kept = this.verified.get(app.digest);
    if (kept) return kept;
    const bytes = await this.readBundleBytes(app.bytes, app.digest);
    if (!bytes) fail("needs-files", "This app's files are not on this device yet");
    const read = readAppBundle(bytes);
    if (!read.ok || read.bundle.digest !== app.digest) fail("damaged", "This app's stored files do not match what was installed");
    if (this.verified.size >= 2) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(app.digest, read.bundle);
    return read.bundle;
  }

  // ---------- network ----------

  private async fetchBundle(url: string): Promise<{ bundle: AppBundle; bytes: Uint8Array }> {
    const bytes = await this.host.fetch(url, { maxBytes: APP_BUNDLE_LIMITS.bundleBytes });
    const read = readAppBundle(bytes);
    if (!read.ok) fail(read.reason, `This is not an app Ghostly can install${read.detail ? ` (${read.detail})` : ""}`);
    return { bundle: read.bundle, bytes };
  }

  private async readStoreAt(url: string, heldKey?: string) {
    const [indexBytes, sigBytes] = await Promise.all([
      this.host.fetch(url, { maxBytes: APP_FETCH_LIMITS.storeIndexBytes }),
      this.host.fetch(besideUrl(url, "ghostly-store.sig"), { maxBytes: APP_FETCH_LIMITS.sigBytes }),
    ]);
    return readAppStore(indexBytes, sigBytes, this.nowS(), heldKey);
  }

  /** The revocations its publisher signed, read beside each URL (`ghostly-revoke.json`); none there is not an error. */
  private async readRevocations(ref: string, urls: string[]): Promise<SignedAppRevocation[]> {
    const out: SignedAppRevocation[] = [];
    for (const url of new Set(urls.filter(isAppFetchUrl).map((u) => besideUrl(u, "ghostly-revoke.json")))) {
      try {
        const read = readAppRevocations(await this.host.fetch(url, { maxBytes: APP_FETCH_LIMITS.revocationsBytes }));
        if (read.ok) out.push(...read.revocations.filter((r) => r.statement.app === ref));
      } catch { /* not published there, or not reachable now */ }
    }
    return out;
  }

  // ---------- stores ----------

  private summary(s: AddedAppStore): AppStoreSummary {
    const index = s.index;
    return {
      key: s.key, fingerprint: appFingerprint(s.key), url: s.url, preloaded: !!s.preloaded,
      ...(index && { name: index.name, kind: index.kind, sequence: index.sequence, expires: index.expires, ...(index.description !== undefined && { description: index.description }) }),
      expired: !!index && index.expires < this.nowS(),
      ...(s.fetchedAt !== undefined && { fetchedAt: s.fetchedAt }),
      apps: index?.apps ?? [],
      removed: index?.removed ?? [],
      ...(s.equivocation && { equivocation: { sequence: s.equivocation.sequence, at: s.equivocation.at } }),
      ...(s.problem && { problem: s.problem }),
    };
  }

  async listStores(): Promise<AppStoreSummary[]> {
    return (await this.stores()).sort((a, b) => a.addedAt - b.addedAt).map((s) => this.summary(s));
  }

  private storeUrl(url: unknown): string {
    return (typeof url === "string" && appPasteUrl(url, "ghostly-store.json")) || notReadable(url, "Stores are read only from raw.githubusercontent.com, or from cdn.jsdelivr.net at a commit, over HTTPS");
  }

  /** Reads a store at a URL for the person to see before adding it. Nothing is kept. */
  async previewStore({ url }: { url: string }): Promise<AppStorePreview> {
    const at = this.storeUrl(url);
    const read = await this.readStoreAt(at);
    if (!read.ok) fail(read.reason, "This is not a store Ghostly can read");
    const { index } = read.store;
    return {
      url: at, key: index.key, fingerprint: appFingerprint(index.key), name: index.name, kind: index.kind, sequence: index.sequence,
      expires: index.expires, expired: read.store.expired, apps: index.apps.length, ...(index.description !== undefined && { description: index.description }),
    };
  }

  /**
   * Adds a store the person chose: read at its URL and pinned to its key (`key`, when given, is the key the person saw,
   * and another one is refused). A store already added under that key takes the URL and the newer index.
   */
  async addStore({ url, key }: { url: string; key?: string }): Promise<AppStoreSummary> {
    if (key !== undefined && !isAppKey(key)) fail("store-key", "Not a store key");
    const at = this.storeUrl(url);
    const read = await this.readStoreAt(at, key);
    if (!read.ok) fail(read.reason, "This is not a store Ghostly can read");
    const { index, digest } = read.store;
    const held = await this.storeRecord(index.key);
    const record: AddedAppStore = held && !held.removed ? { ...held, url: at } : { key: index.key, url: at, addedAt: this.now(), ...(held?.preloaded && { preloaded: true as const }) };
    await this.putStore(this.withIndex(record, index, digest));
    return this.summary((await this.storeRecord(index.key))!);
  }

  /** The update rule for indexes (WISP 1200 § Stores): a lower `sequence` or the same one with other bytes is refused, the held one kept. */
  private withIndex(record: AddedAppStore, index: AppStoreIndex, digest: string): AddedAppStore {
    const held = record.index ? { key: record.key, sequence: record.index.sequence, digest: record.digest ?? "" } : null;
    const decision = appStoreDecision(held, { key: index.key, sequence: index.sequence, digest });
    const { problem: _problem, ...rest } = record;
    switch (decision) {
      case "new": case "update": { const { equivocation: _e, ...clean } = rest; return { ...clean, index, digest, fetchedAt: this.now() }; }
      case "same": return { ...rest, fetchedAt: this.now() };
      case "rollback": return { ...rest, problem: "rollback" };
      case "equivocation": return { ...rest, equivocation: { sequence: index.sequence, digest, at: this.now() }, problem: "equivocation" };
      default: return { ...rest, problem: "store-key" };
    }
  }

  async removeStore({ key }: { key: string }): Promise<void> {
    const held = await this.storeRecord(key);
    if (!held) return;
    if (held.preloaded) await this.putStore({ key: held.key, url: held.url, addedAt: held.addedAt, preloaded: true, removed: true });
    else await wrap((await store(STORES.appStores, "readwrite")).delete(key));
  }

  /** Reads one store again, or every store (the person opened the Apps page, or the update check). */
  async refreshStores({ key }: { key?: string } = {}): Promise<AppStoreSummary[]> {
    const stores = (await this.stores()).filter((s) => key === undefined || s.key === key);
    if (key !== undefined && !stores.length) fail("no-store", "No such store");
    const out: AppStoreSummary[] = [];
    for (const s of stores) {
      let next: AddedAppStore;
      try {
        const read = await this.readStoreAt(s.url, s.key);
        next = read.ok ? this.withIndex(s, read.store.index, read.store.digest) : { ...s, problem: read.reason };
      } catch (error) {
        next = { ...s, problem: error instanceof AppFetchError ? error.code : "network" };
      }
      // Removed meanwhile: not put back.
      if (!(await this.storeRecord(s.key)) || (await this.storeRecord(s.key))?.removed) continue;
      await this.putStore(next);
      out.push(this.summary(next));
    }
    return out;
  }

  // ---------- install ----------

  /**
   * Fetches an app and checks it, for the install screen: from a pasted URL, a store's listing (its URLs in order) or a
   * chat card's pointer. A store's or a card's `sequence` and digest must hold: the same app, and that version or a newer
   * one. Nothing is stored: the checked bundle waits in memory for `install`.
   */
  async preview(source: AppSource): Promise<AppPreview> {
    let urls: string[];
    let expect: { ref: string; sequence?: number; digest?: string } | null = null;
    if ("url" in source) {
      urls = [(typeof source.url === "string" && appPasteUrl(source.url, "app.ghostlyapp")) || notReadable(source.url, "Apps are read only from raw.githubusercontent.com, or from cdn.jsdelivr.net at a commit, over HTTPS")];
    } else if ("store" in source) {
      const s = await this.storeRecord(source.store);
      const listing = s && !s.removed ? s.index?.apps.find((a) => a.ref === source.ref) : undefined;
      if (!listing) fail("not-listed", "This store does not list this app");
      urls = listing.urls.filter(isAppFetchUrl);
      expect = { ref: listing.ref, sequence: listing.sequence, digest: listing.digest };
    } else if ("card" in source && source.card) {
      const { ref, url, sequence, digest } = source.card;
      if (!isAppRef(ref)) fail("bad-ref", "Not an app reference");
      // A card's URL is on the list or refused (WISP 1200 § Apps sent in a chat): no request goes anywhere else.
      if (!isAppFetchUrl(url)) fail("host", "A card's app is read only from raw.githubusercontent.com, or from cdn.jsdelivr.net at a commit");
      urls = [url];
      expect = { ref, ...(typeof sequence === "number" && { sequence }), ...(typeof digest === "string" && { digest }) };
    } else fail("bad-source", "No app to fetch");
    if (!urls.length) fail("host", "This listing has no URL Ghostly reads from");

    let last: unknown = null;
    for (const url of urls) {
      try {
        const { bundle, bytes } = await this.fetchBundle(url);
        const version = versionOf(bundle.manifest, bundle.digest);
        if (expect) {
          if (version.ref !== expect.ref) fail("other-app", "The URL holds another app");
          if (expect.sequence !== undefined && version.sequence < expect.sequence) fail("rollback", "The URL holds an older version than the one named");
          if (expect.sequence === version.sequence && expect.digest !== undefined && expect.digest !== version.digest) fail("equivocation", "The URL holds another version under the same number");
        }
        return this.stage(bundle, bytes, url);
      } catch (error) { last = error; }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private async stage(bundle: AppBundle, bytes: Uint8Array, from: string): Promise<AppPreview> {
    for (const [digest, s] of this.staged) if (this.now() - s.at > STAGED.ms) this.staged.delete(digest);
    this.staged.delete(bundle.digest);
    while (this.staged.size >= STAGED.max) this.staged.delete(this.staged.keys().next().value!);
    this.staged.set(bundle.digest, { bundle, bytes, from, at: this.now() });

    const { manifest, digest } = bundle;
    const version = versionOf(manifest, digest);
    const [installed, stores] = await Promise.all([this.app(version.ref), this.stores()]);
    const decision = installed ? appUpdateDecision(installed, version) : "new";
    const install = decision === "other-app" ? "new" : decision;
    const asks = install === "new" ? [...manifest.permissions] : install === "update" ? manifest.permissions.filter((p) => !installed!.permissions.includes(p)) : [];
    const listedBy = this.listedBy(version.ref, stores);
    return {
      digest, ref: version.ref, publisher: manifest.publisher, fingerprint: appFingerprint(manifest.publisher), manifest, from,
      icon: bundle.files.get("icon.png")?.slice() ?? null,
      install, asks,
      run: this.runStatus(version, stores, installed?.revocations),
      listedBy, unknownPublisher: !listedBy.some((s) => s.kind === "curated"),
    };
  }

  /**
   * Installs the bundle `preview` fetched, once the person pressed Install: `grant` must hold every permission it asks
   * for (WISP 1200 § Permissions: none is granted by a store or a contact). A revoked or removed version is not
   * installed; neither is a rollback, nor another bundle under an installed `sequence` (marked on the app).
   */
  async install({ digest, grant }: { digest: string; grant: string[] }): Promise<InstalledAppView> {
    const staged = this.staged.get(digest);
    if (!staged || this.now() - staged.at > STAGED.ms) { this.staged.delete(digest); fail("expired", "Fetch the app again"); }
    const { bundle, bytes, from } = staged;
    const { manifest } = bundle;
    if (!Array.isArray(grant) || !manifest.permissions.every((p) => grant.includes(p))) fail("permissions", "Every permission the app asks for must be granted");
    const version = versionOf(manifest, digest);
    const [installed, stores] = await Promise.all([this.app(version.ref), this.stores()]);
    const run = this.runStatus(version, stores, installed?.revocations);
    if (run.status === "revoked") fail("revoked", "Its publisher revoked this version");
    if (run.status === "removed") fail("removed", `Removed by ${run.by[0]!.name}: ${run.by[0]!.reason}`);
    const pendingClash = installed?.pending && installed.pending.sequence === version.sequence && installed.pending.digest !== digest;
    const decision = installed ? (pendingClash ? "equivocation" : appUpdateDecision(installed, version)) : "new";
    if (decision === "rollback") fail("rollback", "A newer version of this app is installed");
    if (decision === "equivocation") {
      await this.putApp({ ...installed!, equivocation: { sequence: version.sequence, digest, at: this.now() } });
      fail("equivocation", `Two different versions ${version.sequence} exist. Ghostly kept the one you have.`);
    }
    if (decision === "same" && installed) {
      // A restored profile's app that needs its files gets them back.
      if (!(await this.hasBundle(installed.bytes, digest))) await this.putApp({ ...installed, bytes: await this.writeBundle(digest, bytes) });
      this.staged.delete(digest);
      return this.view((await this.app(version.ref))!, stores);
    }
    const kind = await this.writeBundle(digest, bytes);
    const next = this.versionRecord(installed, bundle, kind, from);
    await this.putApp(next);
    if (installed && installed.digest !== digest) await this.removeBundle(installed.bytes, installed.digest);
    if (installed?.pending && installed.pending.sequence <= version.sequence && installed.pending.digest !== digest) await this.removeBundle(installed.pending.bytes, installed.pending.digest);
    this.staged.delete(digest);
    return this.view(next, stores);
  }

  /** The record of a version installed now, keeping what the app had (its revocations, a newer version waiting). */
  private versionRecord(installed: InstalledApp | undefined, bundle: AppBundle, kind: FileBytesKind, from: string): InstalledApp {
    const { manifest, digest } = bundle;
    const now = this.now();
    const keepPending = installed?.pending && installed.pending.sequence > manifest.sequence ? installed.pending : undefined;
    return {
      ref: appRef(manifest.publisher, manifest.name), publisher: manifest.publisher, name: manifest.name,
      sequence: manifest.sequence, digest, permissions: [...manifest.permissions], manifest, bytes: kind, from,
      installedAt: installed?.installedAt ?? now, updatedAt: now,
      ...(installed?.revocations?.length && { revocations: installed.revocations }),
      // A mark at a number this version passed is over: what was installed then is not any more.
      ...(installed?.equivocation && installed.equivocation.sequence >= manifest.sequence && { equivocation: installed.equivocation }),
      ...(keepPending && { pending: keepPending }),
      ...(installed?.checkedAt !== undefined && { checkedAt: installed.checkedAt }),
    };
  }

  /** The person accepted the permissions a waiting update adds: it is installed now. */
  async acceptUpdate({ ref }: { ref: string }): Promise<InstalledAppView> {
    const installed = await this.installedOrFail(ref);
    const pending = installed.pending ?? fail("no-update", "No update waits for this app");
    const bytes = await this.readBundleBytes(pending.bytes, pending.digest);
    const read = bytes ? readAppBundle(bytes) : null;
    if (!read?.ok || read.bundle.digest !== pending.digest) {
      const { pending: _p, ...rest } = installed;
      await this.putApp(rest);
      fail("needs-files", "The update's files are gone; it is fetched again at the next check");
    }
    const stores = await this.stores();
    const run = this.runStatus(versionOf(read.bundle.manifest, pending.digest), stores, installed.revocations);
    if (run.status === "revoked") fail("revoked", "Its publisher revoked this version");
    if (run.status === "removed") fail("removed", `Removed by ${run.by[0]!.name}: ${run.by[0]!.reason}`);
    const plan = planAppUpdate(installed, { ...versionOf(read.bundle.manifest, pending.digest), permissions: read.bundle.manifest.permissions });
    if (plan.action === "refuse") fail(plan.decision, "This update can no longer be installed");
    const { pending: _p, ...without } = installed;
    const next = this.versionRecord(without, read.bundle, pending.bytes, pending.from);
    await this.putApp(next);
    await this.removeBundle(installed.bytes, installed.digest);
    return this.view(next, stores);
  }

  // ---------- updates ----------

  /**
   * The update check (WISP 1200 § Updates and rollback): only with an app installed; every store read again, then each
   * app's newer versions looked for in the stores' listings and its manifest's `sources`, and its publisher's
   * revocations read beside its sources. An update that keeps or drops permissions installs by itself; one that adds
   * some waits for the person. One check at a time.
   */
  checkUpdates(): Promise<AppCheckResult[]> {
    this.checking ??= this.checkNow().then((results) => {
      // A version found removed or revoked stops where it runs: the pages hear of every check, the scheduled one too.
      try { this.host.checked?.(results); } catch { /* a page's listener */ }
      return results;
    }).finally(() => { this.checking = null; });
    return this.checking;
  }

  private async checkNow(): Promise<AppCheckResult[]> {
    const apps = await this.installed();
    if (!apps.length) return [];
    await this.refreshStores();
    const stores = await this.stores();
    const out: AppCheckResult[] = [];
    for (const listed of apps) {
      if (!(await this.hasBundle(listed.bytes, listed.digest))) await this.fetchFiles({ ref: listed.ref }).catch(() => {});
      const first = await this.app(listed.ref);
      if (!first) continue;
      let app = first;
      let outcome: AppCheckOutcome = "none";
      const highest = Math.max(app.sequence, app.pending?.sequence ?? 0);
      const known = new Set([app.digest, ...(app.pending ? [app.pending.digest] : [])]);
      // Stores first (they name the version), then the publisher's own sources.
      const candidates: string[] = [];
      for (const s of stores) {
        const listing = s.index?.apps.find((a) => a.ref === app.ref);
        if (listing && (listing.sequence > highest || (listing.sequence >= app.sequence && !known.has(listing.digest)))) candidates.push(...listing.urls.filter(isAppFetchUrl));
      }
      for (const url of (app.manifest.sources ?? []).filter(isAppFetchUrl)) {
        try {
          const peek = peekAppManifest(await this.host.fetch(url, { maxBytes: PEEK_BYTES, peek: true }));
          if (peek && peek.ref === app.ref && (peek.sequence > highest || (peek.sequence >= app.sequence && !known.has(peek.digest)))) candidates.push(url);
        } catch { /* this source does not answer now */ }
      }
      for (const url of new Set(candidates)) {
        let fetched: { bundle: AppBundle; bytes: Uint8Array };
        try { fetched = await this.fetchBundle(url); } catch { continue; }
        const { bundle, bytes } = fetched;
        const version = versionOf(bundle.manifest, bundle.digest);
        if (version.ref !== app.ref || known.has(version.digest)) continue;
        if (app.pending && version.sequence === app.pending.sequence) {
          app = { ...app, equivocation: { sequence: version.sequence, digest: version.digest, at: this.now() } };
          outcome = "equivocation";
          continue;
        }
        const plan = planAppUpdate(app, { ...version, permissions: bundle.manifest.permissions });
        if (plan.action === "refuse") {
          if (plan.decision === "equivocation") { app = { ...app, equivocation: { sequence: version.sequence, digest: version.digest, at: this.now() } }; outcome = "equivocation"; }
          continue;
        }
        if (this.runStatus(version, stores, app.revocations).status !== "ok") continue;
        if (app.pending && version.sequence < app.pending.sequence) continue;
        const kind = await this.writeBundle(version.digest, bytes);
        if (plan.action === "install") {
          const old = app;
          app = this.versionRecord(app, bundle, kind, url);
          if (old.pending && old.pending.sequence <= version.sequence) { await this.removeBundle(old.pending.bytes, old.pending.digest); delete app.pending; }
          await this.putApp(app);
          await this.removeBundle(old.bytes, old.digest);
          outcome = "updated";
        } else {
          if (app.pending) await this.removeBundle(app.pending.bytes, app.pending.digest);
          app = { ...app, pending: { sequence: version.sequence, digest: version.digest, manifest: bundle.manifest, added: plan.added as AppPermission[], bytes: kind, from: url, at: this.now() } };
          outcome = "ask";
        }
        break;
      }
      const revocations = await this.readRevocations(app.ref, [app.from, ...(app.manifest.sources ?? [])]);
      const merged = new Map((app.revocations ?? []).map((r) => [canonicalJson(r), r]));
      for (const r of revocations) merged.set(canonicalJson(r), r);
      // Removed meanwhile: not put back.
      if (!(await this.app(app.ref))) continue;
      app = { ...app, ...(merged.size && { revocations: [...merged.values()] }), checkedAt: this.now() };
      await this.putApp(app);
      out.push({ ref: app.ref, outcome, run: await this.runCheckOf(app, stores) });
    }
    return out;
  }

  // ---------- files again (a restored profile) ----------

  /**
   * Fetches an installed app's bundle again when it is not on this device (a profile restored from a backup, which
   * carries the installed list but no bundle: WISP 1200 § Where installed apps live). Only the installed digest is
   * taken, checked whole: from the URL it was installed from, the listings of the person's stores that name that digest,
   * then its `sources`. Nothing answers: it stays `needs-files`, and it never runs unchecked.
   */
  async fetchFiles({ ref }: { ref: string }): Promise<AppRunStatus> {
    const app = await this.installedOrFail(ref);
    const stores = await this.stores();
    if (await this.hasBundle(app.bytes, app.digest)) return this.runCheckOf(app, stores);
    const urls = [app.from];
    for (const s of stores) for (const listing of s.index?.apps ?? []) if (listing.ref === app.ref && listing.digest === app.digest) urls.push(...listing.urls);
    urls.push(...(app.manifest.sources ?? []));
    for (const url of new Set(urls.filter(isAppFetchUrl))) {
      let fetched: { bundle: AppBundle; bytes: Uint8Array };
      try { fetched = await this.fetchBundle(url); } catch { continue; }
      if (fetched.bundle.digest !== app.digest) continue;
      const kind = await this.writeBundle(app.digest, fetched.bytes);
      // Uninstalled meanwhile: its files go again.
      const now = await this.app(app.ref);
      if (!now || now.digest !== app.digest) { await this.removeBundle(kind, app.digest); fail("not-installed", "This app is not installed"); }
      if (now.bytes !== kind) await this.putApp({ ...now, bytes: kind });
      return this.runCheckOf({ ...now, bytes: kind }, stores);
    }
    return { status: "needs-files" };
  }

  // ---------- running ----------

  private async runCheckOf(app: InstalledApp, stores: AddedAppStore[]): Promise<AppRunStatus> {
    if (!(await this.hasBundle(app.bytes, app.digest))) return { status: "needs-files" };
    return this.runStatus(app, stores, app.revocations);
  }

  /** Before an app runs (WISP 1200 § Takedowns): revoked stops it, removed by a store of the person's warns. No request. */
  async runCheck({ ref }: { ref: string }): Promise<AppRunStatus> {
    return this.runCheckOf(await this.installedOrFail(ref), await this.stores());
  }

  /**
   * What the runner writes into its frame: the entry, from the bundle read back and checked again. A revoked version
   * never runs; one a store removed runs only when the person chose "Run anyway" (`runAnyway`).
   */
  async entry({ ref, runAnyway }: { ref: string; runAnyway?: boolean }): Promise<AppRunEntry> {
    let app = await this.installedOrFail(ref);
    let run = await this.runCheckOf(app, await this.stores());
    // Opened with its files missing (a restored profile): fetched again by digest first, or not run.
    if (run.status === "needs-files") { run = await this.fetchFiles({ ref }); app = await this.installedOrFail(ref); }
    if (run.status === "revoked") fail("revoked", "Its publisher revoked this version");
    if (run.status === "removed" && runAnyway !== true) fail("removed", `Removed by ${run.by[0]!.name}: ${run.by[0]!.reason}`);
    if (run.status === "needs-files") fail("needs-files", "This app's files are not on this device yet");
    if (run.status === "removed") this.anyway.add(`${app.ref} ${app.digest}`);
    const bundle = await this.verifiedBundle(app);
    const entry = bundle.files.get(bundle.manifest.entry) ?? fail("damaged", "The entry is missing");
    return { ref: app.ref, digest: app.digest, version: app.manifest.version, title: app.manifest.title, permissions: [...app.permissions], view: appViewOf(bundle.manifest), entry: utf8Decode(entry) };
  }

  /** A file of the installed bundle, for the broker's `file` (`ghostly.file(path)`). */
  async file({ ref, path }: { ref: string; path: string }): Promise<Uint8Array> {
    // Its icon still shows on the Apps page and in chats once it is stopped: a picture the publisher signed, nothing more.
    const app = path === "icon.png" ? await this.installedOrFail(ref) : await this.runningOrFail(ref);
    const bundle = await this.verifiedBundle(app);
    if (typeof path !== "string" || !bundle.files.has(path)) fail("no-file", "No such file in this app");
    return bundle.files.get(path)!.slice();
  }

  // ---------- views ----------

  private async view(app: InstalledApp, stores: AddedAppStore[]): Promise<InstalledAppView> {
    const { manifest } = app;
    const listedBy = this.listedBy(app.ref, stores);
    return {
      ref: app.ref, name: app.name, publisher: app.publisher, fingerprint: appFingerprint(app.publisher),
      title: manifest.title, tagline: manifest.tagline, ...(manifest.description !== undefined && { description: manifest.description }),
      version: manifest.version, sequence: app.sequence, digest: app.digest, permissions: [...app.permissions], view: appViewOf(manifest),
      from: app.from, icon: manifest.files.some((f) => f.path === "icon.png"),
      installedAt: app.installedAt, updatedAt: app.updatedAt,
      run: await this.runCheckOf(app, stores), listedBy, unknownPublisher: !listedBy.some((s) => s.kind === "curated"),
      ...(app.pending && { pending: { sequence: app.pending.sequence, version: app.pending.manifest.version, added: [...app.pending.added] } }),
      ...(app.equivocation && { equivocation: { sequence: app.equivocation.sequence, at: app.equivocation.at } }),
      ...(app.checkedAt !== undefined && { checkedAt: app.checkedAt }),
    };
  }

  async list(): Promise<InstalledAppView[]> {
    const [apps, stores] = await Promise.all([this.installed(), this.stores()]);
    return Promise.all(apps.sort((a, b) => a.installedAt - b.installedAt).map((a) => this.view(a, stores)));
  }

  // ---------- uninstall ----------

  /**
   * Uninstalls an app: its bundle (and a waiting update's), its record and its storage in every scope. The person chose
   * it, after the offer of an export (`exportData`).
   */
  async uninstall({ ref }: { ref: string }): Promise<void> {
    const app = await this.installedOrFail(ref);
    const tx = (await openDb()).transaction([STORES.apps, STORES.appStorage], "readwrite");
    tx.objectStore(STORES.apps).delete(app.ref);
    tx.objectStore(STORES.appStorage).delete(rowsOf(app.ref));
    await done(tx);
    for (const key of [...this.usage.keys()]) if (key.startsWith(`${app.ref}\0`)) this.usage.delete(key);
    await this.removeBundle(app.bytes, app.digest);
    if (app.pending) await this.removeBundle(app.pending.bytes, app.pending.digest);
  }

  // ---------- storage ----------

  private scopeOf(scope: unknown): string {
    if (scope === APP_SCOPE_ALONE || (typeof scope === "string" && this.host.isChat(scope))) return scope as string;
    fail("bad-scope", "Not a chat of this profile");
  }

  private keyOf(key: unknown): string {
    if (typeof key !== "string" || !key.length || byteLength(key) > APP_STORAGE_LIMITS.keyBytes) fail("bad-key", "A key is 1 to 256 bytes of text");
    return key;
  }

  /** One scope's writes, one after another, so the count of bytes used stays true. */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => {});
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return run;
  }

  private async usageOf(ref: string, scope: string): Promise<number> {
    const id = `${ref}\0${scope}`;
    let used = this.usage.get(id);
    if (used === undefined) {
      const rows = await wrap<AppStorageRow[]>((await store(STORES.appStorage, "readonly")).index(APP_STORAGE_SCOPE_INDEX).getAll([ref, scope]));
      used = rows.reduce((sum, r) => sum + r.size, 0);
      this.usage.set(id, used);
    }
    return used;
  }

  async storageGet({ ref, scope, key }: { ref: string; scope: string; key: string }): Promise<{ value: JsonValue } | null> {
    const app = await this.runningOrFail(ref);
    const row = await wrap<AppStorageRow | undefined>((await store(STORES.appStorage, "readonly")).get([app.ref, this.scopeOf(scope), this.keyOf(key)]));
    return row ? { value: JSON.parse(row.value) as JsonValue } : null;
  }

  /** Keeps a JSON value under a key: at most 64 KiB, and 5 MiB for every key of this app in this scope. */
  async storageSet({ ref, scope, key, value }: { ref: string; scope: string; key: string; value: unknown }): Promise<void> {
    const app = await this.runningOrFail(ref);
    const where = this.scopeOf(scope), name = this.keyOf(key);
    let text: string | undefined;
    try { text = JSON.stringify(value); } catch { text = undefined; }
    if (typeof text !== "string") fail("bad-value", "A value is JSON");
    const valueBytes = byteLength(text);
    if (valueBytes > APP_STORAGE_LIMITS.valueBytes) fail("too-large", "A value is at most 64 KiB");
    const size = byteLength(name) + valueBytes;
    await this.serial(`${app.ref}\0${where}`, async () => {
      const used = await this.usageOf(app.ref, where);
      const rows = await store(STORES.appStorage, "readonly");
      const old = await wrap<AppStorageRow | undefined>(rows.get([app.ref, where, name]));
      const next = used - (old?.size ?? 0) + size;
      if (next > APP_STORAGE_LIMITS.scopeBytes) fail("full", "This app's storage in this chat is full (5 MiB)");
      await wrap((await store(STORES.appStorage, "readwrite")).put({ ref: app.ref, scope: where, key: name, value: text, size } satisfies AppStorageRow));
      this.usage.set(`${app.ref}\0${where}`, next);
    });
  }

  async storageDelete({ ref, scope, key }: { ref: string; scope: string; key: string }): Promise<void> {
    const app = await this.runningOrFail(ref);
    const where = this.scopeOf(scope), name = this.keyOf(key);
    await this.serial(`${app.ref}\0${where}`, async () => {
      const used = await this.usageOf(app.ref, where);
      const old = await wrap<AppStorageRow | undefined>((await store(STORES.appStorage, "readonly")).get([app.ref, where, name]));
      if (!old) return;
      await wrap((await store(STORES.appStorage, "readwrite")).delete([app.ref, where, name]));
      this.usage.set(`${app.ref}\0${where}`, used - old.size);
    });
  }

  async storageKeys({ ref, scope }: { ref: string; scope: string }): Promise<string[]> {
    const app = await this.runningOrFail(ref);
    const keys = await wrap((await store(STORES.appStorage, "readonly")).getAllKeys(rowsOf(app.ref, this.scopeOf(scope)))) as [string, string, string][];
    return keys.map((k) => k[2]);
  }

  /** An app's storage in every scope, as export files (WISP 1200 § Where installed apps live), offered before an uninstall. */
  async exportData({ ref }: { ref: string }): Promise<AppDataExport[]> {
    const app = await this.installedOrFail(ref);
    const rows = await wrap<AppStorageRow[]>((await store(STORES.appStorage, "readonly")).getAll(rowsOf(app.ref)));
    const scopes = new Map<string, AppDataExport>();
    for (const row of rows) {
      const out = scopes.get(row.scope) ?? { ghostlyAppData: 1 as const, app: app.ref, scope: row.scope, entries: {} };
      out.entries[row.key] = JSON.parse(row.value) as JsonValue;
      scopes.set(row.scope, out);
    }
    return [...scopes.values()];
  }
}
