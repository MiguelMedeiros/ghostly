import {afterEach,describe,expect,it,vi} from 'vitest';
import {base64urlnopad} from '@scure/base';
import {createIdentity,ringChannel,sealRing,openRing,ringClaims,ringAuthorization,proofStatement,verifyPeerProof,type ProofChallenge} from '@ghostly/core';
import {withPubkyRing} from '../src/proofs/ring';
// covers: core.ring-link, proofs.peer-proofs
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function relay(){
 const messages=new Map<string,Uint8Array>(),waiters=new Map<string,(r:Response)=>void>();
 vi.stubGlobal('fetch',vi.fn(async(input:string,init:RequestInit={})=>{
  const url=String(input);if(init.signal?.aborted)throw new Error('aborted');
  if(init.method==='POST'){const data=new Uint8Array(init.body as Uint8Array);messages.set(url,data);const waiting=waiters.get(url);if(waiting){waiters.delete(url);waiting(new Response(data));}return new Response('ok');}
  if(init.method==='DELETE'){messages.delete(url);return new Response('ok');}
  if(messages.has(url))return new Response(messages.get(url));
  return new Promise<Response>((resolve,reject)=>{waiters.set(url,resolve);init.signal?.addEventListener('abort',()=>{waiters.delete(url);reject(new Error('aborted'));},{once:true});});
 }));
 return {messages,waiters};
}
const base='https://httprelay.pubky.app/inbox/';
describe('Ring client lifecycle (transport fixture, not Ring app E2E)',()=>{
 it('sends only a context-bound public proof after separate external approval',async()=>{
  relay();const root=createIdentity(),submit=vi.fn(),pending:Promise<unknown>[]=[];
  await withPubkyRing({signal:new AbortController().signal,onProgress:vi.fn(),onLink:url=>{if(!url)return;pending.push((async()=>{const u=new URL(url),secret=base64urlnopad.decode(u.searchParams.get('secret')!),delegate=u.searchParams.get('delegate')!;
   await fetch(base+ringChannel(secret,'identity'),{method:'POST',body:new Uint8Array(sealRing(secret,'identity',{key:root.pubKeyZ32}))});
   const response=await fetch(base+ringChannel(secret,'challenge'));const {statement}=openRing(secret,'challenge',new Uint8Array(await response.arrayBuffer())) as {statement:string};const fields=JSON.parse(statement);
   const authorization=ringAuthorization(ringClaims(statement,root.pubKeyZ32,delegate,fields[10],fields[11]),root.seed);
   await fetch(base+ringChannel(secret,'approval'),{method:'POST',body:new Uint8Array(sealRing(secret,'approval',{authorization}))});
  })());},prepare:async key=>{const now=Math.floor(Date.now()/1000);return {adapter:'pubky-ring',externalKey:key,subject:createIdentity().pubKeyZ32,audience:createIdentity().pubKeyZ32,context:'a'.repeat(64),session:'b'.repeat(64),nonce:'Z'.repeat(43),issuedAt:now,expiresAt:now+600};},submit});
  await Promise.all(pending);expect(submit).toHaveBeenCalledTimes(1);const [c,e]=submit.mock.calls[0] as [ProofChallenge,Parameters<typeof verifyPeerProof>[0]];await verifyPeerProof(e,c);expect(proofStatement(c)).toContain('delegated-conversation-proof');
 });
 it('cancels before a late identity or signature can be submitted',async()=>{relay();const abort=new AbortController(),submit=vi.fn(),prepare=vi.fn(),onLink=vi.fn();const result=withPubkyRing({signal:abort.signal,onLink,onProgress:vi.fn(),prepare,submit});abort.abort();await expect(result).rejects.toThrow(/cancelled/);expect(prepare).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(onLink).toHaveBeenLastCalledWith('');});
 it('times out and clears the visible QR',async()=>{relay();vi.useFakeTimers();const onLink=vi.fn();const result=withPubkyRing({signal:new AbortController().signal,onLink,onProgress:vi.fn(),prepare:vi.fn(),submit:vi.fn()});const rejected=expect(result).rejects.toThrow(/timed out/);await vi.advanceTimersByTimeAsync(180001);await rejected;expect(onLink).toHaveBeenLastCalledWith('');});
 it('surfaces denial without requesting a peer challenge',async()=>{relay();const prepare=vi.fn();await expect(withPubkyRing({signal:new AbortController().signal,onLink:url=>{if(!url)return;const secret=base64urlnopad.decode(new URL(url).searchParams.get('secret')!);void fetch(base+ringChannel(secret,'identity'),{method:'POST',body:new Uint8Array(sealRing(secret,'identity',{cancelled:true}))});},onProgress:vi.fn(),prepare,submit:vi.fn()})).rejects.toThrow(/Cancelled in Pubky Ring/);expect(prepare).not.toHaveBeenCalled();});
});
