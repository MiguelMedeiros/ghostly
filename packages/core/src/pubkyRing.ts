/** Experimental Ring identity authorization. NOT a Pubky homeserver grant.
 * This module is also copied verbatim into the separately built Ring extension.
 * An authorization delegates exactly one peer challenge; it carries no resource capabilities.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { base64urlnopad } from '@scure/base';
import { fromZ32, toZ32, utf8Encode, utf8Decode } from './bytes';
export const RING_LIFETIME = 600;
export const RING_RELAY = 'https://httprelay.pubky.app/inbox';
const enc = base64urlnopad.encode, dec = base64urlnopad.decode;
const hash = (s: string) => enc(sha256(utf8Encode(s)));
const header = enc(utf8Encode(JSON.stringify({alg:'EdDSA',typ:'ghostly-pubky-identity-delegation/1'})));
export interface RingEvidence { id: string; scheme: 'pubky-ring/1'; authorization: string; signature: string }
export interface RingClaims { iss: string; cnf: string; aud: 'ghostly-peer-proof/1'; challenge: string; iat: number; exp: number }
export function ringClaims(statement: string, issuer: string, delegate: string, issuedAt: number, expiresAt: number): RingClaims {
  return {iss:issuer,cnf:delegate,aud:'ghostly-peer-proof/1',challenge:hash(statement),iat:issuedAt,exp:expiresAt};
}
export function ringAuthorization(claims: RingClaims, seed: Uint8Array): string {
  if(toZ32(ed25519.getPublicKey(seed))!==claims.iss) throw new Error('Ring identity mismatch');
  const input=header+'.'+enc(utf8Encode(JSON.stringify(claims)));
  return input+'.'+enc(ed25519.sign(utf8Encode(input),seed));
}
export function verifyRingAuthorization(authorization: string, statement: string, issuer: string, issuedAt: number, expiresAt: number): RingClaims {
  if(typeof authorization!=='string'||authorization.length>2400)throw new Error('Invalid Ring authorization');
  const [h,p,s,...extra]=authorization.split('.');
  if(extra.length||h!==header||!p||!s)throw new Error('Unsupported Ring authorization');
  const claims=JSON.parse(utf8Decode(dec(p))) as RingClaims;
  if(typeof claims?.cnf!=='string'||!validRingKey(claims.cnf)||expiresAt!==issuedAt+RING_LIFETIME||
    p!==enc(utf8Encode(JSON.stringify(ringClaims(statement,issuer,claims.cnf,issuedAt,expiresAt))))||
    !validRingKey(issuer)||dec(s).length!==64||enc(dec(s))!==s||
    !ed25519.verify(dec(s),utf8Encode(h+'.'+p),fromZ32(issuer),{zip215:false}))throw new Error('Ring did not authorize this exact conversation');
  return claims;
}
export function validRingKey(key: string): boolean {
  try{return /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(key)&&toZ32(fromZ32(key))===key;}catch{return false;}
}
const possession = (authorization: string, statement: string) => utf8Encode(JSON.stringify(['ghostly-pubky-possession',1,hash(authorization),statement]));
function evidenceId(authorization: string, signature: string): string {
  return Array.from(sha256(utf8Encode(JSON.stringify(['pubky-ring/1',authorization,signature]))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function ringEvidence(authorization: string, statement: string, delegatedSeed: Uint8Array): RingEvidence {
  const signature=enc(ed25519.sign(possession(authorization,statement),delegatedSeed));
  return {id:evidenceId(authorization,signature),scheme:'pubky-ring/1',authorization,signature};
}
export function verifyRingEvidence(e: RingEvidence, statement: string, issuer: string, issuedAt: number, expiresAt: number): void {
  if(!e||e.scheme!=='pubky-ring/1'||typeof e.signature!=='string'||e.signature.length!==86)throw new Error('Invalid Ring proof');
  const claims=verifyRingAuthorization(e.authorization,statement,issuer,issuedAt,expiresAt);
  const sig=dec(e.signature);
  if(enc(sig)!==e.signature||e.id!==evidenceId(e.authorization,e.signature)||!ed25519.verify(sig,possession(e.authorization,statement),fromZ32(claims.cnf),{zip215:false}))throw new Error('Invalid delegated proof of possession');
}
export type RingSlot='identity'|'challenge'|'approval';
export function ringChannel(secret: Uint8Array, slot: RingSlot): string {return hash('ghostly-ring-channel/1:'+enc(secret)+':'+slot);}
export function sealRing(secret: Uint8Array, slot: RingSlot, value: unknown): Uint8Array {
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const plain=utf8Encode(JSON.stringify(value)); if(plain.length>4096)throw new Error('Ring message too large');
  const cipher=gcm(secret,nonce,utf8Encode('ghostly-ring/1:'+slot)).encrypt(plain);
  const result=new Uint8Array(12+cipher.length);result.set(nonce);result.set(cipher,12);return result;
}
export function openRing(secret: Uint8Array, slot: RingSlot, data: Uint8Array): unknown {
  if(data.length<28||data.length>4124)throw new Error('Invalid Ring message size');
  return JSON.parse(utf8Decode(gcm(secret,data.subarray(0,12),utf8Encode('ghostly-ring/1:'+slot)).decrypt(data.subarray(12))));
}
export async function ringSend(secret: Uint8Array, slot: RingSlot, value: unknown, signal: AbortSignal): Promise<void> {
  const body=sealRing(secret,slot,value);
  const res=await fetch(RING_RELAY+'/'+ringChannel(secret,slot),{method:'POST',body:new Uint8Array(body),headers:{'Content-Type':'application/octet-stream'},signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  if(!res.ok)throw new Error('Ring relay unavailable');
}
export async function ringReceive(secret: Uint8Array, slot: RingSlot, signal: AbortSignal): Promise<unknown> {
  const url=RING_RELAY+'/'+ringChannel(secret,slot);
  for(let tries=0;tries<8;tries++){
    if(signal.aborted)throw new Error('Ring request cancelled');
    const r=await fetch(url,{signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
    if(r.status===408)continue;
    if(!r.ok)throw new Error('Ring relay unavailable');
    if(Number(r.headers.get('content-length'))>4124)throw new Error('Ring response too large');
    // RN fetch has no streaming body. The relay itself bounds payload size;
    // browser consumers additionally stop reading before allocating a large body.
    let bytes:Uint8Array;
    if(r.body?.getReader){const reader=r.body.getReader();const parts:Uint8Array[]=[];let size=0;try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>4124)throw new Error('Ring response too large');parts.push(x.value);}}finally{await reader.cancel().catch(()=>{});}bytes=new Uint8Array(size);let n=0;for(const part of parts){bytes.set(part,n);n+=part.length;}}
    else bytes=new Uint8Array(await r.arrayBuffer());
    const result=openRing(secret,slot,bytes);
    await fetch(url,{method:'DELETE',signal,credentials:'omit',redirect:'error'}).catch(()=>{});
    return result;
  }
  throw new Error('Ring approval timed out');
}
export function inspectRingStatement(statement: string, issuer: string, now=Math.floor(Date.now()/1000)): {subject:string;audience:string;context:string;issuedAt:number;expiresAt:number} {
  if(typeof statement!=='string'||statement.length>1600)throw new Error('Invalid conversation request');
  const p=JSON.parse(statement);
  if(!Array.isArray(p)||p.length!==12||JSON.stringify(p)!==statement||p[0]!=='ghostly-peer-proof'||p[1]!==1||p[2]!=='delegated-conversation-proof'||p[3]!=='pubky-ring'||p[4]!==issuer||!validRingKey(issuer)||
    !validRingKey(p[5])||!validRingKey(p[6])||p[5]===p[6]||!/^[a-f0-9]{64}$/.test(p[7])||!/^[a-f0-9]{64}$/.test(p[8])||!/^[A-Za-z0-9_-]{43}$/.test(p[9])||
    !Number.isSafeInteger(p[10])||!Number.isSafeInteger(p[11])||p[11]!==p[10]+RING_LIFETIME||p[10]>now+30||p[10]<now-300||p[11]<=now)throw new Error('Invalid conversation request');
  return {subject:p[5],audience:p[6],context:p[7],issuedAt:p[10],expiresAt:p[11]};
}
