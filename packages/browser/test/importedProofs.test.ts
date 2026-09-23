import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createIdentity, PeerProofs, emptyProofLedger, verifyPeerProof, type ProofAdapter, type ProofChallenge, type ProofLedger } from '@ghostly/core';
import { importLocalSigner, disposableImportSecret } from '../src/proofs/imported';
import { db } from '../src/engine/db';

function pair() {
  const keys=[createIdentity().pubKeyZ32,createIdentity().pubKeyZ32];
  const ledgers:ProofLedger[]=[emptyProofLedger(),emptyProofLedger()];
  const errors=[vi.fn(),vi.fn()], wire:object[]=[];
  let now=Math.floor(Date.now()/1000), session='b'.repeat(64);
  const peers:PeerProofs[]=[];
  for(let i=0;i<2;i++) peers[i]=new PeerProofs({
    scope:()=>({subject:keys[i],audience:keys[1-i],context:'a'.repeat(64),session}),now:()=>now,
    send:f=>{wire.push(f);queueMicrotask(()=>void peers[1-i].receive(f as Record<string,unknown>));},
    storage:{read:()=>ledgers[i],update:async f=>{ledgers[i]=f(structuredClone(ledgers[i]));}},onError:errors[i],
  });
  return {peers,ledgers,errors,wire,advance:(n:number)=>now+=n,reconnect:()=>session='c'.repeat(64)};
}
const adapters=['pubky-import','keet-import'] as const;
describe.each(adapters)('%s imported local proof',adapter=>{
  it('signs with a real SDK-derived disposable key, verifies remotely, rejects replay, preserves evidence across reconnect, withdraws with ack, and never serializes the secret',async()=>{
    const secret=await disposableImportSecret(adapter);
    const signer=await importLocalSigner(adapter,secret), p=pair();
    try {
      const c=await p.peers[0].prepare(signer.externalKey,adapter), event=await signer.sign(c);
      await verifyPeerProof(event,c); await p.peers[0].submit(c,event);
      await vi.waitFor(()=>expect(p.ledgers[0].local[0]?.status).toBe('accepted'));
      expect(p.ledgers[1].remote[0].event.id).toBe(event.id);
      await p.peers[1].receive({t:'proof-present',challenge:c,event}); expect(p.errors[1]).toHaveBeenLastCalledWith('Unknown or reused proof challenge');
      expect(JSON.stringify([p.wire,p.ledgers,signer]).includes(secret)).toBe(false);
      const row={id:crypto.randomUUID(),profile:'paired-chat/1' as const,participationSeed:createIdentity().seedB64,pairedPeerKey:c.audience,
        seedB64:createIdentity().seedB64,peerPubKeyZ32:createIdentity().pubKeyZ32,encKeyB64:createIdentity().seedB64,createdAt:Date.now()};
      await db.putLink(row); await db.updatePeerProofs(row.id,()=>p.ledgers[0]);
      expect(JSON.stringify(await db.getLinks()).includes(secret)).toBe(false);
      p.reconnect(); expect(p.ledgers[1].remote[0].event.id).toBe(event.id);
      await p.peers[0].withdraw(adapter);await vi.waitFor(()=>expect(p.ledgers[0].local[0].status).toBe('withdrawn'));
      expect(p.ledgers[1].remote[0].status).toBe('withdrawn');
      signer.clear();await expect(signer.sign(c)).rejects.toThrow(/unavailable/);
    } finally {signer.clear();p.peers.forEach(p=>p.stop());}
  });
  it('rejects altered signatures, wrong audience/context/challenge, expiry and old-session signing',async()=>{
    const signer=await importLocalSigner(adapter,await disposableImportSecret(adapter)),p=pair();
    try {
      const c=await p.peers[0].prepare(signer.externalKey,adapter),event=await signer.sign(c);
      await expect(verifyPeerProof({...event,signature:'A'.repeat(event.signature.length)},c)).rejects.toThrow();
      for(const field of ['audience','subject','context','nonce'] as const){
        const changed:ProofChallenge={...c,[field]:field==='audience'||field==='subject'?createIdentity().pubKeyZ32:field==='nonce'?'Z'.repeat(43):'d'.repeat(64)};
        await p.peers[1].receive({t:'proof-present',challenge:changed,event:await signer.sign(changed)});
        expect(p.ledgers[1].remote.length).toBe(0);
      }
      p.advance(301);await p.peers[1].receive({t:'proof-present',challenge:c,event});expect(p.ledgers[1].remote.length).toBe(0);
      const fresh=await p.peers[0].prepare(signer.externalKey,adapter);p.reconnect();
      await expect(p.peers[0].submit(fresh,await signer.sign(fresh))).rejects.toThrow(/connection/);
      expect(p.errors[1]).toHaveBeenCalled();
    }finally{signer.clear();p.peers.forEach(p=>p.stop());}
  });
});
it('preserves independent Pubky and Keet records on one participation and withdraws only the chosen adapter',async()=>{
  const p=pair();
  for(const adapter of adapters){const s=await importLocalSigner(adapter,await disposableImportSecret(adapter));try{const c=await p.peers[0].prepare(s.externalKey,adapter);await p.peers[0].submit(c,await s.sign(c));}finally{s.clear();}}
  await vi.waitFor(()=>expect(p.ledgers[1].remote.length).toBe(2));
  await p.peers[0].withdraw('pubky-import');await vi.waitFor(()=>expect(p.ledgers[0].local.find(r=>r.challenge.adapter==='pubky-import')?.status).toBe('withdrawn'));
  expect(p.ledgers[1].remote.find(r=>r.challenge.adapter==='keet-import')?.status).toBe('accepted');
  expect(pair().ledgers[1].remote).toEqual([]);p.peers.forEach(p=>p.stop());
});
it('does not disclose malformed secret input through errors',async()=>{
  for(const adapter of adapters){const invalid=crypto.randomUUID();try{await importLocalSigner(adapter,invalid);throw new Error('unexpected success');}catch(e){expect(String(e).includes(invalid)).toBe(false);}}
});
it('rejects a proof type the peer did not negotiate',async()=>{
  const p=new PeerProofs({scope:()=>({subject:'',audience:'',context:'',session:''}),send:vi.fn(),supports:(a:ProofAdapter)=>a==='nostr',storage:{read:emptyProofLedger,update:async()=>{}}});
  await expect(p.prepare('a'.repeat(64),'keet-import')).rejects.toThrow(/unavailable/);
});
