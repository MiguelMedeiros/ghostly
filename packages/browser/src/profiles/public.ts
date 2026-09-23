import { verifyEvent, type Event } from 'nostr-tools/pure';
import type { ProofAdapter, ProofRecord } from '@ghostly/core';

export interface PublicProfile {
  adapter: ProofAdapter; key: string; name?: string; avatar?: string;
  fetchedAt: number; checkedAt?: number; source: 'nostr-signed' | 'pubky-index' | 'unavailable';
  eventAt?: number; eventId?: string;
}
export type ProfileChoice = 'auto' | 'ghostly' | ProofAdapter;
export const PROFILE_TTL = 24 * 60 * 60 * 1000;
export const PROFILE_RETRY = 5 * 60 * 1000;
export function currentProfileProof(r: ProofRecord, subject?: string, audience?: string, now = Date.now()): boolean {
  return r.status === 'accepted' && r.challenge.expiresAt * 1000 > now && r.challenge.subject === subject && r.challenge.audience === audience;
}
export function selectedProfile(profiles: PublicProfile[] = [], proofs: ProofRecord[] = [], choice: ProfileChoice = 'auto', subject?: string, audience?: string, now = Date.now()): PublicProfile | undefined {
  if (choice === 'ghostly') return;
  return profiles.filter(p => (p.name || p.avatar) && (choice === 'auto' || choice === p.adapter) && proofs.some(r => r.challenge.adapter === p.adapter && r.challenge.externalKey === p.key && currentProfileProof(r, subject, audience, now)))
    .sort((a,b) => a.adapter.localeCompare(b.adapter))[0];
}
export function profileName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return;
  // Treat as plain text; remove controls and bidi overrides, never render HTML.
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 64); // eslint-disable-line no-control-regex
  return name || undefined;
}
export function nostrMetadata(value: unknown, key: string, now = Date.now()): { name?: string; picture?: string; eventAt: number; eventId: string } | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const raw = value as Event;
    // Do not trust a cached verification symbol on a caller-owned SDK object.
    const e: Event = {id:raw.id,pubkey:raw.pubkey,kind:raw.kind,created_at:raw.created_at,tags:raw.tags,content:raw.content,sig:raw.sig};
    if (e.kind !== 0 || e.pubkey !== key || typeof e.content !== 'string' || e.content.length > 8192 || !Number.isSafeInteger(e.created_at) || e.created_at < 0 || e.created_at * 1000 > now + 30000 || !verifyEvent(e)) return;
    const data = JSON.parse(e.content);
    return { name: profileName(data.display_name) ?? profileName(data.name), picture: typeof data.picture === 'string' ? data.picture : undefined, eventAt: e.created_at, eventId: e.id };
  } catch { return; }
}
// Fixed public infrastructure only. Never follow an arbitrary metadata URL to a
// local/private host (including DNS rebinding), or discover arbitrary relays.
const IMAGE_HOSTS = new Set(['nostr.build','image.nostr.build','i.nostr.build','media.nostr.band','pfp.nostr.build','nexus.pubky.app']);
export function safeAvatarUrl(value: string): string | undefined {
  try { const u = new URL(value); if (value.length > 2048 || u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !IMAGE_HOSTS.has(u.hostname) || u.hash) return; return u.href; } catch { return; }
}
export async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) throw new Error('Profile response unavailable');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > max) throw new Error('Profile response too large'); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part,offset); offset += part.length; } return bytes;
}
export function rasterDimensions(b: Uint8Array): { width: number; height: number; mime: string } | undefined {
  const v = new DataView(b.buffer,b.byteOffset,b.byteLength);
  if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((x,i) => b[i] === x) && String.fromCharCode(...b.slice(12,16)) === 'IHDR') return { width:v.getUint32(16), height:v.getUint32(20), mime:'image/png' };
  if (b[0] === 255 && b[1] === 216) {
    let i=2; while (i+4 <= b.length) { if (b[i++] !== 255) return; const marker=b[i++]; if (marker===0xd9 || marker===0xda) return; const size=v.getUint16(i); if (size < 2 || i+size>b.length) return; if ([0xc0,0xc1,0xc2].includes(marker) && size>=8) return {width:v.getUint16(i+5),height:v.getUint16(i+3),mime:'image/jpeg'}; i+=size; }
  }
}
export async function cacheAvatar(url?: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  if (!url || !safeAvatarUrl(url) || typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
  try {
    const response = await fetcher(url,{ signal:AbortSignal.timeout(5000), credentials:'omit', referrerPolicy:'no-referrer', redirect:'error', cache:'no-store' });
    const bytes = await boundedBytes(response,256*1024); const shape=rasterDimensions(bytes);
    if (!shape || shape.width<1 || shape.height<1 || shape.width>2048 || shape.height>2048 || shape.width*shape.height>4_000_000) return;
    const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:shape.mime}));
    try {
      const canvas=new OffscreenCanvas(96,96); const ctx=canvas.getContext('2d'); if(!ctx) return;
      ctx.drawImage(bitmap,0,0,96,96); const blob=await canvas.convertToBlob({type:'image/jpeg',quality:0.8}); if(blob.size>32768) return;
      const small=new Uint8Array(await blob.arrayBuffer()); return 'data:image/jpeg;base64,'+btoa(String.fromCharCode(...small));
    } finally { bitmap.close(); }
  } catch { return; }
}
type Metadata = NonNullable<ReturnType<typeof nostrMetadata>>;
export function readNostrProfile(key: string, urls = ['wss://relay.damus.io','wss://nos.lol'], makeSocket = (url: string) => new WebSocket(url)): Promise<Metadata | undefined> {
  return Promise.all(urls.map(url => new Promise<Metadata | undefined>(resolve => {
    let socket: WebSocket; try { socket=makeSocket(url); } catch { resolve(undefined); return; }
    let best: Metadata | undefined; let count=0; let done=false;
    const finish=() => { if(done)return;done=true;clearTimeout(timer);try { if(socket.readyState===1) socket.send(JSON.stringify(['CLOSE','ghostly-profile'])); socket.close(); } catch { /* already closed */ } resolve(best); };
    const timer=setTimeout(finish,5000);
    socket.onopen=() => { if(done){socket.close();return;} socket.send(JSON.stringify(['REQ','ghostly-profile',{kinds:[0],authors:[key],limit:1}])); };
    socket.onerror=finish; socket.onclose=finish;
    socket.onmessage=message => {
      if(done)return;
      if(typeof message.data !== 'string' || message.data.length>16384 || ++count>20) {finish();return;}
      try { const frame=JSON.parse(message.data); if(frame[1]!=='ghostly-profile')return;
        if(frame[0]==='EOSE'){finish();return;} if(frame[0]!=='EVENT')return;
        const m=nostrMetadata(frame[2],key); if(m && (!best || m.eventAt>best.eventAt || (m.eventAt===best.eventAt && m.eventId<best.eventId)))best=m;
      }catch { /* malformed metadata does not affect chat */ }
    };
  }))).then(results => results.filter((p):p is Metadata=>!!p).sort((a,b)=>b.eventAt-a.eventAt || a.eventId.localeCompare(b.eventId))[0]);
}
export function pubkyMetadata(data: unknown,key: string): { name?: string; picture?: string } | undefined {
  if (!data || typeof data !== 'object')return;
  const d=data as Record<string,unknown>; if(d.id!==key)return;
  const name=profileName(d.name); if(name===key)return;
  return {name,picture:typeof d.image==='string' && d.image ? `https://nexus.pubky.app/static/avatar/${key}` : undefined};
}
export async function lookupPublicProfile(adapter: ProofAdapter,key: string): Promise<PublicProfile> {
  const empty:PublicProfile={adapter,key,fetchedAt:Date.now(),source:'unavailable'};
  try {
    if(adapter==='nostr' && /^[0-9a-f]{64}$/.test(key)) {
      const m=await readNostrProfile(key); if(!m)return empty;
      return {...empty,name:m.name,eventAt:m.eventAt,eventId:m.eventId,avatar:await cacheAvatar(m.picture),source:'nostr-signed'};
    }
    if((adapter==='pubky-import' || adapter==='pubky-storage') && /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(key)) {
      const response=await fetch(`https://nexus.pubky.app/v0/user/${key}/details`,{signal:AbortSignal.timeout(5000),credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'});
      const data=JSON.parse(new TextDecoder().decode(await boundedBytes(response,16384)));
      const m=pubkyMetadata(data,key); if(!m)return empty;
      return {...empty,name:m.name,avatar:await cacheAvatar(m.picture),source:'pubky-index'};
    }
  }catch { /* unavailable is a normal state, never a chat error */ }
  return empty;
}
