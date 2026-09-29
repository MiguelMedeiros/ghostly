import { BACKUP_MEDIA_TYPE, MAX_BACKUP_BYTES } from "./envelope";
import { createdFromName, HELD_MEDIA_TYPE, type HoldStore, type StoredBackup } from "./storage";

/** WISP 1002. Kept in the profile's local settings; never inside a bundle. */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", (typeof data === "string" ? new TextEncoder().encode(data) : data) as BufferSource));
async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const imported = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(data)));
}
/** RFC 3986, as SigV4 wants it: everything but unreserved characters percent-encoded. */
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for one request. Returns the headers to send; `host` is signed but set by the
 * platform. The payload hash is always computed, never `UNSIGNED-PAYLOAD`.
 */
export async function signS3(request: { method: string; url: URL; headers?: Record<string, string>; body?: Uint8Array }, credentials: { region: string; accessKeyId: string; secretAccessKey: string }, now = new Date()): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(request.body ?? new Uint8Array());
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: request.url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const canonicalPath = request.url.pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/");
  const canonicalQuery = [...request.url.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [request.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [credentials.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  const { host: _host, ...sent } = headers;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/**
 * AWS Signature Version 4 in the query string (a presigned URL): the request's authorization travels
 * in the URL, so whoever holds it can make exactly this request until it expires. The payload is
 * `UNSIGNED-PAYLOAD`, as AWS defines for presigned URLs; `host` is the only signed header.
 */
export async function presignS3(request: { method: string; url: URL; expiresSeconds: number }, credentials: { region: string; accessKeyId: string; secretAccessKey: string }, now = new Date()): Promise<string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const url = new URL(request.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(request.expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonicalPath = url.pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/");
  const canonicalQuery = [...url.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [request.method, canonicalPath, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [credentials.region, "s3", "aws4_request"]) key = await hmac(key, part);
  url.searchParams.set("X-Amz-Signature", hex(await hmac(key, toSign)));
  return url.toString();
}

/** Checks a configuration before anything is stored with it. */
export function validateS3Config(config: S3Config): S3Config {
  const endpoint = config.endpoint.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Enter the endpoint as a URL, like https://s3.amazonaws.com"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("Use an HTTPS endpoint (HTTP only for a local test server)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Put credentials in their own fields, not in the endpoint");
  const bucket = config.bucket.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Bucket names are 3–63 lowercase letters, digits, dots and dashes");
  const prefix = config.prefix.trim().replace(/^\/+/, "");
  if (prefix && (!/^[A-Za-z0-9!_.*'()/-]{1,200}$/.test(prefix) || prefix.replace(/\/$/, "").split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("Use letters, digits and / - _ . in the prefix");
  if (!config.accessKeyId.trim() || !config.secretAccessKey.trim()) throw new Error("Enter the access key and its secret");
  return { endpoint, region: config.region.trim() || "us-east-1", bucket, prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix, accessKeyId: config.accessKeyId.trim(), secretAccessKey: config.secretAccessKey.trim() };
}

/** Object names stay inside this app's own folders: `<space>/backups/<file>` or `<space>/hold/<mailbox>/<file>`, nothing that climbs out. */
const OBJECT_NAME = /^[a-z2-7]{16}\/(?:backups|hold\/[A-Za-z0-9_-]{22})\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const FOLDER_NAME = /^[a-z2-7]{16}\/(?:backups|hold\/[A-Za-z0-9_-]{22})\/$/;
/** Presigned URLs live seven days at most (SigV4). */
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;
function checkName(name: string): string {
  if (!OBJECT_NAME.test(name) || name.includes("..")) throw new Error("Not a Ghostly backup name");
  return name;
}
const LIST_PAGES = 100;
const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Any S3-compatible service, path-style, straight from the client (WISP 1002). */
export class S3Store implements HoldStore {
  private readonly config: S3Config;
  constructor(config: S3Config, private readonly fetcher: typeof fetch = (...args) => fetch(...args)) { this.config = validateS3Config(config); }
  get description() { return `S3 · ${this.config.bucket}${this.config.prefix ? `/${this.config.prefix.replace(/\/$/, "")}` : ""}`; }

  private url(key = "", query?: Record<string, string>): URL {
    const url = new URL(`${this.config.endpoint}/${this.config.bucket}${key ? `/${key.split("/").map(encode).join("/")}` : ""}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }
  private async send(method: string, url: URL, body?: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    const signed = await signS3({ method, url, headers, body }, this.config);
    let response: Response;
    try { response = await this.fetcher(url, { method, headers: signed, body: body as BodyInit | undefined }); }
    catch { throw new Error(`Could not reach ${new URL(this.config.endpoint).host}: offline, or the bucket's CORS rules do not allow this app`); }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1], message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
      throw new Error(`S3 refused (${response.status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`);
    }
    return response;
  }

  async put(name: string, bytes: Uint8Array): Promise<void> { await this.send("PUT", this.url(this.config.prefix + checkName(name)), bytes, { "content-type": name.endsWith(".ghostly-held") ? HELD_MEDIA_TYPE : BACKUP_MEDIA_TYPE }); }
  /**
   * A URL that reads one object with no credential until `seconds` from now: what an away contact is
   * handed to pick up what was held for it (WISP 4xx). The secret key never leaves this device; the
   * signature covers the exact object, method and lifetime, so the URL reads that object and nothing else.
   */
  async presign(name: string, seconds: number): Promise<string> {
    const url = this.url(this.config.prefix + checkName(name));
    return presignS3({ method: "GET", url, expiresSeconds: Math.min(Math.max(1, Math.floor(seconds)), MAX_PRESIGN_SECONDS) }, this.config);
  }
  listFolder(space: string, mailbox: string): Promise<StoredBackup[]> { return this.listUnder(`${space}/hold/${mailbox}/`); }
  async get(name: string): Promise<Uint8Array> {
    const response = await this.send("GET", this.url(this.config.prefix + checkName(name)));
    const limit = Math.ceil(MAX_BACKUP_BYTES * 1.4);
    if (Number(response.headers.get("content-length")) > limit) throw new Error("This backup is too large to restore");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("This backup is too large to restore");
    return bytes;
  }
  async remove(name: string): Promise<void> { await this.send("DELETE", this.url(this.config.prefix + checkName(name))); }
  list(space: string): Promise<StoredBackup[]> { return this.listUnder(`${space}/backups/`); }
  private async listUnder(under: string): Promise<StoredBackup[]> {
    if (!FOLDER_NAME.test(under) || under.includes("..")) throw new Error("Not a Ghostly backup name");
    const folder = `${this.config.prefix}${under}`;
    const found: StoredBackup[] = [];
    let token: string | undefined;
    for (let page = 0; page < LIST_PAGES; page++) {
      const query: Record<string, string> = { "list-type": "2", prefix: folder };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.send("GET", this.url("", query))).text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = unescapeXml(/<Key>([^<]+)<\/Key>/.exec(entry)?.[1] ?? "");
        // Only what is in this space's folder, under a name this app could have written.
        if (!key.startsWith(folder)) continue;
        const name = key.slice(this.config.prefix.length);
        if (!OBJECT_NAME.test(name) || name.includes("..")) continue;
        found.push({ name, size: Number(/<Size>(\d+)<\/Size>/.exec(entry)?.[1]) || undefined, modified: Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(entry)?.[1] ?? "") || undefined, created: createdFromName(name) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
      if (!token) break;
    }
    return found.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Writes, reads back, lists and removes a small probe: proof the place works before a backup relies on it. */
  async test(space: string): Promise<void> {
    const name = `${space}/backups/probe-${Date.now()}.txt`, bytes = new TextEncoder().encode("ghostly storage probe");
    await this.put(name, bytes);
    const back = await this.get(name);
    if (new TextDecoder().decode(back) !== "ghostly storage probe") throw new Error("S3 returned different bytes than were stored");
    const listing = await this.send("GET", this.url("", { "list-type": "2", prefix: `${this.config.prefix}${space}/backups/probe-` }));
    if (!(await listing.text()).includes("probe-")) throw new Error("S3 did not list the object just stored");
    await this.remove(name).catch(() => {});
  }
}
