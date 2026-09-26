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
// Fixed public infrastructure only (PUBLIC-PROFILES.md, "Picture hosts"). A picture URL comes from the account, so an
// open list would let anyone who shares a profile log who views their card and from where: only large shared media
// hosts are asked, never the account's own server. Never a local or private host, never an arbitrary relay.
export const IMAGE_HOSTS: ReadonlySet<string> = new Set([
  // nostr.build, the most used Nostr picture host (nostr.build and cdn.nostr.build links are rewritten, see below).
  'nostr.build','image.nostr.build','i.nostr.build','pfp.nostr.build','cdn.nostr.build','media.nostr.band',
  // Primal's uploads and Blossom server (they redirect to Primal's storage, below).
  'm.primal.net','blossom.primal.net',
  // Blossom and NIP-96 media servers.
  'blossom.ditto.pub','cdn.nostrcheck.me','nostrcheck.me','nostr.download','cdn.azzamo.media',
  // Avatar hosts many Nostr profiles point at.
  'pbs.twimg.com','avatars.githubusercontent.com','i.imgur.com','files.mastodon.social',
  // Pubky's index (its avatar route).
  'nexus.pubky.app',
]);
/** Hosts that answer with a redirect to their own storage, and where to: any other destination is refused. */
export const IMAGE_REDIRECTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'm.primal.net': new Set(['r2a.primal.net','primal.b-cdn.net']),
  'blossom.primal.net': new Set(['r2a.primal.net','primal.b-cdn.net']),
};
/**
 * nostr.build's short links (`nostr.build/i/…`, `cdn.nostr.build/i/…`) redirect to image.nostr.build without a CORS
 * header, so a page could never read them: they are rewritten to where they redirect.
 */
const NOSTR_BUILD_SHORT = /^https:\/\/(?:cdn\.)?nostr\.build\/i\/([A-Za-z0-9._-]{1,200})$/;

/** An avatar address on one of `hosts` (the fixed list by default): https, port 443, no credentials or fragment. */
export function safeAvatarUrl(value: string, hosts: ReadonlySet<string> = IMAGE_HOSTS): string | undefined {
  try { const u = new URL(value); if (value.length > 2048 || u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !hosts.has(u.hostname) || u.hash) return; return u.href; } catch { return; }
}
export async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) throw new Error('Profile response unavailable');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > max) throw new Error('Profile response too large'); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part,offset); offset += part.length; } return bytes;
}
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
/** The dimensions a PNG, JPEG or WebP header declares (read before anything is decoded), or undefined. */
export function rasterDimensions(b: Uint8Array): { width: number; height: number; mime: string } | undefined {
  const v = new DataView(b.buffer,b.byteOffset,b.byteLength);
  if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((x,i) => b[i] === x) && ascii(b,12,16) === 'IHDR') return { width:v.getUint32(16), height:v.getUint32(20), mime:'image/png' };
  if (b[0] === 255 && b[1] === 216) {
    let i=2; while (i+4 <= b.length) { if (b[i++] !== 255) return; const marker=b[i++]; if (marker===0xd9 || marker===0xda) return; const size=v.getUint16(i); if (size < 2 || i+size>b.length) return; if ([0xc0,0xc1,0xc2].includes(marker) && size>=8) return {width:v.getUint16(i+5),height:v.getUint16(i+3),mime:'image/jpeg'}; i+=size; }
  }
  // WebP (RIFF … WEBP): lossy `VP8 `, lossless `VP8L` or extended `VP8X`, each with its own header.
  if (b.length >= 30 && ascii(b,0,4) === 'RIFF' && ascii(b,8,12) === 'WEBP') {
    const chunk = ascii(b,12,16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width:v.getUint16(26,true) & 0x3fff, height:v.getUint16(28,true) & 0x3fff, mime:'image/webp' };
    if (chunk === 'VP8L' && b[20] === 0x2f) { const bits=v.getUint32(21,true); return { width:(bits & 0x3fff)+1, height:((bits>>>14) & 0x3fff)+1, mime:'image/webp' }; }
    if (chunk === 'VP8X') return { width:1+(b[24] | b[25]<<8 | b[26]<<16), height:1+(b[27] | b[28]<<8 | b[29]<<16), mime:'image/webp' };
  }
}
/** What a picture's bytes look like, for the reason it is not shown ("a GIF", "an SVG"). */
function formatName(b: Uint8Array): string {
  const head = ascii(b,0,Math.min(b.length,256)).trimStart().toLowerCase();
  if (head.startsWith('gif8')) return 'a GIF';
  if (ascii(b,4,12).startsWith('ftypavi')) return 'an AVIF';
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'an SVG';
  if (head.startsWith('<')) return 'a web page';
  if (ascii(b,0,4) === 'RIFF' && ascii(b,8,12) === 'WEBP') return 'a WebP this app cannot read';
  return 'not a picture this app reads';
}
/** Most bytes an avatar download may have, and the most pixels it may decode to (checked before decoding). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_SIDE = 2048;
export const AVATAR_MAX_PIXELS = 4_000_000;
/** A kept picture's side, in pixels: chat avatars, and the larger one a public profile's card wears. */
export const AVATAR_SIDE = 96;
export const PROFILE_AVATAR_SIDE = 160;
/** Largest kept picture. */
const AVATAR_KEPT_BYTES = 32 * 1024;

/**
 * A picture, or why there is none: `miss` says which rule refused it, in words ("it is a GIF…"), for the card's details
 * and the log. It never names the identity.
 */
export interface AvatarResult { avatar?: string; miss?: string }

const toDataUrl = async (blob: Blob) => { const small=new Uint8Array(await blob.arrayBuffer()); let s=''; for (let i=0;i<small.length;i+=0x8000) s+=String.fromCharCode(...small.subarray(i,i+0x8000)); return 'data:image/jpeg;base64,'+btoa(s); };

/**
 * Downloaded avatar bytes → a `side`×`side` JPEG data URL of at most 32 KiB (its middle square, so nothing is
 * stretched), or the reason there is none. Only PNG, JPEG and WebP whose header gives dimensions within the limits are
 * decoded; SVG, HTML, GIF and anything else never are.
 */
export async function decodeAvatar(bytes: Uint8Array, side = AVATAR_SIDE): Promise<AvatarResult> {
  if (bytes.length > AVATAR_MAX_BYTES) return { miss: `it is larger than ${AVATAR_MAX_BYTES / 1024 / 1024} MiB` };
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return { miss: 'this app cannot resize pictures here' };
  const shape=rasterDimensions(bytes);
  if (!shape) return { miss: `it is ${formatName(bytes)}; only PNG, JPEG and WebP pictures are shown` };
  if (shape.width<1 || shape.height<1 || shape.width>AVATAR_MAX_SIDE || shape.height>AVATAR_MAX_SIDE || shape.width*shape.height>AVATAR_MAX_PIXELS) return { miss: `it is ${shape.width} × ${shape.height} pixels, more than this app decodes` };
  try {
    const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:shape.mime}));
    try {
      const canvas=new OffscreenCanvas(side,side); const ctx=canvas.getContext('2d'); if(!ctx) return { miss: 'this app cannot resize pictures here' };
      const crop=Math.min(bitmap.width || shape.width, bitmap.height || shape.height);
      ctx.drawImage(bitmap,((bitmap.width || shape.width)-crop)/2,((bitmap.height || shape.height)-crop)/2,crop,crop,0,0,side,side);
      for (const quality of [0.82,0.6]) { const blob=await canvas.convertToBlob({type:'image/jpeg',quality}); if (blob.size<=AVATAR_KEPT_BYTES) return { avatar: await toDataUrl(blob) }; }
      return { miss: 'it stays too large once resized' };
    } finally { bitmap.close(); }
  } catch { return { miss: 'it could not be decoded' }; }
}
export async function smallAvatar(bytes: Uint8Array, side = AVATAR_SIDE): Promise<string | undefined> {
  return (await decodeAvatar(bytes, side)).avatar;
}

/** Where a picture URL is fetched from: the rewritten short link, the hosts it may end up on, or why it is not asked. */
export function avatarSource(url: string, hosts: ReadonlySet<string> = IMAGE_HOSTS): { url: string; host: string; finalHosts: ReadonlySet<string> } | { miss: string } {
  const short = NOSTR_BUILD_SHORT.exec(url);
  const target = short ? `https://image.nostr.build/${short[1]}` : url;
  const safe = safeAvatarUrl(target, hosts);
  if (!safe) {
    let host = '';
    try { const u = new URL(url); host = u.protocol === 'https:' ? u.hostname : ''; } catch { /* not a URL */ }
    return { miss: host ? `it is on ${host}, a host this app does not load pictures from` : 'its address is not an https link' };
  }
  const host = new URL(safe).hostname;
  return { url: safe, host, finalHosts: new Set([host, ...(IMAGE_REDIRECTS[host] ?? [])]) };
}

/**
 * Fetches and resizes a picture from the fixed hosts: no credentials, cookies or referrer, a time-out, the byte cap,
 * and no redirects, except the fixed ones of IMAGE_REDIRECTS (the answer must then come from a host listed there).
 * `hosts` are the hosts asked, for the card's "Loaded from".
 */
export async function fetchAvatar(url: string, { fetcher = fetch, hosts = IMAGE_HOSTS, side = AVATAR_SIDE, signal }: { fetcher?: typeof fetch; hosts?: ReadonlySet<string>; side?: number; signal?: AbortSignal } = {}): Promise<AvatarResult & { hosts: string[] }> {
  const source = avatarSource(url, hosts);
  if ('miss' in source) return { miss: source.miss, hosts: [] };
  const redirects = IMAGE_REDIRECTS[source.host];
  const asked = [source.host];
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(10_000);
    response = await fetcher(source.url,{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials:'omit', referrerPolicy:'no-referrer', redirect: redirects ? 'follow' : 'error', cache:'no-store' });
  } catch { return { miss: redirects ? `${source.host} could not be reached` : `${source.host} could not be reached, or redirected elsewhere`, hosts: asked }; }
  if (response.redirected || (response.url && response.url !== source.url)) {
    let final = '';
    try { final = new URL(response.url).hostname; } catch { /* no final address */ }
    if (!redirects || !final || !source.finalHosts.has(final)) { await response.body?.cancel().catch(() => {}); return { miss: `${source.host} redirected it to ${final || 'another host'}`, hosts: asked }; }
    if (final !== source.host) asked.push(final);
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return { miss: `${asked[asked.length - 1]} answered ${response.status}`, hosts: asked }; }
  let bytes: Uint8Array;
  try { bytes = await boundedBytes(response, AVATAR_MAX_BYTES); } catch { return { miss: `it is larger than ${AVATAR_MAX_BYTES / 1024 / 1024} MiB, or could not be downloaded`, hosts: asked }; }
  return { ...(await decodeAvatar(bytes, side)), hosts: asked };
}
export async function cacheAvatar(url?: string, fetcher: typeof fetch = fetch, hosts: ReadonlySet<string> = IMAGE_HOSTS): Promise<string | undefined> {
  if (!url) return;
  return (await fetchAvatar(url, { fetcher, hosts })).avatar;
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
