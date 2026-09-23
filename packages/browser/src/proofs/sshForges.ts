import { parseSshPublicKey, sameSshKey, type SshPublicKey } from '@ghostly/core';
import type { IdentityFetch } from './contract';

/** "This account publishes that key", without OAuth: GitHub and GitLab publish every account's SSH
 * public keys, and only the account holder can add one. The verifier's own lookup, through the
 * engine's bounded `ctx.fetch`; it tells the forge (and the network) which account was checked. */

export type SshForge = 'github' | 'gitlab';
export const SSH_FORGE_LABEL: Record<SshForge, string> = { github: 'GitHub', gitlab: 'GitLab' };
/** The only host each forge lookup contacts, for the privacy line. */
export const SSH_FORGE_HOST: Record<SshForge, string> = { github: 'api.github.com', gitlab: 'gitlab.com' };

export type SshForgeStatus = 'linked' | 'not-listed' | 'no-account';

const MAX_BODY = 256 * 1024;
const MAX_KEYS = 200;

export function validForgeLogin(forge: SshForge, login: string): boolean {
  if (typeof login !== 'string') return false;
  // GitHub: 1-39 alphanumerics or single inner hyphens. GitLab: letters, digits, _ . - ;
  // not starting with - and not ending in .git/.atom. Capped at 64 so it fits every label.
  return forge === 'github'
    ? /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)
    : /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/.test(login) && !/\.(?:git|atom)$/i.test(login);
}

async function get(fetcher: IdentityFetch, url: string, signal?: AbortSignal): Promise<{ status: 404 } | { status: 200; body: unknown }> {
  const response = await fetcher(url, { maxBytes: MAX_BODY, signal });
  if (response.status === 404) return { status: 404 };
  if (response.status === 403 || response.status === 429) throw new Error(`${new URL(url).host} is limiting lookups; check again later`);
  if (response.status !== 200) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  try { return { status: 200, body: JSON.parse(response.text) }; } catch { throw new Error(`Unexpected answer from ${new URL(url).host}`); }
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

/** The account's published keys, or null when there is no such account. */
async function listKeys(forge: SshForge, login: string, fetcher: IdentityFetch, signal?: AbortSignal): Promise<SshPublicKey[] | null> {
  if (forge === 'github') {
    const r = await get(fetcher, `https://api.github.com/users/${encodeURIComponent(login)}/keys?per_page=100`, signal);
    return r.status === 404 ? null : keysFrom(r.body);
  }
  const users = await get(fetcher, `https://gitlab.com/api/v4/users?username=${encodeURIComponent(login)}`, signal);
  const list = users.status === 200 && Array.isArray(users.body) ? users.body as { id?: unknown; username?: unknown }[] : [];
  const user = list.find(u => typeof u?.username === 'string' && u.username.toLowerCase() === login.toLowerCase());
  if (!user) return null;
  if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0) throw new Error('Unexpected answer from gitlab.com');
  const r = await get(fetcher, `https://gitlab.com/api/v4/users/${user.id as number}/keys?per_page=100`, signal);
  return r.status === 404 ? null : keysFrom(r.body);
}

// Only concurrent identical lookups share a request. What stays checked is the verifier's stored
// result, which the app offers to re-check once the provider's `recheck` time has passed.
const inFlight = new WeakMap<IdentityFetch, Map<string, Promise<SshPublicKey[] | null>>>();

/** Whether `key` is one of `login`'s published SSH keys. Throws when the forge cannot be asked. */
export async function checkSshForge(forge: SshForge, login: string, key: Pick<SshPublicKey, 'blob'>, fetcher: IdentityFetch, signal?: AbortSignal): Promise<SshForgeStatus> {
  if (!validForgeLogin(forge, login)) throw new Error(`Not a ${SSH_FORGE_LABEL[forge]} username`);
  let pending = inFlight.get(fetcher);
  if (!pending) inFlight.set(fetcher, pending = new Map());
  const map = pending, id = `${forge}:${login.toLowerCase()}`;
  let lookup = map.get(id);
  if (!lookup) {
    lookup = listKeys(forge, login, fetcher, signal).finally(() => map.delete(id));
    map.set(id, lookup);
  }
  const keys = await lookup;
  if (!keys) return 'no-account';
  return keys.some(k => sameSshKey(k, key)) ? 'linked' : 'not-listed';
}
