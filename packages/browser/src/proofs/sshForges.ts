import { parseSshPublicKey, sameSshKey, type SshPublicKey } from '@ghostly/core';

/** "Linked to a forge account" for an SSH proof, without OAuth: GitHub and GitLab
 * publish every account's SSH public keys, so if the key that signed a Ghostly
 * statement is on that list, the account holder put it there. This is the
 * verifier's own lookup; the prover only names the account. It tells the forge
 * (and anyone watching the connection) which account this device asked about,
 * so it runs only when someone asks for it, and the UI says so. */

export type SshForge = 'github' | 'gitlab';
export const SSH_FORGES: readonly SshForge[] = ['github', 'gitlab'];
export const SSH_FORGE_LABEL: Record<SshForge, string> = { github: 'GitHub', gitlab: 'GitLab' };
/** The only hosts ever contacted, for the UI's disclosure. */
export const SSH_FORGE_HOST: Record<SshForge, string> = { github: 'api.github.com', gitlab: 'gitlab.com' };

export type SshForgeStatus = 'linked' | 'not-listed' | 'no-account' | 'unavailable';
export interface SshForgeCheck { forge: SshForge; login: string; status: SshForgeStatus; checkedAt: number; detail?: string }

const MAX_BODY = 256 * 1024;
const MAX_KEYS = 200;
const TIMEOUT_MS = 10_000;
/** A removed key stops counting within this long; a failed lookup is retried sooner. */
export const SSH_FORGE_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const CACHE_LIMIT = 64;

export function validForgeLogin(forge: SshForge, login: string): boolean {
  if (typeof login !== 'string') return false;
  // GitHub: 1-39 alphanumerics or single inner hyphens. GitLab: letters, digits,
  // _ . - ; not starting with - and not ending in .git/.atom.
  return forge === 'github'
    ? /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)
    : /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/.test(login) && !/\.(?:git|atom)$/i.test(login);
}

/** An HTTPS GET with a size cap; the identity-proof engine's bounded fetch has this shape. */
export type ForgeFetch = (url: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<{ status: number; text: string }>;
interface Listing { keys: SshPublicKey[] | null; fetchedAt: number; error?: string }
const cache = new Map<string, Listing | Promise<Listing>>();

/** Plain `fetch` with the same bounds, for callers outside the engine. */
export const boundedForgeFetch: ForgeFetch = async (url, { maxBytes, signal }) => {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Response too large');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('Response too large');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return { status: response.status, text: new TextDecoder().decode(all) };
};

async function get(fetcher: ForgeFetch, url: string): Promise<{ status: number; body?: unknown }> {
  const response = await fetcher(url, { maxBytes: MAX_BODY });
  if (response.status === 404) return { status: 404 };
  if (response.status < 200 || response.status > 299)
    throw new Error(response.status === 403 || response.status === 429 ? `${new URL(url).host} is rate limiting lookups; try later` : `HTTP ${response.status}`);
  try { return { status: response.status, body: JSON.parse(response.text) }; } catch { throw new Error('Unexpected response'); }
}

function keysFrom(body: unknown): SshPublicKey[] {
  if (!Array.isArray(body)) throw new Error('Unexpected key list');
  const keys: SshPublicKey[] = [];
  for (const entry of body.slice(0, MAX_KEYS)) {
    const line = (entry as { key?: unknown } | null)?.key;
    if (typeof line !== 'string') continue;
    try { keys.push(parseSshPublicKey(line)); } catch { /* A key type Ghostly cannot verify never matches. */ }
  }
  return keys;
}

/** The account's published keys, or null when the account does not exist. */
async function listKeys(forge: SshForge, login: string, fetcher: ForgeFetch): Promise<SshPublicKey[] | null> {
  if (forge === 'github') {
    const r = await get(fetcher, `https://api.github.com/users/${encodeURIComponent(login)}/keys?per_page=100`);
    return r.status === 404 ? null : keysFrom(r.body);
  }
  const users = await get(fetcher, `https://gitlab.com/api/v4/users?username=${encodeURIComponent(login)}`);
  const user = Array.isArray(users.body) ? users.body.find(u => typeof u?.username === 'string' && u.username.toLowerCase() === login.toLowerCase()) : undefined;
  if (users.status === 404 || !user) return null;
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Unexpected GitLab user');
  const r = await get(fetcher, `https://gitlab.com/api/v4/users/${user.id}/keys?per_page=100`);
  return r.status === 404 ? null : keysFrom(r.body);
}

/** Whether `key` is one of `login`'s published SSH keys on `forge`. Cached for
 * SSH_FORGE_TTL_MS, so reopening a proof re-checks it once the entry is stale;
 * `fresh` skips the cache. Never throws: failures come back as 'unavailable'. */
export async function checkSshForge(forge: SshForge, login: string, key: Pick<SshPublicKey, 'blob'>,
  options: { fetch?: ForgeFetch; now?: () => number; fresh?: boolean } = {}): Promise<SshForgeCheck> {
  const now = options.now ?? Date.now;
  if (!SSH_FORGES.includes(forge) || !validForgeLogin(forge, login)) return { forge, login, status: 'unavailable', checkedAt: now(), detail: 'Invalid account name' };
  const id = `${forge}:${login.toLowerCase()}`;
  let entry = cache.get(id);
  const stale = (l: Listing) => now() - l.fetchedAt > (l.error ? FAILURE_TTL_MS : SSH_FORGE_TTL_MS);
  if (!entry || options.fresh || (!(entry instanceof Promise) && stale(entry))) {
    const fetcher = options.fetch ?? boundedForgeFetch;
    const pending: Promise<Listing> = listKeys(forge, login, fetcher)
      .then(keys => ({ keys, fetchedAt: now() }), (e: unknown) => ({ keys: null, fetchedAt: now(), error: e instanceof Error ? e.message : 'Lookup failed' }))
      .then(listing => { if (cache.get(id) === pending) cache.set(id, listing); return listing; });
    entry = pending;
    cache.delete(id); cache.set(id, pending);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  const listing = await entry;
  const base = { forge, login, checkedAt: listing.fetchedAt };
  if (listing.error) return { ...base, status: 'unavailable', detail: listing.error };
  if (!listing.keys) return { ...base, status: 'no-account' };
  return { ...base, status: listing.keys.some(k => sameSshKey(k, key)) ? 'linked' : 'not-listed' };
}

/** Test seam: forget every cached listing. */
export function clearSshForgeCache(): void { cache.clear(); }

export function describeSshForge(check: SshForgeCheck): string {
  const who = `${SSH_FORGE_LABEL[check.forge]}: ${check.login}`;
  switch (check.status) {
    case 'linked': return `${who} (via published SSH key)`;
    case 'not-listed': return `${who} does not list this key`;
    case 'no-account': return `${who} was not found`;
    default: return `${who} could not be checked${check.detail ? ` (${check.detail})` : ''}`;
  }
}
