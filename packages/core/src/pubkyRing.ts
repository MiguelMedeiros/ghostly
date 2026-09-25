/** The retired experimental Ring identity authorization (a modified Pubky Ring signed one peer challenge per
 * conversation). NOT a Pubky homeserver grant; the official Ring never supported it, and nothing makes it any more:
 * Pubky identities are the `pubky` identity provider now (WISP 302, pubkyProofs.ts). What is left verifies
 * evidence a contact already accepted, so old records are not orphaned.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { fromZ32, toZ32, utf8Encode, utf8Decode } from './bytes';
export const RING_LIFETIME = 600;
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
