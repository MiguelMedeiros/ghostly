import {describe,it,expect,vi} from 'vitest';
import {createIdentity} from '../src/identity';
import {PeerProofs,PROOF_ADAPTERS,emptyProofLedger,isProofAdapter,proofStatement,verifyPeerProof,type ProofChallenge} from '../src/peerProofs';
import {ringClaims,ringAuthorization,ringEvidence,verifyRingEvidence} from '../src/pubkyRing';
// covers: proofs.peer-proofs
const root=createIdentity(),delegate=createIdentity();
function challenge():ProofChallenge {const now=Math.floor(Date.now()/1000);return {adapter:'pubky-ring',externalKey:root.pubKeyZ32,subject:createIdentity().pubKeyZ32,audience:createIdentity().pubKeyZ32,context:'a'.repeat(64),session:'b'.repeat(64),nonce:'Z'.repeat(43),issuedAt:now,expiresAt:now+600};}
function evidence(c:ProofChallenge){const statement=proofStatement(c);return ringEvidence(ringAuthorization(ringClaims(statement,root.pubKeyZ32,delegate.pubKeyZ32,c.issuedAt,c.expiresAt),root.seed),statement,delegate.seed);}
describe('experimental Ring per-conversation delegated proof',()=>{
 it('independently verifies the root authorization and separate temporary PoP, with no resource/session credential',async()=>{const c=challenge(),e=evidence(c);await verifyPeerProof(e,c);expect(Object.keys(e).sort()).toEqual(['authorization','id','scheme','signature']);});
 it.each(['subject','audience','context','session','nonce','externalKey','issuedAt','expiresAt'] as const)('rejects changed %s',async field=>{const c=challenge(),e=evidence(c);const value=typeof c[field]==='number'?Number(c[field])+1:field==='context'||field==='session'?'c'.repeat(64):field==='nonce'?'Y'.repeat(43):createIdentity().pubKeyZ32;await expect(verifyPeerProof(e,{...c,[field]:value})).rejects.toThrow();});
 it('rejects forged issuer, foreign delegate, wrong JWS type/algorithm, changed public authorization and oversized envelope',()=>{const c=challenge(),s=proofStatement(c),e=evidence(c);for(const patch of [{authorization:e.authorization+'x'},{signature:'A'.repeat(86)},{authorization:'A'.repeat(2500)},{id:'0'.repeat(64)},{scheme:'pubky-import/1'}])expect(()=>verifyRingEvidence({...e,...patch} as typeof e,s,c.externalKey,c.issuedAt,c.expiresAt)).toThrow();const other=createIdentity();const wrong=ringEvidence(e.authorization,s,other.seed);expect(()=>verifyRingEvidence(wrong,s,c.externalKey,c.issuedAt,c.expiresAt)).toThrow();});
 it('is retired from the live path while evidence already given still verifies',async()=>{
  // Ring is no longer offered or accepted in a live exchange: it is not in the
  // adapter registry, so neither end can start one. The ledger lifecycle it used
  // to exercise is covered by peerProofs.test.ts with an offered adapter.
  expect(PROOF_ADAPTERS).not.toContain('pubky-ring');
  expect(isProofAdapter('pubky-ring')).toBe(false);
  const peer=new PeerProofs({scope:()=>challenge(),send:vi.fn(),storage:{read:()=>emptyProofLedger(),update:async()=>{}},onError:vi.fn()});
  await expect(peer.prepare(root.pubKeyZ32,'pubky-ring')).rejects.toThrow(/unavailable/);
  peer.stop();
  // What a contact already accepted keeps verifying, so old evidence is not orphaned.
  const c=challenge();await verifyPeerProof(evidence(c),c);
 });
});
