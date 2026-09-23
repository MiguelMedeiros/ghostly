import { describe, expect, it, vi } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createIdentity } from '../src/identity';
import { PeerProofs, emptyProofLedger, nostrProofTemplate, proofHash, verifyNostrProof, type ProofChallenge, type ProofLedger, type NostrProofEvent } from '../src/peerProofs';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2,'0')).join('');
const bytes = (s: string) => Uint8Array.from(s.match(/../g)!, x => parseInt(x,16));
const externalSeed = crypto.getRandomValues(new Uint8Array(32));
const externalKey = hex(schnorr.getPublicKey(externalSeed));
async function sign(c: ProofChallenge): Promise<NostrProofEvent> {
  const t = nostrProofTemplate(c);
  const id = await proofHash(JSON.stringify([0, externalKey, t.created_at, t.kind, t.tags, t.content]));
  return { ...t, pubkey: externalKey, id, sig: hex(schnorr.sign(bytes(id), externalSeed)) };
}
function pair() {
  const keys = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
  const ledgers: ProofLedger[] = [emptyProofLedger(), emptyProofLedger()];
  const errors = [vi.fn(), vi.fn()];
  let now = 1_800_000_000, context = 'a'.repeat(64), session = 'b'.repeat(64), fail = false;
  const frames: Record<string, unknown>[][] = [[], []];
  const peers: PeerProofs[] = [];
  for (let i = 0; i < 2; i++) peers[i] = new PeerProofs({
    scope: () => ({ subject: keys[i], audience: keys[1-i], context, session }),
    send: frame => { frames[i].push(structuredClone(frame) as Record<string, unknown>); queueMicrotask(() => void peers[1-i].receive(frame as Record<string, unknown>)); },
    storage: { read: () => ledgers[i], update: async change => { if (fail) throw new Error('disk failure'); ledgers[i] = change(structuredClone(ledgers[i])); } },
    now: () => now, onError: errors[i],
  });
  return { peers, ledgers, errors, frames, advance: (n: number) => now += n, reconnect: () => session = 'c'.repeat(64), otherChat: () => context = 'd'.repeat(64), failStorage: () => fail = true };
}

describe('optional scoped Nostr proofs', () => {
  it('signs exact external-key binding and durably accepts only once, including after a verifier restart', async () => {
    const p = pair(), c = await p.peers[0].prepare(externalKey), event = await sign(c);
    await p.peers[0].submit(c, event);
    await vi.waitFor(() => expect(p.ledgers[0].local[0]?.status).toBe('accepted'));
    expect(p.ledgers[1].remote[0].event).toEqual(event);
    expect(p.ledgers[1].incoming).toHaveLength(0);
    await p.peers[1].receive({ t: 'proof-present', challenge: c, event });
    expect(p.errors[1]).toHaveBeenLastCalledWith('Unknown or reused proof challenge');
    const restarted = new PeerProofs({ scope: () => ({ subject:c.audience, audience:c.subject, context:c.context, session:c.session }),
      send: vi.fn(), now: () => c.issuedAt, onError: p.errors[1], storage: { read: () => p.ledgers[1], update: async change => { p.ledgers[1] = change(p.ledgers[1]); } } });
    await restarted.receive({ t: 'proof-present', challenge:c, event });
    expect(p.errors[1]).toHaveBeenLastCalledWith('Unknown or reused proof challenge');
  });
  it.each(['subject','audience','context','session','nonce','externalKey'] as const)('rejects modified %s even with a valid signature', async field => {
    const p = pair(), c = await p.peers[0].prepare(externalKey);
    const altered = { ...c, [field]: field === 'subject' || field === 'audience' ? createIdentity().pubKeyZ32 : field === 'nonce' ? 'Z'.repeat(43) : 'e'.repeat(64) };
    await p.peers[1].receive({ t:'proof-present', challenge: altered, event: await sign(altered) });
    expect(p.ledgers[1].remote).toHaveLength(0); expect(p.errors[1]).toHaveBeenCalled();
  });
  it('rejects stale challenges and pending signatures from a previous transport/session', async () => {
    const p=pair(), c=await p.peers[0].prepare(externalKey), event=await sign(c);
    p.advance(301); await expect(p.peers[0].submit(c,event)).rejects.toThrow(/expired/);
    const d=await p.peers[0].prepare(externalKey); p.reconnect();
    await expect(p.peers[0].submit(d,await sign(d))).rejects.toThrow(/another connection/);
  });
  it('retains verified evidence across transport changes, expires it without extending the signed lifetime', async () => {
    const p=pair(), c=await p.peers[0].prepare(externalKey); await p.peers[0].submit(c,await sign(c));
    await vi.waitFor(() => expect(p.ledgers[1].remote).toHaveLength(1)); p.reconnect(); p.advance(86401);
    expect(p.ledgers[1].remote[0].challenge.expiresAt).toBe(c.issuedAt+86400);
    await p.peers[1].receive({ t:'proof-present', challenge:c, event:await sign(c) });
    expect(p.errors[1]).toHaveBeenCalled();
  });
  it('does not acknowledge or consume a challenge when durable storage fails', async () => {
    const p=pair(), c=await p.peers[0].prepare(externalKey); p.failStorage();
    await p.peers[1].receive({ t:'proof-present', challenge:c, event:await sign(c) });
    expect(p.ledgers[1].incoming).toHaveLength(1); expect(p.ledgers[1].remote).toHaveLength(0);
    expect(p.frames[1].some(f=>f.t==='proof-accepted')).toBe(false);
  });
  it('verifies withdrawal acknowledgement and cannot revive a withdrawn proof by replay', async () => {
    const p=pair(), c=await p.peers[0].prepare(externalKey); await p.peers[0].submit(c,await sign(c));
    await vi.waitFor(()=>expect(p.ledgers[0].local[0]?.status).toBe('accepted'));
    await p.peers[0].withdraw(); await vi.waitFor(()=>expect(p.ledgers[0].local[0].status).toBe('withdrawn'));
    expect(p.ledgers[1].remote[0].status).toBe('withdrawn');
    await p.peers[1].receive({ t:'proof-present', challenge:c, event:await sign(c) });
    expect(p.ledgers[1].remote[0].status).toBe('withdrawn');
  });
  it('rejects unrelated signed events, forged signatures, altered IDs and tags', async () => {
    const p=pair(), c=await p.peers[0].prepare(externalKey), event=await sign(c);
    await verifyNostrProof(event,c);
    for (const patch of [{content:'hello'}, {sig:'0'.repeat(128)}, {id:'0'.repeat(64)}, {tags:[]}])
      await expect(verifyNostrProof({...event,...patch},c)).rejects.toThrow();
  });
});
