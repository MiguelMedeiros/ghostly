import { describe, expect, it, vi } from 'vitest';
import { parseSshPublicKey } from '@ghostly/core';
import type { IdentityFetch } from '../src/proofs/contract';
import { checkSshForge, validForgeLogin } from '../src/proofs/sshForges';
import fixture from '../../core/test/fixtures/sshsig/sshsig-vectors.json';
// covers: proofs.ssh.github, proofs.ssh.gitlab

const mine = parseSshPublicKey(fixture.vectors.find(v => v.name === 'ed25519')!.publicKey);
const other = parseSshPublicKey(fixture.vectors.find(v => v.name === 'rsa-2048')!.publicKey);
const answer = (body: unknown, status = 200, raw?: string) => { const text = raw ?? JSON.stringify(body); return { status, contentType: 'application/json', text, bytes: new TextEncoder().encode(text) }; };
const serve = (fn: (url: string) => ReturnType<typeof answer>) => vi.fn<IdentityFetch>(async url => fn(url));

describe('SSH key lookups on GitHub and GitLab', () => {
  it('reads one GitHub listing, skipping keys it cannot parse', async () => {
    const fetch = serve(() => answer([{ id: 1, key: other.line }, { id: 2, key: `${mine.line} laptop` }, { id: 3, key: 'ssh-dss AAAA' }, null, { key: 7 }]));
    expect(await checkSshForge('github', 'octo-cat', mine, fetch)).toBe('linked');
    expect(fetch.mock.calls).toEqual([['https://api.github.com/users/octo-cat/keys?per_page=100', { maxBytes: 256 * 1024, signal: undefined }]]);
  });

  it('tells an unlisted key from a missing account', async () => {
    expect(await checkSshForge('github', 'someone', mine, serve(() => answer([{ key: other.line }])))).toBe('not-listed');
    expect(await checkSshForge('github', 'nobody', mine, serve(() => answer({ message: 'Not Found' }, 404)))).toBe('no-account');
    expect(await checkSshForge('gitlab', 'nobody', mine, serve(() => answer([])))).toBe('no-account');
    // GitLab's username search is exact only in our hands: a different user in the answer is not a match.
    expect(await checkSshForge('gitlab', 'bob', mine, serve(() => answer([{ id: 1, username: 'bobby' }])))).toBe('no-account');
  });

  it('shares one request between concurrent identical lookups, and asks again afterwards', async () => {
    const fetch = serve(() => answer([{ key: mine.line }]));
    expect(await Promise.all([checkSshForge('github', 'a', mine, fetch), checkSshForge('github', 'A', other, fetch)])).toEqual(['linked', 'not-listed']);
    expect(fetch).toHaveBeenCalledTimes(1);
    await checkSshForge('github', 'a', mine, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws, never links, when the forge cannot answer properly', async () => {
    await expect(checkSshForge('github', 'x', mine, serve(() => answer({}, 403)))).rejects.toThrow(/api.github.com is limiting lookups/);
    await expect(checkSshForge('github', 'x', mine, serve(() => answer({}, 500)))).rejects.toThrow(/HTTP 500/);
    await expect(checkSshForge('github', 'x', mine, serve(() => answer(null, 200, '<html>')))).rejects.toThrow(/Unexpected answer/);
    await expect(checkSshForge('github', 'x', mine, serve(() => answer({ key: mine.line })))).rejects.toThrow(/Unexpected key list/);
    await expect(checkSshForge('gitlab', 'x', mine, serve(() => answer([{ id: 'one', username: 'x' }])))).rejects.toThrow(/Unexpected answer/);
    const fetch = serve(() => answer([]));
    await expect(checkSshForge('github', '../users/x', mine, fetch)).rejects.toThrow(/Not a GitHub username/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts only real account names', () => {
    for (const ok of ['MiguelMedeiros', 'a-b-c', 'a']) expect(validForgeLogin('github', ok)).toBe(true);
    for (const bad of ['', '-a', 'a-', 'a--b', 'a'.repeat(40), 'a/b', 'a b', 'a.b']) expect(validForgeLogin('github', bad)).toBe(false);
    expect(validForgeLogin('gitlab', 'some.one_2')).toBe(true);
    for (const bad of ['', '-x', 'x.git', 'x/y', 'x?y', 'x'.repeat(65)]) expect(validForgeLogin('gitlab', bad)).toBe(false);
  });
});
