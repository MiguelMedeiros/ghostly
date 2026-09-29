/**
 * A provider's signing keys, fetched from its pinned JWKS URL with limits and
 * cached. A key ID that is not in the cached set triggers one early refetch
 * (providers rotate keys), rate-limited so that a stream of made-up key IDs
 * cannot turn a contact's app into a request generator.
 */

export interface Jwk {
  kty: string; kid?: string; use?: string; alg?: string; key_ops?: string[];
  n?: string; e?: string; crv?: string; x?: string; y?: string;
  /** Microsoft adds the issuer each key signs for. */
  issuer?: string;
}
/**
 * How keys are fetched. In `verify` this is the engine's `ctx.fetch` (HTTPS GET, no credentials, no
 * redirects, time-out, size cap); `cacheControl` is used when the fetcher reports it.
 */
export type JwksFetch = (url: string, options: { maxBytes: number }) => Promise<{ status: number; text: string; cacheControl?: string | null }>;

export const JWKS_MAX_BYTES = 64 * 1024;
export const JWKS_MAX_KEYS = 32;
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
/** A missing `kid` refetches at most this often per URL. */
export const REFETCH_INTERVAL_MS = 60_000;

interface Entry { keys: Jwk[]; expires: number; fetched: number }

function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

function ttl(cacheControl: string | null | undefined): number {
  const maxAge = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? '')?.[1];
  const ms = maxAge ? Number(maxAge) * 1000 : DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ms));
}

function parseKeys(text: string): Jwk[] {
  if (text.length > JWKS_MAX_BYTES) throw new Error('Provider key set too large');
  let doc: { keys?: unknown };
  try { doc = JSON.parse(text) as { keys?: unknown }; } catch { throw new Error('Invalid provider key set'); }
  if (!doc || !Array.isArray(doc.keys) || doc.keys.length > JWKS_MAX_KEYS) throw new Error('Invalid provider key set');
  return doc.keys.filter((k): k is Jwk => !!k && typeof k === 'object' && typeof (k as Jwk).kty === 'string');
}

export class JwksCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry>>();
  constructor(private options: { now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }

  private load(url: string, fetcher: JwksFetch): Promise<Entry> {
    const running = this.inflight.get(url);
    if (running) return running;
    const task = (async () => {
      if (!allowedUrl(url)) throw new Error('Provider key URL refused');
      const response = await fetcher(url, { maxBytes: JWKS_MAX_BYTES });
      if (response.status !== 200) throw new Error(`Provider keys unavailable (${response.status})`);
      const keys = parseKeys(response.text);
      const fetched = this.now();
      const entry = { keys, fetched, expires: fetched + ttl(response.cacheControl) };
      this.entries.set(url, entry);
      return entry;
    })();
    this.inflight.set(url, task);
    return task.finally(() => this.inflight.delete(url));
  }

  /** The key with this `kid`, refetching once when it is unknown (rotation) or the cache expired. */
  async key(url: string, kid: string, fetcher: JwksFetch): Promise<Jwk | undefined> {
    let entry = this.entries.get(url);
    if (!entry || entry.expires <= this.now()) entry = await this.load(url, fetcher);
    let found = entry.keys.find(k => k.kid === kid);
    if (!found && this.now() - entry.fetched >= REFETCH_INTERVAL_MS) {
      entry = await this.load(url, fetcher);
      found = entry.keys.find(k => k.kid === kid);
    }
    return found;
  }

  clear(): void { this.entries.clear(); }
}

/** One cache per app: every contact's proofs share the providers' keys. */
export const sharedJwksCache = new JwksCache();
