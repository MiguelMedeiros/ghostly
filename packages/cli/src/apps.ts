import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  APP_BUNDLE_LIMITS, APP_PREFIXES, appFingerprint, appRef, appStoreDecision, assembleAppBundle, canonicalJson, canonicalJsonBytes,
  APP_STATEMENT_LIMITS, checkAppManifest, checkAppRevokeStatement, checkAppStoreIndex, fromBase64Url, isAppUrl, readAppBundle,
  readAppRevocations, readAppStore, seedSigner, signAppObject, signAppRevocation, signAppStore, toBase64Url, toZ32, type AppBundle,
  type AppManifest, type AppRevokeStatement, type AppStoreIndex, type SignedAppRevocation, type Signer,
} from "@ghostly/core";
import { CliError } from "./errors";

/*
 * The publisher tools of WISP 1200 (Apps · Publishing): `app publish` bundles and signs a folder, `app verify` checks a
 * bundle as a client would, `store sign` signs a store index. They run here, on files: no profile, no daemon, no
 * network but the one read `app verify` makes of a URL.
 *
 * Keys. A publisher key and a store key are Ed25519 keys of their own, never a profile's (WISP 1200 · Publisher
 * identity). Each lives in a file the command names with `--key`: a PKCS #8 PEM block (what `openssl genpkey -algorithm
 * ed25519` writes, so secret scanners know it for a private key), after one line that says which kind it is. The file
 * is made owner-only (0600) when a command makes it, and refused when anyone else may read it. A key is never printed:
 * only its public key and fingerprint are.
 */

export const APP_SOURCE = "ghostly-app.json";
export const APP_BUNDLE_FILE = "app.ghostlyapp";
export const APP_REVOKE_FILE = "ghostly-revoke.json";
export const STORE_INDEX_FILE = "ghostly-store.json";
export const STORE_SIG_FILE = "ghostly-store.sig";

/** How long `app verify` waits for a URL, and how many redirects it follows (each checked as the first). */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

// ---------- keys ----------

export type KeyKind = "publisher" | "store";

const KEY_HEADER: Record<KeyKind, string> = {
  publisher: "Ghostly publisher key (WISP 1200). Secret: never share or commit it. Back it up: an app signed with it is updated only with it.",
  store: "Ghostly store key (WISP 1200). Secret: keep it offline, never share or commit it. Back it up: a store is its key.",
};
const PEM = /-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----/;

export interface LoadedKey { signer: Signer; key: string; created: boolean }

/** Refuses a key file that is not a plain file of this user's, or that anyone else may read or write. */
function checkKeyFile(path: string): void {
  const info = statSync(path);
  if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file: --key names a key file`);
  if (process.platform === "win32") return;
  if (process.getuid && info.uid !== process.getuid()) throw new CliError("refused", `${path} is not this user's: a key file must be yours alone`);
  if ((info.mode & 0o077) !== 0) {
    throw new CliError("refused", `${path} may be read by others (mode ${(info.mode & 0o777).toString(8)}): run chmod 600 ${path}, and think whether the key was seen`);
  }
}

/** Reads a key file: the PEM block, an Ed25519 key, and the kind its first line names (when it names one). */
function readKey(path: string, kind: KeyKind): LoadedKey {
  checkKeyFile(path);
  const text = readFileSync(path, "utf8");
  const other: KeyKind = kind === "publisher" ? "store" : "publisher";
  if (text.startsWith(`Ghostly ${other} key`)) {
    throw new CliError("refused", `${path} is a ${other} key: ${kind === "publisher" ? "a store key never signs an app" : "a publisher key never signs a store index"} (WISP 1200 · Stores)`);
  }
  const block = PEM.exec(text);
  let seed: Uint8Array | undefined;
  if (block) {
    try {
      const key = createPrivateKey(block[0]);
      const d = key.asymmetricKeyType === "ed25519" ? key.export({ format: "jwk" }).d : undefined;
      if (d) seed = fromBase64Url(d);
    } catch { /* said below, without the file's text */ }
  }
  if (!seed || seed.length !== 32) throw new CliError("bad_request", `${path} holds no Ed25519 private key (a PEM "PRIVATE KEY" block, as openssl genpkey -algorithm ed25519 writes)`);
  const signer = seedSigner(seed);
  return { signer, key: toZ32(signer.publicKey), created: false };
}

/** Makes a key file: owner-only from the start, never over a file that is there. */
function makeKey(path: string, kind: KeyKind): LoadedKey {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, `${KEY_HEADER[kind]}\n${pem}`); } finally { closeSync(fd); }
  return { ...readKey(path, kind), created: true };
}

/** What the person is told on stderr when a key was made: where, which, and to back it up. Never the key. */
function madeKeyNote(path: string, kind: KeyKind, key: string): string {
  return kind === "publisher"
    ? `new publisher key written to ${path}; back it up (${appFingerprint(key)}: an app is updated only with the key that signed it, and phase 1 has no recovery)`
    : `new store key written to ${path}; back it up and keep it offline (${appFingerprint(key)}: a store is its key)`;
}

// ---------- reading bundles ----------

const refused = (what: string, reading: { reason: string; detail?: string }, extra: Record<string, unknown> = {}) =>
  new CliError("refused", `${what} (${reading.reason}${reading.detail ? `: ${reading.detail}` : ""})`, { reason: reading.reason, ...(reading.detail ? { detail: reading.detail } : {}), ...extra });

/** A bundle file's bytes: its size is checked before it is read, so a huge file is refused unread. */
function readBundleFile(path: string): Uint8Array {
  const info = statSync(path);
  if (info.isDirectory()) throw new CliError("bad_request", `${path} is a folder: name a .ghostlyapp file`);
  if (info.size > APP_BUNDLE_LIMITS.bundleBytes) throw refused(`${path} is not a valid bundle`, { reason: "too-large", detail: `${info.size} bytes` });
  return new Uint8Array(readFileSync(path));
}

/**
 * A bundle at an https URL, as a client fetches one: `https:` only, no user or password, jsDelivr only at a full
 * commit (WISP 1200 · Manifest, "Every URL"); every redirect is held to the same rule, and the download stops past
 * 16 MiB.
 */
async function fetchBundle(url: string): Promise<Uint8Array> {
  let at = url;
  for (let hop = 0; ; hop++) {
    if (!isAppUrl(at)) {
      throw new CliError(hop ? "refused" : "usage", hop
        ? `${url} redirects to ${at}, which a client does not read (https only, no user or password, jsDelivr only at a full commit)`
        : `Not a URL a client reads: https only, at most ${APP_BUNDLE_LIMITS.url} characters, no user or password, and jsDelivr only as https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40-hex commit>/<path>`);
    }
    let response: Response;
    try {
      response = await fetch(at, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new CliError("timeout", `${at} did not answer in ${FETCH_TIMEOUT_MS / 1000} s`);
      throw new CliError("unavailable", `Could not read ${at}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new CliError("refused", `${url} redirects more than ${MAX_REDIRECTS} times`);
      at = new URL(response.headers.get("location")!, at).href;
      continue;
    }
    if (response.status === 404 || response.status === 410) { await response.body?.cancel(); throw new CliError("not_found", `${at} answered ${response.status}`); }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new CliError("unavailable", `${at} answered ${response.status}`); }
    const limit = APP_BUNDLE_LIMITS.bundleBytes;
    const tooLarge = (bytes: number | string) => refused(`${url} is not a valid bundle`, { reason: "too-large", detail: `${bytes} bytes` });
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) { await response.body.cancel(); throw tooLarge(length); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) { await reader.cancel(); throw tooLarge(`more than ${limit}`); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error && error.name === "TimeoutError") throw new CliError("timeout", `${at} did not finish in ${FETCH_TIMEOUT_MS / 1000} s`);
      throw new CliError("unavailable", `Could not read ${at}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }
}

/** What a checked bundle is, as `app verify` and `app publish` print it. */
function described(bundle: AppBundle, bytes: Uint8Array) {
  const m = bundle.manifest;
  return {
    ref: appRef(m.publisher, m.name), publisher: m.publisher, fingerprint: appFingerprint(m.publisher), name: m.name,
    title: m.title, version: m.version, sequence: m.sequence, digest: bundle.digest, bytes: bytes.length,
    sha256: toBase64Url(createHash("sha256").update(bytes).digest()),
  };
}

/** `app verify <bundle|url>`: every check a client makes before it stores a bundle (WISP 1200 · Reading a bundle). */
export async function verifyApp(source: string): Promise<Record<string, unknown>> {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
  const bytes = isUrl ? await fetchBundle(source) : readBundleFile(resolve(source));
  const read = readAppBundle(bytes);
  if (!read.ok) throw refused(`${source} is not a valid bundle`, read);
  return { valid: true, ...described(read.bundle, bytes), manifest: read.bundle.manifest };
}

// ---------- publishing ----------

/** Every file of the folder, as the bundle names it; dot files and folders are left out and listed. */
function collectFiles(dir: string, leaveOut: Set<string>): { files: { path: string; full: string; size: number }[]; skipped: string[] } {
  const files: { path: string; full: string; size: number }[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const full = join(folder, name);
      const path = relative(dir, full).split(sep).join("/");
      if (leaveOut.has(full)) continue;
      if (name.startsWith(".")) { skipped.push(path); continue; }
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new CliError("bad_request", `${path} is a link: a bundle holds the folder's own files (copy it in, or remove it)`);
      if (info.isDirectory()) { walk(full); continue; }
      if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file`);
      files.push({ path, full, size: info.size });
      bytes += info.size;
      if (files.length > APP_BUNDLE_LIMITS.files) throw refused(`${dir} holds more files than a bundle may`, { reason: "too-many-files", detail: `more than ${APP_BUNDLE_LIMITS.files}` });
      if (bytes > APP_BUNDLE_LIMITS.bundleBytes) throw refused(`${dir} holds more than a bundle may`, { reason: "too-large", detail: `more than ${APP_BUNDLE_LIMITS.bundleBytes} bytes of files` });
    }
  };
  walk(dir);
  return { files, skipped };
}

/** Fields of `ghostly-app.json` the command writes itself. */
const WRITTEN = ["publisher", "files"] as const;

function readSource(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new CliError("not_found", `No ${APP_SOURCE} in ${dirname(path)}: it holds the manifest's fields (name, version, title, tagline, entry, permissions, runtime, license, ...) but publisher, sequence and files, which publish writes`);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new CliError("bad_request", `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("bad_request", `${path} is not a JSON object`);
  const draft = value as Record<string, unknown>;
  const written = WRITTEN.filter((k) => k in draft);
  if (written.length) throw new CliError("bad_request", `${path} has ${written.join(" and ")}: publish writes ${written.length > 1 ? "them" : "it"} from the key and the folder's files`);
  if (draft.ghostlyApp !== undefined && draft.ghostlyApp !== 1) throw refused(`${path} is not a manifest this release makes`, { reason: "unsupported-format", detail: "ghostlyApp is not 1" });
  if (draft.sequence !== undefined && !(Number.isSafeInteger(draft.sequence) && (draft.sequence as number) >= 1)) {
    throw new CliError("bad_request", `${path}: sequence is a whole number from 1 (or leave it out: publish raises it by itself)`);
  }
  return draft;
}

/** Writes a file whole or not at all: a reader never sees half a bundle (and a dot file left by a crash is never bundled). */
function writeWhole(path: string, bytes: Uint8Array): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

/**
 * `app publish <dir> --key <file> [--out <file>]`: `<dir>/ghostly-app.json` (the manifest without `publisher`,
 * `sequence` and `files`) and every other file in `<dir>` become one signed bundle, by default `<dir>/app.ghostlyapp`.
 * The sequence is `--sequence` (higher than the bundle already at `--out`'s), else one more than that bundle's (or
 * the source's `sequence`, if higher, else 1). The
 * key file is made when it is missing and no earlier bundle is there to update.
 */
export async function publishApp(dirArg: string, keyArg: string, outArg?: string, sequenceArg?: number): Promise<Record<string, unknown>> {
  if (sequenceArg !== undefined && !(Number.isSafeInteger(sequenceArg) && sequenceArg >= 1)) throw new CliError("usage", `--sequence takes a whole number from 1, not ${sequenceArg}`);
  const dir = resolve(dirArg);
  if (!statSync(dir).isDirectory()) throw new CliError("bad_request", `${dir} is not a folder`);
  const keyPath = resolve(keyArg);
  const out = resolve(outArg ?? join(dir, APP_BUNDLE_FILE));
  const sourcePath = join(dir, APP_SOURCE);
  const draft = readSource(sourcePath);

  // The version this one follows: the bundle already at the output, which only its own key may follow.
  let previous: AppManifest | null = null;
  if (existsSync(out)) {
    const read = readAppBundle(readBundleFile(out));
    if (!read.ok) throw refused(`${out} is there and is not a valid bundle: move it away, or name another --out`, read);
    previous = read.bundle.manifest;
  }

  let key: LoadedKey;
  if (existsSync(keyPath)) key = readKey(keyPath, "publisher");
  else if (previous) {
    throw new CliError("not_found", `No key file ${keyPath}: ${out} is signed by ${appFingerprint(previous.publisher)}, and only that key publishes its next version`);
  } else key = makeKey(keyPath, "publisher");

  if (previous && previous.publisher !== key.key) {
    throw refused(`${out} is ${appRef(previous.publisher, previous.name)}, signed by another key (${appFingerprint(previous.publisher)}): a version of an app is signed by its own key`, { reason: "other-app" }, { publisher: previous.publisher });
  }
  if (previous && previous.name !== draft.name) {
    throw refused(`${out} is the app ${JSON.stringify(previous.name)}, not ${JSON.stringify(draft.name)}: name another --out for another app`, { reason: "other-app" });
  }

  if (sequenceArg !== undefined && previous && sequenceArg <= previous.sequence) {
    throw refused(`--sequence ${sequenceArg} is not higher than the ${previous.sequence} of ${out}: every client refuses a lower one, and the same one with other content is equivocation`, { reason: sequenceArg < previous.sequence ? "rollback" : "equivocation" }, { previous: previous.sequence });
  }
  const sequence = sequenceArg ?? Math.max(previous ? previous.sequence + 1 : 1, (draft.sequence as number | undefined) ?? 1);
  const { files, skipped } = collectFiles(dir, new Set([sourcePath, out, join(dir, APP_REVOKE_FILE)]));
  const contents = files.map((f) => ({ path: f.path, bytes: new Uint8Array(readFileSync(f.full)) }));
  const manifest = {
    ...draft,
    ghostlyApp: 1,
    publisher: key.key,
    sequence,
    files: contents.map((f) => ({ path: f.path, size: f.bytes.length, sha256: toBase64Url(createHash("sha256").update(f.bytes).digest()) })),
  };
  const checked = checkAppManifest(JSON.parse(JSON.stringify(manifest)));
  if (!checked.ok) throw refused(`${sourcePath} and the folder's files make no valid manifest`, checked);

  const { bytes: manifestBytes, signature } = await signAppObject(APP_PREFIXES.app, checked.manifest, key.signer);
  const bundle = assembleAppBundle(manifestBytes, canonicalJsonBytes(signature), contents.map((f) => f.bytes));
  // Read back as a client would (the icon's header, the bundle's size): what is written is never a bundle it refuses.
  const read = readAppBundle(bundle);
  if (!read.ok) throw refused("The bundle made is not valid", read);
  mkdirSync(dirname(out), { recursive: true });
  writeWhole(out, bundle);

  return {
    ...described(read.bundle, bundle),
    previous: previous?.sequence ?? null,
    out,
    files: contents.map((f) => f.path),
    ...(skipped.length ? { skipped } : {}),
    keyCreated: key.created,
    ...(key.created ? { warning: madeKeyNote(keyPath, "publisher", key.key) } : {}),
  };
}

// ---------- revocations ----------

/**
 * `app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>] [--bundle <file>]`: a
 * `ghostly-revoke/1` statement (WISP 1200 · Publisher keys, Revocation) for the app whose bundle is `<dir>/app.ghostlyapp`
 * (or `--bundle`), signed by that app's publisher key and added to `<dir>/ghostly-revoke.json`, which stays canonical.
 * The key is never made here: only the key that signed the app may revoke its versions.
 */
export async function revokeApp(dirArg: string, keyArg: string, what: { digests?: string[]; upTo?: number; reason?: string; bundle?: string }): Promise<Record<string, unknown>> {
  const dir = resolve(dirArg);
  const bundlePath = resolve(what.bundle ?? join(dir, APP_BUNDLE_FILE));
  const listPath = join(dir, APP_REVOKE_FILE);
  const usage = "ghostly app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>]";
  const digests = what.digests ?? [];
  if ((digests.length > 0) === (what.upTo !== undefined)) throw new CliError("usage", `Give --digest (again for each) or --up-to, one of the two: ${usage}`);
  if (what.upTo !== undefined && !(Number.isSafeInteger(what.upTo) && what.upTo >= 1)) throw new CliError("usage", `--up-to takes a sequence, a whole number from 1, not ${what.upTo}`);

  if (!existsSync(bundlePath)) throw new CliError("not_found", `No bundle ${bundlePath}: a revocation names the app of the bundle in <dir> (or --bundle)`);
  const read = readAppBundle(readBundleFile(bundlePath));
  if (!read.ok) throw refused(`${bundlePath} is not a valid bundle`, read);
  const manifest = read.bundle.manifest;
  const ref = appRef(manifest.publisher, manifest.name);

  const keyPath = resolve(keyArg);
  if (!existsSync(keyPath)) throw new CliError("not_found", `No key file ${keyPath}: only the key that signed ${ref} (${appFingerprint(manifest.publisher)}) revokes its versions`);
  const key = readKey(keyPath, "publisher");
  if (key.key !== manifest.publisher) {
    throw refused(`${keyPath} is not the publisher key of ${ref} (${appFingerprint(manifest.publisher)}): a revocation by any other key is refused by every client`, { reason: "signature-key" });
  }

  const statement = (digests.length
    ? { ghostlyRevoke: 1, app: ref, digests }
    : { ghostlyRevoke: 1, app: ref, upTo: what.upTo }) as AppRevokeStatement;
  if (what.reason !== undefined) statement.reason = what.reason;
  const problem = checkAppRevokeStatement(statement);
  if (problem) throw refused("Not a revocation a client reads", { reason: "bad-revocation", detail: problem });

  let list: SignedAppRevocation[] = [];
  if (existsSync(listPath)) {
    const held = readAppRevocations(new Uint8Array(readFileSync(listPath)));
    if (!held.ok) throw refused(`${listPath} is there and is not a valid ghostly-revoke.json: fix or move it first`, held);
    list = held.revocations;
  }
  const signed = await signAppRevocation(statement, key.signer);
  const same = list.some((r) => canonicalJson(r.statement) === canonicalJson(signed.statement));
  if (!same) {
    if (list.length >= APP_STATEMENT_LIMITS.revocations) throw refused(`${listPath} holds ${list.length} revocations already`, { reason: "bad-revocation", detail: `at most ${APP_STATEMENT_LIMITS.revocations}` });
    list = [...list, signed];
    const bytes = canonicalJsonBytes(list);
    const check = readAppRevocations(bytes);
    if (!check.ok) throw refused("The revocation list made is not valid", check);
    writeWhole(listPath, bytes);
  }
  const covers = digests.length
    ? { digests, current: digests.includes(read.bundle.digest) }
    : { upTo: what.upTo, current: manifest.sequence <= what.upTo! };
  return { app: ref, ...covers, ...(what.reason !== undefined ? { reason: what.reason } : {}), added: !same, revocations: list.length, file: listPath };
}

// ---------- store indexes ----------

/**
 * `store sign <index> --key <file> [--out <dir>]`: a store index written by hand (any JSON layout; `key` may be left
 * out and is then the signing key's) becomes `ghostly-store.json`, canonical, and `ghostly-store.sig`, in `--out` or
 * beside the index. It is read back as a client reads it (`expires` at most 90 days ahead), and refused when the index
 * already there, signed by the same key, has a higher `sequence`, or the same one with other content.
 */
export async function signStore(indexArg: string, keyArg: string, outArg?: string, now = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
  const indexPath = resolve(indexArg);
  const keyPath = resolve(keyArg);
  const outDir = resolve(outArg ?? dirname(indexPath));
  let value: unknown;
  try { value = JSON.parse(readFileSync(indexPath, "utf8")); } catch (error) {
    if (error instanceof SyntaxError) throw new CliError("bad_request", `${indexPath} is not JSON: ${error.message}`);
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("bad_request", `${indexPath} is not a JSON object`);
  const index = value as Record<string, unknown>;

  let key: LoadedKey;
  if (existsSync(keyPath)) key = readKey(keyPath, "store");
  else if (index.key !== undefined) throw new CliError("not_found", `No key file ${keyPath}: the index names the store key ${typeof index.key === "string" ? appFingerprint(index.key) : JSON.stringify(index.key)}`);
  else key = makeKey(keyPath, "store");
  if (index.key !== undefined && index.key !== key.key) {
    throw refused(`${indexPath} names another store key than ${keyPath}'s (${appFingerprint(key.key)})`, { reason: "store-key" });
  }
  index.key = key.key;

  const checked = checkAppStoreIndex(index);
  if (!checked.ok) throw refused(`${indexPath} is not a valid store index`, checked);
  const { indexBytes, sigBytes } = await signAppStore(index as unknown as AppStoreIndex, key.signer);
  const read = readAppStore(indexBytes, sigBytes, now, key.key);
  if (!read.ok) throw refused(`${indexPath} would be refused by a client`, read);
  const store = read.store;

  // The index this one follows, when the folder holds one this key signed.
  const indexOut = join(outDir, STORE_INDEX_FILE), sigOut = join(outDir, STORE_SIG_FILE);
  let previous: number | null = null;
  if (existsSync(indexOut) && existsSync(sigOut)) {
    const held = readAppStore(new Uint8Array(readFileSync(indexOut)), new Uint8Array(readFileSync(sigOut)), now);
    if (held.ok && held.store.index.key === key.key) {
      previous = held.store.index.sequence;
      const decision = appStoreDecision(
        { key: key.key, sequence: held.store.index.sequence, digest: held.store.digest },
        { key: key.key, sequence: store.index.sequence, digest: store.digest },
      );
      if (decision === "rollback" || decision === "equivocation") {
        throw refused(`${indexOut} already holds sequence ${held.store.index.sequence} of this store: ${decision === "rollback" ? "a lower one is refused by every client" : "the same one with other content is refused as equivocation"}; raise sequence`, { reason: decision }, { held: held.store.index.sequence });
      }
    }
  }

  mkdirSync(outDir, { recursive: true });
  writeWhole(indexOut, indexBytes);
  writeWhole(sigOut, sigBytes);
  const notes = [
    ...(key.created ? [madeKeyNote(keyPath, "store", key.key)] : []),
    ...(store.expired ? [`expires (${new Date(store.index.expires * 1000).toISOString()}) is past: clients still install from it and say the store was not updated since then`] : []),
  ];
  return {
    key: key.key, fingerprint: appFingerprint(key.key), name: store.index.name, kind: store.index.kind,
    sequence: store.index.sequence, previous, expires: store.index.expires, expired: store.expired,
    apps: store.index.apps.length, removed: store.index.removed.length, revoked: store.index.revoked.length,
    digest: store.digest, index: indexOut, sig: sigOut, keyCreated: key.created,
    ...(notes.length ? { warning: notes.join("; ") } : {}),
  };
}
