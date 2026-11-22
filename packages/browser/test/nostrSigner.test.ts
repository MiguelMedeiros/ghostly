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
  it('waits for a bunker the person approves after 30 s, and says its own words when two minutes pass', async () => {
    let approve!: () => void;
    let gate = new Promise<void>(resolve => { approve = resolve; });
    const fixture = await startTestBunker(0, { hold: () => gate });
    const sign = () => withNostrSigner({ bunker:fixture.bunker,signal:new AbortController().signal,onAuth:vi.fn() }, async signer => {
      const externalKey=await signer.getPublicKey();
      const c: ProofChallenge={adapter:'nostr',externalKey,subject:createIdentity().pubKeyZ32,audience:createIdentity().pubKeyZ32,
        context:'a'.repeat(64),session:'b'.repeat(64),nonce:'Z'.repeat(43),issuedAt:1800000000,expiresAt:1800086400};
      return signer.signEvent(nostrProofTemplate(c));
    });
    const asked = async (count: number) => { while (fixture.methods.filter((m: string) => m === 'sign_event').length < count) await new Promise(r => setImmediate(r)); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Approved on the phone a minute later: still signed.
      const late = sign();
      await asked(1);
      await vi.advanceTimersByTimeAsync(60_000);
      approve();
      await expect(late).resolves.toMatchObject({ pubkey: fixture.userPub });
      // Never approved: Ghostly's own two minutes and its own words.
      gate = new Promise<void>(() => {});
      const never = sign();
      const failed = expect(never).rejects.toThrow('Signer timed out. Your Ghostly identity is unchanged.');
      await asked(2);
      await vi.advanceTimersByTimeAsync(120_000);
      await failed;
    } finally { vi.useRealTimers(); await fixture.close(); }
  });
  // agents#6035: the work after the signature (the engine checking and saving the proof, a NIP-05 lookup up to 30 s)
  // was raced against the two minutes and the cancel too: "Your Ghostly identity is unchanged" while the proof was saved.
  it('lets the work after a signature finish when the cancel or the two minutes come meanwhile, and still ends a signer step that waits', async () => {
    let approve!: () => void;
    let gate = new Promise<void>(resolve => { approve = resolve; });
    const fixture = await startTestBunker(0, { hold: () => gate });
    const challenge = (externalKey: string): ProofChallenge => ({ adapter:'nostr',externalKey,subject:createIdentity().pubKeyZ32,audience:createIdentity().pubKeyZ32,
      context:'a'.repeat(64),session:'b'.repeat(64),nonce:'Z'.repeat(43),issuedAt:1800000000,expiresAt:1800086400 });
    const asked = async (count: number) => { while (fixture.methods.filter((m: string) => m === 'sign_event').length < count) await new Promise(r => setImmediate(r)); };
    try {
      for (const ending of ['cancel', 'two minutes'] as const) {
        const controller = new AbortController();
        let check!: () => void;
        const checked = new Promise<void>(resolve => { check = resolve; });
        let signed!: () => void;
        const hasSigned = new Promise<void>(resolve => { signed = resolve; });
        if (ending === 'two minutes') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const result = withNostrSigner({ bunker:fixture.bunker,signal:controller.signal,onAuth:vi.fn() }, async signer => {
            const event = await signer.signEvent(nostrProofTemplate(challenge(await signer.getPublicKey())));
            signed();
            await checked;
            return { saved: event.pubkey };
          });
          approve();
          await hasSigned;
          if (ending === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(120_000);
          check();
          await expect(result, ending).resolves.toEqual({ saved: fixture.userPub });
        } finally { vi.useRealTimers(); }
      }
      // A signer step still waiting on the phone is ended by the cancel, as before.
      gate = new Promise<void>(() => {});
      const controller = new AbortController();
      const waiting = withNostrSigner({ bunker:fixture.bunker,signal:controller.signal,onAuth:vi.fn() }, async signer =>
        signer.signEvent(nostrProofTemplate(challenge(await signer.getPublicKey()))));
      const failed = expect(waiting).rejects.toThrow('Signing cancelled');
      await asked(3);
      controller.abort();
      await failed;
    } finally { vi.useRealTimers(); await fixture.close(); }
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
      await vi.waitFor(()=>expect(getPublicKey).toHaveBeenCalled());
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
