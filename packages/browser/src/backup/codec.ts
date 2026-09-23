/** Base64url without padding, in chunks: bundles can be many megabytes. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Invalid base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Tagged = { $ghostly: "bigint" | "bytes" | "blob"; value: string; type?: string };
/** Data that happens to look like a tag (a contact can send anything) travels as its entries instead. */
type Escaped = { $ghostly: "object"; entries: [string, unknown][] };

/**
 * Blobs cannot be read synchronously: turn them into tagged values first, everywhere in the tree. An
 * object of the data's own with a `$ghostly` key is escaped, so it comes back as it was and not as a tag.
 */
async function inlineBlobs(value: unknown): Promise<unknown> {
  if (typeof Blob !== "undefined" && value instanceof Blob) return { $ghostly: "blob", type: value.type, value: toBase64Url(new Uint8Array(await value.arrayBuffer())) } satisfies Tagged;
  if (Array.isArray(value)) return Promise.all(value.map(inlineBlobs));
  if (value && typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await inlineBlobs(v);
    return Object.prototype.hasOwnProperty.call(out, "$ghostly") ? ({ $ghostly: "object", entries: Object.entries(out) } satisfies Escaped) : out;
  }
  return value;
}

/** JSON that also carries what IndexedDB holds: bigints, bytes and blobs (WISP 05). */
export async function encode(value: unknown): Promise<string> {
  return JSON.stringify(await inlineBlobs(value), (_key, v) => {
    if (typeof v === "bigint") return { $ghostly: "bigint", value: String(v) } satisfies Tagged;
    if (v instanceof Uint8Array) return { $ghostly: "bytes", value: toBase64Url(v) } satisfies Tagged;
    if (v instanceof ArrayBuffer) return { $ghostly: "bytes", value: toBase64Url(new Uint8Array(v)) } satisfies Tagged;
    return v;
  });
}
/** Never throws on a tag it cannot read: that value stays as it is, and the rest of the backup restores. */
export function decode(text: string): unknown {
  return JSON.parse(text, (_key, v) => {
    const escaped = v as Partial<Escaped> | null;
    if (escaped && typeof escaped === "object" && escaped.$ghostly === "object" && Array.isArray(escaped.entries)) {
      const out: Record<string, unknown> = {};
      for (const entry of escaped.entries) if (Array.isArray(entry) && typeof entry[0] === "string") Object.defineProperty(out, entry[0], { value: entry[1], enumerable: true, writable: true, configurable: true });
      return out;
    }
    const tag = v as Partial<Tagged> | null;
    if (!tag || typeof tag !== "object" || typeof tag.$ghostly !== "string" || typeof tag.value !== "string") return v;
    if (tag.$ghostly === "bigint") return /^-?\d+$/.test(tag.value) ? BigInt(tag.value) : v;
    if (!/^[A-Za-z0-9_-]*$/.test(tag.value)) return v;
    if (tag.$ghostly === "bytes") return fromBase64Url(tag.value);
    if (tag.$ghostly === "blob") return new Blob([fromBase64Url(tag.value) as BlobPart], { type: typeof tag.type === "string" ? tag.type : "" });
    return v;
  });
}
