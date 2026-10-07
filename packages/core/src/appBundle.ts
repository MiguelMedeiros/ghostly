import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, toZ32, utf8Encode } from "./bytes";
import { canonicalJsonBytes, readCanonicalJson, type JsonValue } from "./canonicalJson";
import { imageSize } from "./image";
import {
  APP_NAME, APP_PREFIXES, isAppHash, isAppKey, readAppSignature, signAppObject, verifyAppSignature, type AppSignature,
} from "./appStatements";
import type { Signer } from "./signer";

/*
 * The app bundle (WISP 1200 · The package): one `.ghostlyapp` file is one version of one app.
 *
 *     "GHOSTLYAPP1" | u32 manifest length | manifest | u32 statement length | signature statement | file bytes...
 *
 * Lengths are 32-bit big-endian. The manifest is canonical JSON (RFC 8785); the statement is the publisher's
 * `ghostly-app/1` signature over it; the files follow in the order of the manifest's `files`, delimited by their sizes,
 * and nothing follows the last one. The digest, SHA-256 of the manifest's bytes, names every byte of the version.
 *
 * `readAppBundle` is the whole client check, in a fixed order so that every parser refuses a broken bundle with the same
 * reason: size, magic, the two lengths, the manifest (JSON, canonical, every field and bound), the statement, the
 * bundle's length against the files' sizes, the signature, every file's hash, then the icon. A client runs it before it
 * stores a bundle and again before it runs one.
 */

export const APP_BUNDLE_MAGIC = "GHOSTLYAPP1";
const MAGIC = utf8Encode(APP_BUNDLE_MAGIC);

export const APP_BUNDLE_LIMITS = {
  /** The whole bundle, phase 1. */
  bundleBytes: 16 * 1024 * 1024,
  files: 64,
  manifestBytes: 64 * 1024,
  /** A path, in bytes (paths are ASCII). */
  pathBytes: 128,
  iconBytes: 256 * 1024,
  screenshots: 8,
  /** Lengths in Unicode code points. */
  title: 40,
  tagline: 80,
  description: 2000,
  releaseNotes: 500,
  version: 64,
  license: 128,
  /** An https URL, in characters. */
  url: 512,
  sources: 8,
} as const;

export const APP_ICON_PATH = "icon.png";
export const APP_SCREENSHOTS_DIR = "screenshots/";
const SCREENSHOT_TYPES = /\.(png|jpg|webp)$/;

/**
 * The permissions of phase 1 (WISP 1200 · Permissions). `internet`: the app reaches HTTPS and WSS servers of its
 * choosing (the client runs it in its network runner); without it, an app has no network.
 */
export const APP_PERMISSIONS = ["chat", "internet", "name"] as const;
export type AppPermission = typeof APP_PERMISSIONS[number];
export const APP_CLIENTS = ["web", "desktop", "extension"] as const;
/**
 * Where an app shows (WISP 1200 · Manifest, `view`). `chat`, the default when the manifest has none: inside a 1:1 chat
 * only, beside it on a wide screen. `full`: full screen, alone or from a chat, never beside one.
 */
export const APP_VIEWS = ["chat", "full"] as const;
export type AppViewMode = typeof APP_VIEWS[number];
/** The view of a manifest: `chat` when it names none. */
export const appViewOf = (manifest: { view?: AppViewMode }): AppViewMode => manifest.view ?? "chat";
export type AppClient = typeof APP_CLIENTS[number];

export interface AppFileEntry { path: string; size: number; sha256: string }
export interface AppManifest {
  ghostlyApp: 1;
  publisher: string;
  name: string;
  version: string;
  sequence: number;
  kind: "mini-app";
  title: string;
  tagline: string;
  description?: string;
  entry: string;
  permissions: AppPermission[];
  /** Absent: `chat` (`appViewOf`). */
  view?: AppViewMode;
  runtime: { host: string; clients: AppClient[] };
  license: string;
  sources?: string[];
  proofs?: never[];
  homepage?: string;
  support?: string;
  releaseNotes?: string;
  files: AppFileEntry[];
}

const REQUIRED = ["ghostlyApp", "publisher", "name", "version", "sequence", "kind", "title", "tagline", "entry", "permissions", "runtime", "license", "files"] as const;
const OPTIONAL = ["description", "view", "sources", "proofs", "homepage", "support", "releaseNotes"] as const;
/** Reserved for phase 2 and refused in phase 1. */
const RESERVED = ["price", "recovery"] as const;

export type AppBundleRefusal =
  | "too-large" | "magic" | "truncated" | "trailing-bytes" | "manifest-too-large"
  | "not-json" | "not-canonical" | "unsupported-format" | "unknown-key" | "reserved-key" | "missing-key" | "bad-field"
  | "proofs-unsupported" | "too-many-files" | "bad-path" | "path-collision" | "files-unsorted" | "bad-entry"
  | "too-many-screenshots" | "bad-icon"
  | "bad-signature-statement" | "signature-key" | "bad-signature" | "file-hash";

export type AppManifestCheck = { ok: true; manifest: AppManifest } | { ok: false; reason: AppBundleRefusal; detail?: string };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const HOST = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

const codePoints = (s: string) => [...s].length;
/** One line: no control character. */
const isLine = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && codePoints(v) >= min && codePoints(v) <= max && !/\p{Cc}/u.test(v);
/** Text of several lines: no control character but the line feed. */
const isText = (v: unknown, max: number): v is string => typeof v === "string" && codePoints(v) <= max && !/[^\P{Cc}\n]/u.test(v);
const isSafeCount = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An https URL as WISP 1200 takes one anywhere: at most 512 characters, no user or password, and on jsDelivr only
 * `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40-hex commit>/...`, since a branch, a tag, a range or `latest` is
 * served from a copy that moves.
 */
export function isAppUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > APP_BUNDLE_LIMITS.url || !value.startsWith("https://")) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return false;
  const host = url.hostname.toLowerCase();
  if (host === "jsdelivr.net" || host.endsWith(".jsdelivr.net")) {
    return host === "cdn.jsdelivr.net" && /^\/gh\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\/./.test(url.pathname);
  }
  return true;
}

/**
 * An SPDX license expression, read lightly: identifiers (`MIT`, `GPL-3.0-or-later`, `LicenseRef-x`, `Apache-2.0+`)
 * joined by `AND` and `OR`, `WITH` an exception, and parentheses; or `proprietary`.
 */
export function isAppLicense(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > APP_BUNDLE_LIMITS.license) return false;
  const tokens = value.match(/\(|\)|[^\s()]+/g);
  if (!tokens || tokens.join("").length !== value.replace(/\s/g, "").length) return false;
  let i = 0;
  const id = () => { const t = tokens[i]; if (t && /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/.test(t) && !["AND", "OR", "WITH"].includes(t)) { i++; return true; } return false; };
  const term = (depth: number): boolean => {
    if (tokens[i] === "(") { i++; if (depth > 8 || !expr(depth + 1) || tokens[i] !== ")") return false; i++; return true; }
    if (!id()) return false;
    if (tokens[i] === "WITH") { i++; return id(); }
    return true;
  };
  const expr = (depth: number): boolean => {
    if (!term(depth)) return false;
    while (tokens[i] === "AND" || tokens[i] === "OR") { i++; if (!term(depth)) return false; }
    return true;
  };
  return expr(0) && i === tokens.length;
}

/** A path of a bundle: relative, `/`-separated, `[A-Za-z0-9._-]` per segment, no `.` or `..`, at most 128 bytes. */
export function isAppPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > APP_BUNDLE_LIMITS.pathBytes) return false;
  return value.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
}

const bad = (field: string, detail = `${field} is not valid`): AppManifestCheck => ({ ok: false, reason: "bad-field", detail });

/** Checks a parsed manifest against every rule and bound of WISP 1200 that the manifest alone decides. */
export function checkAppManifest(value: unknown): AppManifestCheck {
  if (!isObject(value)) return bad("manifest", "The manifest is not an object");
  if (value.ghostlyApp !== undefined && value.ghostlyApp !== 1) return { ok: false, reason: "unsupported-format", detail: "ghostlyApp is not 1" };
  for (const key of Object.keys(value)) {
    if ((RESERVED as readonly string[]).includes(key)) return { ok: false, reason: "reserved-key", detail: key };
    if (!(REQUIRED as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key)) return { ok: false, reason: "unknown-key", detail: key };
  }
  for (const key of REQUIRED) if (!(key in value)) return { ok: false, reason: "missing-key", detail: key };
  const m = value;
  if (!isAppKey(m.publisher)) return bad("publisher");
  if (typeof m.name !== "string" || !APP_NAME.test(m.name)) return bad("name");
  if (typeof m.version !== "string" || m.version.length > APP_BUNDLE_LIMITS.version || !SEMVER.test(m.version)) return bad("version");
  if (!isSafeCount(m.sequence, 1)) return bad("sequence");
  if (m.kind !== "mini-app") return bad("kind");
  if (!isLine(m.title, APP_BUNDLE_LIMITS.title, 1)) return bad("title");
  if (!isLine(m.tagline, APP_BUNDLE_LIMITS.tagline, 1)) return bad("tagline");
  if (m.description !== undefined && !isText(m.description, APP_BUNDLE_LIMITS.description)) return bad("description");
  if (m.releaseNotes !== undefined && !isLine(m.releaseNotes, APP_BUNDLE_LIMITS.releaseNotes)) return bad("releaseNotes");
  const permissions = m.permissions;
  if (!Array.isArray(permissions) || new Set(permissions).size !== permissions.length
    || !permissions.every((p) => (APP_PERMISSIONS as readonly unknown[]).includes(p))) return bad("permissions");
  if (m.view !== undefined && !(APP_VIEWS as readonly unknown[]).includes(m.view)) return bad("view", `view is "chat" or "full"`);
  const runtime = m.runtime;
  if (!isObject(runtime) || Object.keys(runtime).length !== 2 || typeof runtime.host !== "string" || !HOST.test(runtime.host)) return bad("runtime");
  const clients = runtime.clients;
  if (!Array.isArray(clients) || clients.length < 1 || new Set(clients).size !== clients.length
    || !clients.every((c) => (APP_CLIENTS as readonly unknown[]).includes(c))) return bad("runtime");
  if (!isAppLicense(m.license)) return bad("license");
  if (m.sources !== undefined && (!Array.isArray(m.sources) || m.sources.length > APP_BUNDLE_LIMITS.sources || !m.sources.every(isAppUrl))) return bad("sources");
  if (m.homepage !== undefined && !isAppUrl(m.homepage)) return bad("homepage");
  if (m.support !== undefined && !isAppUrl(m.support)) return bad("support");
  if (m.proofs !== undefined) {
    if (!Array.isArray(m.proofs)) return bad("proofs");
    if (m.proofs.length > 0) return { ok: false, reason: "proofs-unsupported", detail: "Publisher proofs come after phase 1" };
  }

  const files = m.files;
  if (!Array.isArray(files)) return bad("files");
  if (files.length > APP_BUNDLE_LIMITS.files) return { ok: false, reason: "too-many-files", detail: `${files.length} files` };
  const lower = new Set<string>();
  let previous = "";
  let screenshots = 0;
  for (const f of files) {
    if (!isObject(f) || Object.keys(f).length !== 3 || !isAppPath(f.path) || !isSafeCount(f.size, 0) || !isAppHash(f.sha256)) {
      return isObject(f) && typeof f.path === "string" && !isAppPath(f.path) ? { ok: false, reason: "bad-path", detail: f.path } : bad("files", "A file is not {path, size, sha256}");
    }
    if (lower.has(f.path.toLowerCase())) return { ok: false, reason: "path-collision", detail: f.path };
    lower.add(f.path.toLowerCase());
    if (f.path <= previous) return { ok: false, reason: "files-unsorted", detail: f.path };
    previous = f.path;
    if (f.size > APP_BUNDLE_LIMITS.bundleBytes) return bad("files", `${f.path} is larger than a bundle`);
    if (f.path.startsWith(APP_SCREENSHOTS_DIR)) {
      if (!SCREENSHOT_TYPES.test(f.path)) return { ok: false, reason: "bad-path", detail: `${f.path}: a screenshot is .png, .jpg or .webp` };
      if (++screenshots > APP_BUNDLE_LIMITS.screenshots) return { ok: false, reason: "too-many-screenshots" };
    }
    if (f.path === APP_ICON_PATH && f.size > APP_BUNDLE_LIMITS.iconBytes) return { ok: false, reason: "bad-icon", detail: "icon.png is larger than 256 KiB" };
  }
  const entry = m.entry;
  if (typeof entry !== "string" || !entry.endsWith(".html") || !files.some((f) => isObject(f) && f.path === entry)) {
    return { ok: false, reason: "bad-entry", detail: "The entry is not an .html file of the bundle" };
  }
  return { ok: true, manifest: m as unknown as AppManifest };
}

/** The digest of a version: SHA-256 of its canonical manifest bytes, base64url. */
export function appDigest(manifestBytes: Uint8Array): string {
  return toBase64Url(sha256(manifestBytes));
}

export interface AppBundle {
  manifest: AppManifest;
  /** The manifest's canonical bytes, as in the bundle. */
  manifestBytes: Uint8Array;
  digest: string;
  signature: AppSignature;
  /** Every file's bytes, by path, in the manifest's order (views into the bundle's bytes). */
  files: Map<string, Uint8Array>;
}
export type AppBundleReading = { ok: true; bundle: AppBundle } | { ok: false; reason: AppBundleRefusal; detail?: string };

const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;

/** Reads and checks a bundle (the order of the checks is part of the format: see above). */
export function readAppBundle(bytes: Uint8Array): AppBundleReading {
  if (bytes.length > APP_BUNDLE_LIMITS.bundleBytes) return { ok: false, reason: "too-large" };
  const head = bytes.subarray(0, MAGIC.length);
  if (!head.every((b, i) => b === MAGIC[i])) return { ok: false, reason: "magic" };
  if (head.length < MAGIC.length) return { ok: false, reason: "truncated" };
  let at = MAGIC.length;
  if (bytes.length < at + 4) return { ok: false, reason: "truncated" };
  const manifestLength = u32(bytes, at); at += 4;
  if (manifestLength > APP_BUNDLE_LIMITS.manifestBytes) return { ok: false, reason: "manifest-too-large" };
  if (bytes.length < at + manifestLength + 4) return { ok: false, reason: "truncated" };
  const manifestBytes = bytes.subarray(at, at + manifestLength); at += manifestLength;
  const statementLength = u32(bytes, at); at += 4;
  if (bytes.length < at + statementLength) return { ok: false, reason: "truncated" };
  const statementBytes = bytes.subarray(at, at + statementLength); at += statementLength;

  const read = readCanonicalJson(manifestBytes);
  if (!read.ok) return read;
  const checked = checkAppManifest(read.value);
  if (!checked.ok) return checked;
  const manifest = checked.manifest;

  const statement = readAppSignature(statementBytes);
  if (!statement.ok) return statement;

  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  const rest = bytes.length - at;
  if (total > rest) return { ok: false, reason: "truncated" };
  if (total < rest) return { ok: false, reason: "trailing-bytes", detail: `${rest - total} bytes past the last file` };

  const signed = verifyAppSignature(APP_PREFIXES.app, manifestBytes, statement.signature, manifest.publisher);
  if (!signed.ok) return signed;

  const files = new Map<string, Uint8Array>();
  for (const f of manifest.files) {
    const content = bytes.subarray(at, at + f.size); at += f.size;
    if (toBase64Url(sha256(content)) !== f.sha256) return { ok: false, reason: "file-hash", detail: f.path };
    files.set(f.path, content);
  }
  const icon = files.get(APP_ICON_PATH);
  if (icon) {
    const size = imageSize(icon);
    if (!size || icon[0] !== 0x89 || size.width !== size.height) return { ok: false, reason: "bad-icon", detail: "icon.png is not a square PNG" };
  }
  return { ok: true, bundle: { manifest, manifestBytes, digest: appDigest(manifestBytes), signature: statement.signature, files } };
}

/** Puts a bundle's parts together, checking nothing: for builders, and for tests that need a broken bundle. */
export function assembleAppBundle(manifestBytes: Uint8Array, statementBytes: Uint8Array, files: Uint8Array[]): Uint8Array {
  const total = MAGIC.length + 8 + manifestBytes.length + statementBytes.length + files.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  out.set(MAGIC, at); at += MAGIC.length;
  view.setUint32(at, manifestBytes.length); at += 4;
  out.set(manifestBytes, at); at += manifestBytes.length;
  view.setUint32(at, statementBytes.length); at += 4;
  out.set(statementBytes, at); at += statementBytes.length;
  for (const f of files) { out.set(f, at); at += f.length; }
  return out;
}

/** What a publisher writes: every manifest field but `publisher` and `files`, which the bundle's contents decide. */
export type AppManifestDraft = Omit<AppManifest, "publisher" | "files" | "ghostlyApp"> & { ghostlyApp?: 1 };

/**
 * Builds and signs a bundle: lists the files (sorted, with sizes and hashes), signs the canonical manifest with the
 * publisher's key under `ghostly-app/1`, and reads the result back, so it throws rather than return a bundle a client
 * would refuse.
 */
export async function buildAppBundle(draft: AppManifestDraft, files: { path: string; bytes: Uint8Array }[], signer: Signer): Promise<{ bytes: Uint8Array; digest: string; manifest: AppManifest }> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    ...draft,
    ghostlyApp: 1,
    publisher: toZ32(signer.publicKey),
    files: sorted.map((f) => ({ path: f.path, size: f.bytes.length, sha256: toBase64Url(sha256(f.bytes)) })),
  } as AppManifest;
  const checked = checkAppManifest(JSON.parse(JSON.stringify(manifest)));
  if (!checked.ok) throw new Error(`Not a valid manifest (${checked.reason}${checked.detail ? `: ${checked.detail}` : ""})`);
  const { bytes: manifestBytes, signature } = await signAppObject(APP_PREFIXES.app, manifest, signer);
  const bytes = assembleAppBundle(manifestBytes, canonicalJsonBytes(signature), sorted.map((f) => f.bytes));
  const read = readAppBundle(bytes);
  if (!read.ok) throw new Error(`Not a valid bundle (${read.reason}${read.detail ? `: ${read.detail}` : ""})`);
  return { bytes, digest: read.bundle.digest, manifest: read.bundle.manifest };
}
