import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSshPublicKey } from '@ghostly/core';
import { checkSshForge, clearSshForgeCache, describeSshForge, validForgeLogin, SSH_FORGE_TTL_MS } from '../src/proofs/sshForges';
import fixture from '../../core/test/fixtures/sshsig/sshsig-vectors.json';

const mine = parseSshPublicKey(fixture.vectors.find(v => v.name === 'ed25519')!.publicKey);
const other = parseSshPublicKey(fixture.vectors.find(v => v.name === 'rsa-2048')!.publicKey);
const json = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
afterEach(() => clearSshForgeCache());

describe('SSH key lookups on GitHub and GitLab', () => {
  it('links a GitHub account that publishes the signing key, asking only api.github.com', async () => {
    const fetch = vi.fn(async () => json([{ id: 1, key: other.line }, { id: 2, key: `${mine.line}` }, { id: 3, key: 'ssh-dss AAAA' }]));
    const check = await checkSshForge('github', 'octo-cat', mine, { fetch });
    expect(check.status).toBe('linked');
    expect(describeSshForge(check)).toBe('GitHub: octo-cat (via published SSH key)');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['https://api.github.com/users/octo-cat/keys?per_page=100', { maxBytes: 256 * 1024 }]);
  });

  it('says when the key is not listed or the account does not exist', async () => {
    expect((await checkSshForge('github', 'someone', mine, { fetch: async () => json([{ key: other.line }]) })).status).toBe('not-listed');
    expect((await checkSshForge('github', 'nobody', mine, { fetch: async () => json({ message: 'Not Found' }, 404) })).status).toBe('no-account');
    expect((await checkSshForge('gitlab', 'nobody', mine, { fetch: async () => json([]) })).status).toBe('no-account');
  });

  it('resolves a GitLab username to its id, then reads that user\'s keys', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('?username=')
      ? json([{ id: 42, username: 'Some.One' }]) : json([{ id: 7, title: 'laptop', key: `${mine.line} laptop` }]));
    const check = await checkSshForge('gitlab', 'some.one', mine, { fetch });
    expect(check.status).toBe('linked');
    expect(fetch.mock.calls.map(c => c[0])).toEqual(['https://gitlab.com/api/v4/users?username=some.one', 'https://gitlab.com/api/v4/users/42/keys?per_page=100']);
  });

  it('caches a listing, re-checks it once stale, and notices a removed key', async () => {
    let now = 1_000_000, keys = [mine.line];
    const fetch = vi.fn(async () => json(keys.map(key => ({ key }))));
    const opts = { fetch, now: () => now };
    expect((await checkSshForge('github', 'Octo', mine, opts)).status).toBe('linked');
    expect((await checkSshForge('github', 'octo', mine, opts)).status).toBe('linked');
    expect(fetch).toHaveBeenCalledTimes(1);
    keys = [other.line];
    now += SSH_FORGE_TTL_MS + 1;
    expect((await checkSshForge('github', 'octo', mine, opts)).status).toBe('not-listed');
    expect(fetch).toHaveBeenCalledTimes(2);
    keys = [mine.line];
    expect((await checkSshForge('github', 'octo', mine, { ...opts, fresh: true })).status).toBe('linked');
  });

  it('shares one request between concurrent checks', async () => {
    const fetch = vi.fn(async () => json([{ key: mine.line }]));
    const results = await Promise.all([checkSshForge('github', 'a', mine, { fetch }), checkSshForge('github', 'a', other, { fetch })]);
    expect(results.map(r => r.status)).toEqual(['linked', 'not-listed']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports failures as unavailable, never as linked, and bounds what it reads', async () => {
    const huge = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`[${'{"key":"x"},'.repeat(30_000)}{}]`, { status: 200 }));
    expect(await checkSshForge('github', 'big', mine)).toMatchObject({ status: 'unavailable', detail: 'Response too large' });
    expect(huge.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    huge.mockRestore();
    expect(await checkSshForge('github', 'garbled', mine, { fetch: async () => ({ status: 200, text: '<html>' }) })).toMatchObject({ status: 'unavailable', detail: 'Unexpected response' });
    expect(await checkSshForge('github', 'limited', mine, { fetch: async () => json({}, 403) })).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/rate limiting/) });
    expect((await checkSshForge('github', 'offline', mine, { fetch: async () => { throw new TypeError('Failed to fetch'); } })).status).toBe('unavailable');
    expect((await checkSshForge('github', 'weird', mine, { fetch: async () => json({ key: mine.line }) })).status).toBe('unavailable');
    const fetch = vi.fn();
    expect((await checkSshForge('github', '../users/x', mine, { fetch })).status).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts only real account names', () => {
    expect(validForgeLogin('github', 'MiguelMedeiros')).toBe(true);
    expect(validForgeLogin('github', 'a-b-c')).toBe(true);
    for (const bad of ['', '-a', 'a-', 'a--b', 'a'.repeat(40), 'a/b', 'a b', 'a.b']) expect(validForgeLogin('github', bad)).toBe(false);
    expect(validForgeLogin('gitlab', 'some.one_2')).toBe(true);
    for (const bad of ['', '-x', 'x.git', 'x/y', 'x?y']) expect(validForgeLogin('gitlab', bad)).toBe(false);
  });
});
