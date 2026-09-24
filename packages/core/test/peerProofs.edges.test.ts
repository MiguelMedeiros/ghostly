import { afterEach, describe, expect, it, vi } from 'vitest';
import IdentityKey from 'keet-identity-key';
import { createIdentity, sign } from '../src/identity';
import { toBase64Url, toZ32, utf8Encode } from '../src/bytes';
import { RING_LIFETIME } from '../src/pubkyRing';
import {
  PeerProofs, STORAGE_LIFETIME, STORAGE_ROOT, emptyProofLedger, importedProof, proofStatement, storageProof, storageProofBody,
  storageProofPath, validExternalKey, verifyPeerProof,
  type ImportedProof, type ProofAdapter, type ProofChallenge, type ProofLedger, type ProofRecord, type StorageProof,
} from '../src/peerProofs';

// covers: proofs.peer-proofs

const NOW = 1_800_000_000;
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const nonce = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const LIFETIMES: Record<ProofAdapter, number> = { nostr: 86400, 'pubky-import': 86400, 'keet-import': 86400, 'pubky-storage': STORAGE_LIFETIME, 'pubky-ring': RING_LIFETIME };

/** A challenge as the verifier would issue it, built directly (no exchange). */
function challenge(adapter: ProofAdapter, externalKey: string, over: Partial<ProofChallenge> = {}): ProofChallenge {
  return { adapter, externalKey, subject: createIdentity().pubKeyZ32, audience: createIdentity().pubKeyZ32, context: 'a'.repeat(64), session: 'b'.repeat(64),
    nonce: nonce(), issuedAt: NOW, expiresAt: NOW + LIFETIMES[adapter], ...over };
}

describe('Pubky imported-key proofs', () => {
  const pubky = createIdentity();
  const signed = async (c: ProofChallenge, seed = pubky.seed) => importedProof(c, sign(utf8Encode(proofStatement(c)), seed));

  it('accepts an Ed25519 signature by the named key over the exact statement', async () => {
    const c = challenge('pubky-import', pubky.pubKeyZ32);
    const e = await signed(c);
    expect(e.scheme).toBe('pubky-import/1');
    await expect(verifyPeerProof(e, c)).resolves.toBeUndefined();
  });

  it('refuses a signature by another key, or over another challenge relabelled with this one', async () => {
    const c = challenge('pubky-import', pubky.pubKeyZ32);
    await expect(verifyPeerProof(await signed(c, createIdentity().seed), c)).rejects.toThrow('Invalid Pubky signature');
    const other = challenge('pubky-import', pubky.pubKeyZ32);
    const sigForOther = sign(utf8Encode(proofStatement(other)), pubky.seed);
    // The envelope digest is recomputed for `c`, so only the signature itself can catch the swap.
    await expect(verifyPeerProof(await importedProof(c, sigForOther), c)).rejects.toThrow('Invalid Pubky signature');
  });

  it('refuses a signature of the wrong length even when its digest is consistent', async () => {
    const c = challenge('pubky-import', pubky.pubKeyZ32);
    const full = sign(utf8Encode(proofStatement(c)), pubky.seed);
    await expect(verifyPeerProof(await importedProof(c, full.subarray(0, 63)), c)).rejects.toThrow('Invalid Pubky signature');
    await expect(verifyPeerProof(await importedProof(c, new Uint8Array([...full, 0])), c)).rejects.toThrow('Invalid Pubky signature');
  });

  it('refuses malformed envelopes before any cryptography', async () => {
    const c = challenge('pubky-import', pubky.pubKeyZ32);
    const e = await signed(c);
    const bad: unknown[] = [
      null, { ...e, scheme: 'keet-import/1' }, { ...e, signature: 42 }, { ...e, signature: '' }, { ...e, signature: 'a+b/' },
      { ...e, signature: 'A'.repeat(161) }, { ...e, id: 7 }, { ...e, id: 'A'.repeat(64) }, { ...e, id: e.id.slice(1) },
    ];
    for (const evidence of bad) await expect(verifyPeerProof(evidence as ImportedProof, c), JSON.stringify(evidence)).rejects.toThrow('Invalid imported-key proof');
    // A challenge naming a non-canonical spelling of the key (a padding bit set) is refused whatever the evidence says.
    const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';
    const twin = pubky.pubKeyZ32.slice(0, 51) + alphabet[alphabet.indexOf(pubky.pubKeyZ32[51]) ^ 1];
    await expect(verifyPeerProof(e, { ...c, externalKey: twin })).rejects.toThrow('Invalid imported-key proof');
  });

  it('refuses a non-canonical base64url signature and a digest over another statement', async () => {
    const c = challenge('pubky-import', pubky.pubKeyZ32);
    const e = await signed(c);
    // 64 bytes are 86 base64url characters; the last one carries 4 padding bits that must be zero.
    const last = e.signature[85], alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const malleated = e.signature.slice(0, 85) + alphabet[alphabet.indexOf(last) + 1];
    await expect(verifyPeerProof({ ...e, signature: malleated }, c)).rejects.toThrow('Invalid proof encoding or digest');
    await expect(verifyPeerProof({ ...e, id: 'f'.repeat(64) }, c)).rejects.toThrow('Invalid proof encoding or digest');
  });

  it('keeps each adapter to its own scheme: a Pubky signature does not pass as a Keet proof', async () => {
    const c = challenge('pubky-import', pubky.pubKeyZ32);
    const e = await signed(c);
    const keet = challenge('keet-import', hex(pubky.publicKey), { subject: c.subject, audience: c.audience, nonce: c.nonce });
    await expect(verifyPeerProof({ ...e, scheme: 'keet-import/1' }, keet)).rejects.toThrow();
  });

  it('refuses to wrap evidence for adapters that are not imported keys', async () => {
    for (const adapter of ['nostr', 'pubky-ring', 'pubky-storage'] as const)
      await expect(importedProof(challenge(adapter, 'a'.repeat(64)), new Uint8Array(64))).rejects.toThrow('Wrong proof adapter');
  });

  it('refuses an unknown adapter even with a self-consistent envelope', async () => {
    const c = challenge('bogus' as ProofAdapter, 'a'.repeat(64));
    const e = await importedProof(c, new Uint8Array(64));
    await expect(verifyPeerProof(e, c)).rejects.toThrow('Unsupported proof adapter');
  });
});

describe('Keet imported-key proofs', () => {
  const keet = IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
  const attested = async (c: ProofChallenge) => IdentityKey.attestData(utf8Encode(proofStatement(c)), (await keet).identityKeyPair);

  it('accepts the SDK attestation of the exact statement by the named identity', async () => {
    const c = challenge('keet-import', hex((await keet).identityPublicKey));
    await expect(verifyPeerProof(await importedProof(c, await attested(c)), c)).resolves.toBeUndefined();
  });

  it('refuses anything but the pinned root-only attestation shape, before the SDK decodes it', async () => {
    const c = challenge('keet-import', hex((await keet).identityPublicKey));
    const good = await attested(c);
    const shapes = [good.subarray(0, 106), new Uint8Array([...good, 0]), Uint8Array.from(good, (b, i) => (i === 0 ? 2 : b)),
      Uint8Array.from(good, (b, i) => (i === 41 ? 1 : b)), Uint8Array.from(good, (b, i) => (i === 42 ? 0 : b))];
    for (const sig of shapes) await expect(verifyPeerProof(await importedProof(c, sig), c)).rejects.toThrow('Unsupported Keet attestation');
  });

  it('refuses a tampered attestation, one for another statement, and one by another identity', async () => {
    const c = challenge('keet-import', hex((await keet).identityPublicKey));
    const good = await attested(c);
    const tampered = Uint8Array.from(good, (b, i) => (i === 100 ? b ^ 1 : b));
    await expect(verifyPeerProof(await importedProof(c, tampered), c)).rejects.toThrow('Invalid Keet attestation');
    const other = await attested(challenge('keet-import', c.externalKey));
    await expect(verifyPeerProof(await importedProof(c, other), c)).rejects.toThrow('Invalid Keet attestation');
    const stranger = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
    const byStranger = IdentityKey.attestData(utf8Encode(proofStatement(c)), stranger.identityKeyPair);
    await expect(verifyPeerProof(await importedProof(c, byStranger), c)).rejects.toThrow('Invalid Keet attestation');
  });
});

describe('Pubky homeserver storage proofs', () => {
  const owner = createIdentity().pubKeyZ32;
  const folder = 'c'.repeat(64);

  it('publishes a commitment only: no participant, conversation or session in the path or body', async () => {
    const c = challenge('pubky-storage', owner);
    const e = await storageProof(c, folder);
    expect(storageProofPath(e)).toBe(`${STORAGE_ROOT}${folder}/${e.id}.json`);
    const published = storageProofPath(e) + storageProofBody(c, e);
    for (const secret of [c.subject, c.audience, c.context, c.session, c.nonce]) expect(published).not.toContain(secret);
    expect(JSON.parse(storageProofBody(c, e))).toEqual({ version: 1, commitment: e.id, expiresAt: c.expiresAt });
  });

  it('builds proofs only for storage challenges and hex folders', async () => {
    await expect(storageProof(challenge('nostr', 'a'.repeat(64)), folder)).rejects.toThrow('Invalid storage proof');
    for (const bad of ['C'.repeat(64), 'c'.repeat(63), '../' + 'c'.repeat(61)])
      await expect(storageProof(challenge('pubky-storage', owner), bad)).rejects.toThrow('Invalid storage proof');
  });

  it('accepts only when the homeserver serves the exact body at the exact path of the named key', async () => {
    const c = challenge('pubky-storage', owner);
    const e = await storageProof(c, folder);
    const read = vi.fn(async () => storageProofBody(c, e));
    await verifyPeerProof(e, c, read);
    expect(read).toHaveBeenCalledWith(owner, storageProofPath(e));
    await expect(verifyPeerProof(e, c, async () => storageProofBody({ ...c, expiresAt: c.expiresAt + 1 }, e))).rejects.toThrow('Homeserver proof does not match this challenge');
    await expect(verifyPeerProof(e, c, async () => '')).rejects.toThrow('Homeserver proof does not match');
    await expect(verifyPeerProof(e, c, async () => { throw new Error('404'); })).rejects.toThrow('404');
  });

  it('refuses malformed evidence, a commitment to another challenge, and verification without a reader', async () => {
    const c = challenge('pubky-storage', owner);
    const e = await storageProof(c, folder);
    const read = vi.fn(async () => storageProofBody(c, e));
    const bad: unknown[] = [
      null, { ...e, scheme: 'pubky-storage/2' }, { ...e, id: 'x' }, { ...e, folder: 5 }, { ...e, folder: 'C'.repeat(64) },
      { ...e, extra: true }, { ...e, folder: 'd'.repeat(64) }, await storageProof({ ...c, nonce: nonce() }, folder),
    ];
    for (const evidence of bad) await expect(verifyPeerProof(evidence as StorageProof, c, read), JSON.stringify(evidence)).rejects.toThrow('Invalid storage proof');
    expect(read).not.toHaveBeenCalled();
    await expect(verifyPeerProof(e, c)).rejects.toThrow('Invalid storage proof');
  });
});

describe('statements and keys', () => {
  it('separates purposes: the same fields under another adapter are another statement', () => {
    const base = challenge('nostr', 'a'.repeat(64));
    const statements = (['nostr', 'pubky-import', 'keet-import', 'pubky-storage', 'pubky-ring'] as const).map(adapter => proofStatement({ ...base, adapter }));
    expect(new Set(statements).size).toBe(5);
    expect(JSON.parse(statements[0])[2]).toBe('control-of-external-key');
    expect(JSON.parse(statements[3])[2]).toBe('authorized-storage-control');
    expect(JSON.parse(statements[4])[2]).toBe('delegated-conversation-proof');
  });

  it('checks external keys per adapter: hex for Nostr and Keet, canonical z-base-32 for Pubky', () => {
    const z = createIdentity().pubKeyZ32;
    expect(validExternalKey('nostr', 'a'.repeat(64))).toBe(true);
    expect(validExternalKey('nostr', z)).toBe(false);
    expect(validExternalKey('keet-import', 'A'.repeat(64))).toBe(false);
    expect(validExternalKey('pubky-import', z)).toBe(true);
    expect(validExternalKey('pubky-storage', 'a'.repeat(64))).toBe(false);
    expect(validExternalKey('pubky-import', 42 as unknown as string)).toBe(false);
    // 52 characters carry 260 bits for a 256-bit key: a non-zero padding bit names the same key twice.
    const bytes = createIdentity().publicKey;
    const canonical = toZ32(bytes);
    const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';
    const twin = canonical.slice(0, 51) + alphabet[alphabet.indexOf(canonical[51]) ^ 1];
    expect(validExternalKey('pubky-import', twin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The exchange

type Frame = Record<string, unknown>;
function pair(options: { supports?: (a: ProofAdapter) => boolean; readStorage?: (key: string, path: string) => Promise<string> } = {}) {
  const keys = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
  const ledgers: ProofLedger[] = [emptyProofLedger(), emptyProofLedger()];
  const errors = [vi.fn(), vi.fn()];
  const frames: Frame[][] = [[], []];
  const scope = { context: 'a'.repeat(64), session: 'b'.repeat(64) };
  let now = NOW, deliver = true, fail: unknown;
  const peers: PeerProofs[] = [];
  for (let i = 0; i < 2; i++) peers[i] = new PeerProofs({
    scope: () => ({ subject: keys[i], audience: keys[1 - i], ...scope }),
    send: frame => { frames[i].push(structuredClone(frame) as Frame); if (deliver) queueMicrotask(() => void peers[1 - i].receive(structuredClone(frame) as Frame)); },
    storage: { read: () => ledgers[i], update: async change => { if (fail !== undefined) throw fail; ledgers[i] = change(structuredClone(ledgers[i])); } },
    now: () => now, onError: errors[i], supports: options.supports, readStorage: options.readStorage,
  });
  return { peers, keys, ledgers, errors, frames, scope,
    advance: (n: number) => { now += n; }, offline: () => { deliver = false; }, failStorage: (e: unknown) => { fail = e; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('asking for a challenge', () => {
  it('refuses an invalid key or an adapter the peer does not support, before sending anything', async () => {
    const p = pair({ supports: a => a === 'nostr' });
    await expect(p.peers[0].prepare('not a key')).rejects.toThrow('Proof adapter unavailable or invalid public key');
    await expect(p.peers[0].prepare(createIdentity().pubKeyZ32, 'pubky-import')).rejects.toThrow('Proof adapter unavailable');
    await expect(p.peers[0].prepare('a'.repeat(64), 'pubky-ring')).rejects.toThrow('Proof adapter unavailable');
    expect(p.frames[0]).toEqual([]);
  });

  it('allows one request at a time, and times out after 15 seconds without a challenge', async () => {
    vi.useFakeTimers();
    const p = pair();
    p.offline();
    const first = p.peers[0].prepare('a'.repeat(64));
    const failed = expect(first).rejects.toThrow('Peer did not provide a challenge');
    await expect(p.peers[0].prepare('a'.repeat(64))).rejects.toThrow('A proof request is already pending');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    // The slot is free again.
    const second = p.peers[0].prepare('a'.repeat(64));
    p.peers[0].stop();
    await expect(second).rejects.toThrow('Connection closed');
  });

  it('frees the slot when sending the request fails', async () => {
    const peer = new PeerProofs({ scope: () => ({ subject: 'x', audience: 'y', context: '', session: '' }), send: () => { throw new Error('link down'); },
      storage: { read: emptyProofLedger, update: async () => {} } });
    await expect(peer.prepare('a'.repeat(64))).rejects.toThrow('link down');
    await expect(peer.prepare('a'.repeat(64))).rejects.toThrow('link down');
  });

  it('ignores a challenge for a request it never made, and refuses one for another key', async () => {
    const p = pair();
    p.offline();
    const asked = p.peers[0].prepare('a'.repeat(64));
    const request = p.frames[0][0] as { id: string };
    const c = challenge('nostr', 'b'.repeat(64), { subject: p.keys[0], audience: p.keys[1], ...p.scope });
    await p.peers[0].receive({ t: 'proof-challenge', id: nonce(), challenge: c });
    await p.peers[0].receive({ t: 'proof-challenge', id: 5, challenge: c });
    expect(p.errors[0]).not.toHaveBeenCalled();
    await p.peers[0].receive({ t: 'proof-challenge', id: request.id, challenge: c });
    expect(p.errors[0]).toHaveBeenLastCalledWith('Peer changed the requested external key');
    await p.peers[0].receive({ t: 'proof-challenge', id: request.id, challenge: { ...c, externalKey: 'a'.repeat(64), adapter: 'pubky-import' } });
    expect(p.errors[0]).toHaveBeenCalledTimes(2);
    // A challenge for another conversation is refused too; only the right one resolves the request.
    await p.peers[0].receive({ t: 'proof-challenge', id: request.id, challenge: { ...c, externalKey: 'a'.repeat(64), context: 'e'.repeat(64) } });
    expect(p.errors[0]).toHaveBeenLastCalledWith('Proof challenge expired or belongs to another connection');
    const good = { ...c, externalKey: 'a'.repeat(64) };
    await p.peers[0].receive({ t: 'proof-challenge', id: request.id, challenge: good });
    await expect(asked).resolves.toEqual(good);
    expect(p.ledgers[0].outgoing).toEqual([good]);
  });
});

describe('issuing challenges', () => {
  it('ignores malformed or unsupported requests without answering', async () => {
    const p = pair({ supports: a => a !== 'keet-import' });
    const valid = { t: 'proof-request', id: nonce(), adapter: 'nostr', externalKey: 'a'.repeat(64) };
    for (const frame of [{ ...valid, adapter: 'pubky-ring' }, { ...valid, adapter: 'keet-import' }, { ...valid, id: 7 }, { ...valid, id: 'short' },
      { ...valid, externalKey: 9 }, { ...valid, externalKey: createIdentity().pubKeyZ32 }])
      await p.peers[1].receive(frame);
    expect(p.frames[1]).toEqual([]);
    expect(p.ledgers[1].incoming).toEqual([]);
    expect(p.errors[1]).not.toHaveBeenCalled();
  });

  it('gives each adapter its own lifetime', async () => {
    const p = pair();
    p.offline();
    await p.peers[1].receive({ t: 'proof-request', id: nonce(), adapter: 'pubky-storage', externalKey: createIdentity().pubKeyZ32 });
    await p.peers[1].receive({ t: 'proof-request', id: nonce(), adapter: 'keet-import', externalKey: 'a'.repeat(64) });
    const [storage, keet] = p.ledgers[1].incoming;
    expect(storage.expiresAt - storage.issuedAt).toBe(STORAGE_LIFETIME);
    expect(keet.expiresAt - keet.issuedAt).toBe(86400);
    expect(storage).toMatchObject({ subject: p.keys[0], audience: p.keys[1] });
  });

  it('keeps at most eight live challenges, and frees room once they leave the window', async () => {
    const p = pair();
    p.offline();
    const request = () => p.peers[1].receive({ t: 'proof-request', id: nonce(), adapter: 'nostr', externalKey: 'a'.repeat(64) });
    for (let i = 0; i < 8; i++) await request();
    expect(p.ledgers[1].incoming).toHaveLength(8);
    await request();
    expect(p.errors[1]).toHaveBeenLastCalledWith('Too many proof challenges');
    expect(p.ledgers[1].incoming).toHaveLength(8);
    expect(p.frames[1]).toHaveLength(8);
    p.advance(301);
    await request();
    expect(p.ledgers[1].incoming).toHaveLength(1);
  });

  it('drops an oversized frame, and reports a non-Error failure generically', async () => {
    const p = pair();
    await p.peers[1].receive({ t: 'proof-request', pad: 'x'.repeat(8200) });
    expect(p.errors[1]).toHaveBeenLastCalledWith('Proof too large');
    p.failStorage('disk on fire');
    await p.peers[1].receive({ t: 'proof-request', id: nonce(), adapter: 'nostr', externalKey: 'a'.repeat(64) });
    expect(p.errors[1]).toHaveBeenLastCalledWith('Invalid peer proof');
  });

  it('uses the wall clock when no clock is given', async () => {
    vi.useFakeTimers({ now: 1_900_000_000_000 });
    const ledger = { current: emptyProofLedger() };
    const peer = new PeerProofs({ scope: () => ({ subject: createIdentity().pubKeyZ32, audience: createIdentity().pubKeyZ32, context: 'a'.repeat(64), session: 'b'.repeat(64) }),
      send: () => {}, storage: { read: () => ledger.current, update: async change => { ledger.current = change(ledger.current); } } });
    await peer.receive({ t: 'proof-request', id: nonce(), adapter: 'nostr', externalKey: 'a'.repeat(64) });
    expect(ledger.current.incoming[0].issuedAt).toBe(1_900_000_000);
  });
});

describe('presenting and accepting', () => {
  const pubky = createIdentity();
  const pubkySign = (c: ProofChallenge) => importedProof(c, sign(utf8Encode(proofStatement(c)), pubky.seed));

  it('runs a Pubky import end to end, and a second submit of the same challenge is refused', async () => {
    const p = pair();
    const c = await p.peers[0].prepare(pubky.pubKeyZ32, 'pubky-import');
    const e = await pubkySign(c);
    await p.peers[0].submit(c, e);
    await vi.waitFor(() => expect(p.ledgers[0].local[0]?.status).toBe('accepted'));
    expect(p.ledgers[1].remote[0]).toMatchObject({ status: 'accepted', event: e });
    await expect(p.peers[0].submit(c, e)).rejects.toThrow('Unknown or used proof challenge');
  });

  it('runs a storage proof end to end through the verifier\'s homeserver reader', async () => {
    const owner = createIdentity().pubKeyZ32, folder = 'e'.repeat(64);
    const published = new Map<string, string>();
    const p = pair({ readStorage: async (key, path) => published.get(`${key}${path}`) ?? '' });
    const c = await p.peers[0].prepare(owner, 'pubky-storage');
    expect(c.expiresAt - c.issuedAt).toBe(STORAGE_LIFETIME);
    const e = await storageProof(c, folder);
    // Not yet published: the verifier refuses and keeps the challenge for a retry.
    await p.peers[1].receive({ t: 'proof-present', challenge: c, event: e });
    expect(p.errors[1]).toHaveBeenLastCalledWith('Homeserver proof does not match this challenge');
    expect(p.ledgers[1].incoming).toHaveLength(1);
    published.set(`${owner}${storageProofPath(e)}`, storageProofBody(c, e));
    await p.peers[1].receive({ t: 'proof-present', challenge: c, event: e });
    expect(p.ledgers[1].remote[0]).toMatchObject({ status: 'accepted' });
    expect(p.ledgers[1].incoming).toHaveLength(0);
  });

  it('a challenge may not stretch its signed lifetime', async () => {
    const p = pair();
    p.offline();
    const c = await (async () => { const pending = p.peers[0].prepare('a'.repeat(64)); await p.peers[1].receive(p.frames[0][0]); await p.peers[0].receive(p.frames[1][0]); return pending; })();
    const e = { id: '0'.repeat(64) } as ImportedProof;
    await expect(p.peers[0].submit({ ...c, expiresAt: c.expiresAt + 1 }, e)).rejects.toThrow('belongs to another connection');
    await expect(p.peers[0].submit({ ...c, expiresAt: c.issuedAt + STORAGE_LIFETIME }, e)).rejects.toThrow('belongs to another connection');
    await expect(p.peers[0].submit({ ...c, subject: c.audience }, e)).rejects.toThrow('belongs to another connection');
    await expect(p.peers[0].submit({ ...c, issuedAt: 1.5 }, e)).rejects.toThrow('belongs to another connection');
    await expect(p.peers[0].submit(null as unknown as ProofChallenge, e)).rejects.toThrow('belongs to another connection');
  });

  it('refuses to submit or accept a proof whose adapter the peer does not support', async () => {
    let allow = true;
    const p = pair({ supports: a => allow || a === 'nostr' });
    const c = await p.peers[0].prepare(pubky.pubKeyZ32, 'pubky-import');
    const e = await pubkySign(c);
    allow = false;
    await expect(p.peers[0].submit(c, e)).rejects.toThrow('Peer does not support this proof');
    await p.peers[1].receive({ t: 'proof-present', challenge: c, event: e });
    expect(p.errors[1]).toHaveBeenLastCalledWith('Unsupported peer proof');
    expect(p.ledgers[1].remote).toEqual([]);
  });

  it('refuses a present whose challenge disappeared between verification and recording', async () => {
    const p = pair();
    p.offline();
    const pending = p.peers[0].prepare(pubky.pubKeyZ32, 'pubky-import');
    await p.peers[1].receive(p.frames[0][0]);
    await p.peers[0].receive(p.frames[1][0]);
    const c = await pending;
    const e = await pubkySign(c);
    // Another delivery of the same present consumes the nonce first; exactly one is recorded.
    await Promise.all([p.peers[1].receive({ t: 'proof-present', challenge: c, event: e }), p.peers[1].receive({ t: 'proof-present', challenge: c, event: e })]);
    expect(p.ledgers[1].remote).toHaveLength(1);
    expect(p.errors[1]).toHaveBeenLastCalledWith('Unknown or reused proof challenge');
    expect(p.frames[1].filter(f => f.t === 'proof-accepted')).toHaveLength(1);
  });
});

describe('acknowledgements and withdrawal', () => {
  const record = (status: ProofRecord['status'], over: Partial<ProofChallenge>, id: string): ProofRecord =>
    ({ challenge: challenge('nostr', 'a'.repeat(64), over), event: { id } as ProofRecord['event'], verifiedAt: NOW, status });

  it('marks accepted only a pending record of this conversation', async () => {
    const p = pair();
    const mine = { subject: p.keys[0], audience: p.keys[1], ...p.scope };
    p.ledgers[0].local = [record('pending', { ...mine, context: 'f'.repeat(64) }, '1'.repeat(64)), record('withdrawn', mine, '2'.repeat(64)), record('pending', mine, '3'.repeat(64))];
    for (const id of ['1', '2', '3']) await p.peers[0].receive({ t: 'proof-accepted', id: id.repeat(64) });
    expect(p.ledgers[0].local.map(r => r.status)).toEqual(['pending', 'withdrawn', 'accepted']);
  });

  it('a peer cannot mark a proof withdrawn that the person did not withdraw', async () => {
    const p = pair();
    const mine = { subject: p.keys[0], audience: p.keys[1], ...p.scope };
    p.ledgers[0].local = [record('accepted', mine, '1'.repeat(64)), record('withdrawal-pending', mine, '2'.repeat(64))];
    for (const id of ['1', '2']) await p.peers[0].receive({ t: 'proof-withdrawn', id: id.repeat(64) });
    expect(p.ledgers[0].local.map(r => r.status)).toEqual(['accepted', 'withdrawn']);
  });

  it('acknowledges a withdrawal only for a well-formed id, and withdraws only that proof', async () => {
    const p = pair();
    p.offline();
    p.ledgers[1].remote = [record('accepted', {}, '1'.repeat(64)), record('accepted', {}, '5'.repeat(64))];
    await p.peers[1].receive({ t: 'proof-withdraw', id: 'not-hex' });
    await p.peers[1].receive({ t: 'proof-withdraw', id: 12 });
    expect(p.frames[1]).toEqual([]);
    await p.peers[1].receive({ t: 'proof-withdraw', id: '1'.repeat(64) });
    expect(p.ledgers[1].remote.map(r => r.status)).toEqual(['withdrawn', 'accepted']);
    expect(p.frames[1]).toEqual([{ t: 'proof-withdrawn', id: '1'.repeat(64) }]);
  });

  it('withdraws only the chosen adapter\'s proof', async () => {
    const p = pair();
    p.offline();
    const mine = { subject: p.keys[0], audience: p.keys[1], ...p.scope };
    p.ledgers[0].local = [record('accepted', mine, '1'.repeat(64)), { ...record('accepted', mine, '2'.repeat(64)), challenge: challenge('pubky-import', createIdentity().pubKeyZ32, mine) }];
    await p.peers[0].withdraw('pubky-import');
    expect(p.ledgers[0].local.map(r => r.status)).toEqual(['accepted', 'withdrawal-pending']);
    expect(p.frames[0]).toEqual([{ t: 'proof-withdraw', id: '2'.repeat(64) }]);
  });

  it('withdrawing with nothing shared sends nothing; resending covers only this conversation', async () => {
    const p = pair();
    p.offline();
    await p.peers[0].withdraw('keet-import');
    expect(p.frames[0]).toEqual([]);
    const mine = { subject: p.keys[0], audience: p.keys[1], ...p.scope };
    p.ledgers[0].local = [record('withdrawal-pending', mine, '1'.repeat(64)), record('withdrawal-pending', { ...mine, context: 'f'.repeat(64) }, '2'.repeat(64)),
      record('withdrawal-pending', { ...mine, audience: createIdentity().pubKeyZ32 }, '3'.repeat(64)), record('accepted', mine, '4'.repeat(64))];
    p.peers[0].resendWithdrawals();
    expect(p.frames[0]).toEqual([{ t: 'proof-withdraw', id: '1'.repeat(64) }]);
  });

  it('ignores frames of unknown type', async () => {
    const p = pair();
    await p.peers[0].receive({ t: 'proof-something-else', id: '1'.repeat(64) });
    await p.peers[0].receive({});
    expect(p.errors[0]).not.toHaveBeenCalled();
    expect(p.frames[0]).toEqual([]);
  });
});
