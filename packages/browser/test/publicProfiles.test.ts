import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createIdentity, type ProofRecord } from '@ghostly/core';
import { WebSocket } from 'ws';
import { db } from '../src/engine/db';
import { currentProfileProof, selectedProfile, nostrMetadata, pubkyMetadata, profileName, safeAvatarUrl, boundedBytes, rasterDimensions, cacheAvatar, readNostrProfile, lookupPublicProfile, type PublicProfile } from '../src/profiles/public';
import { startTestBunker } from './helpers/nostrBunker.mjs';
// covers: profiles.public, profiles.picture.sanitize

afterEach(()=>vi.unstubAllGlobals());
const now=Date.now();
function proof(adapter='nostr',key='test'): ProofRecord { return {status:'accepted',verifiedAt:now/1000,challenge:{adapter,externalKey:key,subject:'peer',audience:'me',expiresAt:Math.floor(now/1000)+3600},event:{id:'fixture'}} as ProofRecord; }
it('accepts signed kind-0 metadata only for the proved key; rejects forgery, oversize and future data',()=>{
 const secret=generateSecretKey(); const key=getPublicKey(secret);
 const e=finalizeEvent({kind:0,tags:[],created_at:Math.floor(now/1000),content:JSON.stringify({display_name:'Test Profile',picture:'https://image.nostr.build/test.png'})},secret);
 expect(nostrMetadata(e,key)?.name).toBe('Test Profile');
 expect(nostrMetadata({...e,content:'{"name":"forged"}'},key)).toBeUndefined();
 expect(nostrMetadata(e,getPublicKey(generateSecretKey()))).toBeUndefined();
 expect(nostrMetadata(finalizeEvent({...e,created_at:Math.floor(now/1000)+999},secret),key)).toBeUndefined();
 expect(nostrMetadata(finalizeEvent({...e,content:'x'.repeat(9000)},secret),key)).toBeUndefined();secret.fill(0);
});
it('reads actual fixture relay traffic and returns only its signed public profile',async()=>{
 const fixture=await startTestBunker();
 try { const profile=await readNostrProfile(fixture.userPub,[`ws://127.0.0.1:${fixture.port}`],url=>new WebSocket(url) as unknown as globalThis.WebSocket);expect(profile?.name).toBe('Ghostly test profile'); }
 finally {await fixture.close();}
});
it('binds Pubky indexed metadata to the requested key and never fabricates a Keet profile',async()=>{
 expect(pubkyMetadata({id:'different',name:'Alice'},'key')).toBeUndefined();
 expect(pubkyMetadata({id:'key',name:'Alice',image:'pubky://file'},'key')).toEqual({name:'Alice',picture:'https://nexus.pubky.app/static/avatar/key'});
 expect((await lookupPublicProfile('keet-import','f'.repeat(64))).source).toBe('unavailable');
 expect(profileName('x'.repeat(300))).toBeUndefined();expect(profileName('A\u202eB\n')).toBe('AB');
});
it('selects only a current conversation proof, supports choice, and falls back on withdrawal/expiry',()=>{
 const profiles:PublicProfile[]=[{adapter:'nostr',key:'n',name:'Nostr name',fetchedAt:now,source:'nostr-signed'},{adapter:'pubky-import',key:'p',name:'Pubky name',fetchedAt:now,source:'pubky-index'}];
 const proofs=[proof('nostr','n'),proof('pubky-import','p')];
 expect(selectedProfile(profiles,proofs,'pubky-import','peer','me')?.name).toBe('Pubky name');
 expect(selectedProfile(profiles,proofs,'ghostly','peer','me')).toBeUndefined();
 expect(selectedProfile(profiles,proofs,'auto','other','me')).toBeUndefined();
 proofs[0].status='withdrawn';expect(selectedProfile(profiles,proofs,'nostr','peer','me')).toBeUndefined();
 expect(currentProfileProof(proofs[1],'peer','me',now+86400000)).toBe(false);
 expect(selectedProfile(profiles,proofs,'auto','peer','me',now+86400000)).toBeUndefined();
});
it('rejects local, untrusted, credentialed and redirect-style avatar destinations',()=>{
 for(const url of ['http://image.nostr.build/a','https://127.0.0.1/a','https://localhost/a','https://192.168.1.1/a','https://[::1]/a','https://evil.test/a','https://image.nostr.build.evil.test/a','https://u:p@image.nostr.build/a','data:image/svg+xml,<svg/>','https://image.nostr.build:8443/a'])expect(safeAvatarUrl(url)).toBeUndefined();
 expect(safeAvatarUrl('https://image.nostr.build/a.png')).toBeTruthy();
});
it('bounds streaming bytes and rejects SVG and excessive raster dimensions before decoding',async()=>{
 await expect(boundedBytes(new Response('x'.repeat(100)),32)).rejects.toThrow();
 expect(rasterDimensions(new TextEncoder().encode('<svg/>'))).toBeUndefined();
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
 new DataView(bytes.buffer).setUint32(16,50000);
 const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);vi.stubGlobal('OffscreenCanvas',class{});vi.stubGlobal('fetch',vi.fn(async()=>new Response(bytes)));
 expect(await cacheAvatar('https://image.nostr.build/large.png')).toBeUndefined();expect(decode).not.toHaveBeenCalled();
});
it('stores only resized raster data and omits cookies, referrer and redirects',async()=>{
 const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]);
 const fetcher=vi.fn(async()=>new Response(bytes));vi.stubGlobal('fetch',fetcher);
 const close=vi.fn();vi.stubGlobal('createImageBitmap',vi.fn(async()=>({close})));
 vi.stubGlobal('OffscreenCanvas',class {getContext(){return{drawImage(){}};}async convertToBlob(){return new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});}});
 expect(await cacheAvatar('https://image.nostr.build/test.png')).toMatch(/^data:image\/jpeg;base64,/);
 expect(fetcher.mock.calls[0]).toHaveLength(2);expect(close).toHaveBeenCalled();
 const options=(fetcher.mock.calls as unknown as [string,RequestInit][])[0][1];expect(options).toMatchObject({credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
});
it('persists the per-contact cache/selection without overwriting manual names; deletes it with the chat',async()=>{
 const id='profile-cache-test';const seed=createIdentity(); const profile:PublicProfile={adapter:'nostr',key:'n',name:'Public name',avatar:'data:image/jpeg;base64,/9j/2Q==',fetchedAt:now,source:'nostr-signed'};
 await db.putLink({id,seedB64:seed.seedB64,peerPubKeyZ32:'peer',encKeyB64:seed.seedB64,createdAt:now,label:'My nickname'});
 await db.patchLink(id,{publicProfiles:[profile],profileChoice:'nostr'});
 const saved=(await db.getLinks()).find(l=>l.id===id)!;expect(saved.label).toBe('My nickname');expect(saved.publicProfiles).toEqual([profile]);expect(saved.profileChoice).toBe('nostr');
 expect((await db.getLinks()).filter(l=>l.id!==id).some(l=>l.publicProfiles?.includes(profile))).toBe(false);
 await db.deleteLink(id);expect((await db.getLinks()).find(l=>l.id===id)).toBeUndefined();
});

it('falls back cleanly when public services are offline without inventing a profile',async()=>{
 vi.stubGlobal('WebSocket',class {constructor(){throw new Error('offline');}});
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
 expect(await lookupPublicProfile('nostr','f'.repeat(64))).toMatchObject({source:'unavailable',key:'f'.repeat(64)});
 expect(await lookupPublicProfile('pubky-import','y'.repeat(52))).toMatchObject({source:'unavailable'});
});
