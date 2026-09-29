// Explicit isolated QA build only. Production Vite config never imports this.
// No invented account: the local signer owns this disposable key and signs kind 0.
export * from '../../src/profiles/public';
import { readNostrProfile, cacheAvatar, lookupPublicProfile as productionLookup } from '../../src/profiles/public';
import type { ProofAdapter } from '@ghostly/core';
export async function lookupPublicProfile(adapter: ProofAdapter, key: string) {
  if(adapter!=='nostr')return productionLookup(adapter,key);
  const metadata=await readNostrProfile(key,['ws://127.0.0.1:5189']);
  if(!metadata)return {adapter,key,fetchedAt:Date.now(),source:'unavailable' as const};
  const avatar=await cacheAvatar('https://image.nostr.build/ghostly-fixture.png',(_url,options)=>fetch('http://127.0.0.1:5189/avatar',options));
  return {adapter,key,name:metadata.name,eventAt:metadata.eventAt,eventId:metadata.eventId,avatar,fetchedAt:Date.now(),source:'nostr-signed' as const};
}
