import { describe, expect, it, vi } from 'vitest';
import { createIdentity, nostrProofTemplate, verifyNostrProof, type ProofChallenge } from '@ghostly/core';
import { parseProofBunker, withNostrSigner } from '../src/proofs/nostr';
// @ts-expect-error Native fixture is deliberately directly executable JavaScript.
import { startTestBunker } from './helpers/nostrBunker.mjs';
// covers: nostr.signer, proofs.nostr

describe('external Nostr signers', () => {
  it('uses an actual NIP-46 websocket exchange with distinct remote-signer/user keys and independently verifies the signed proof', async () => {
    const fixture = await startTestBunker();
    try {
      await withNostrSigner({ bunker:fixture.bunker,signal:new AbortController().signal,onAuth:vi.fn() }, async signer => {
        const externalKey=await signer.getPublicKey();
        expect(externalKey).toBe(fixture.userPub); expect(externalKey).not.toBe(fixture.signerPub);
        const c: ProofChallenge={adapter:'nostr',externalKey,subject:createIdentity().pubKeyZ32,audience:createIdentity().pubKeyZ32,
          context:'a'.repeat(64),session:'b'.repeat(64),nonce:'Z'.repeat(43),issuedAt:1800000000,expiresAt:1800086400};
        await verifyNostrProof(await signer.signEvent(nostrProofTemplate(c)),c);
      });
      expect(fixture.methods).toEqual(['connect','get_public_key','sign_event']);
    } finally { await fixture.close(); }
  });
  it('rejects secrets, insecure remote relays and unrelated URL schemes', () => {
    for(const input of ['nsec1secret','https://example.com',`bunker://${'a'.repeat(64)}?relay=ws://example.com`, `bunker://${'a'.repeat(64)}?relay=wss://user:pass@example.com`])
      expect(()=>parseProofBunker(input)).toThrow();
  });
  it('cancels signer work before it can request a signature', async () => {
    const controller=new AbortController(); controller.abort(); const work=vi.fn();
    await expect(withNostrSigner({signal:controller.signal,onAuth:vi.fn()},work)).rejects.toThrow(); expect(work).not.toHaveBeenCalled();
  });
});

describe('NIP-07 permission and cancellation', () => {
  it('does not submit a late signer result after cancellation', async () => {
    let resolveKey!: (key:string)=>void;
    const getPublicKey=vi.fn(()=>new Promise<string>(resolve=>{resolveKey=resolve;}));
    vi.stubGlobal('nostr',{getPublicKey,signEvent:vi.fn()});
    const controller=new AbortController(), afterKey=vi.fn();
    try {
      const result=withNostrSigner({signal:controller.signal,onAuth:vi.fn()},async signer=>{await signer.getPublicKey();afterKey();});
      controller.abort(); await expect(result).rejects.toThrow(/cancelled/);
      resolveKey('a'.repeat(64)); await new Promise(r=>setTimeout(r,0)); expect(afterKey).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('surfaces signer denial and does not request a signature', async () => {
    const signEvent=vi.fn(); vi.stubGlobal('nostr',{getPublicKey:async()=>{throw new Error('User declined');},signEvent});
    try { await expect(withNostrSigner({signal:new AbortController().signal,onAuth:vi.fn()},s=>s.getPublicKey())).rejects.toThrow('User declined'); expect(signEvent).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
});
