import { ed25519 } from '@noble/curves/ed25519.js';
import { createRingLink, toZ32, proofStatement, ringReceive, ringSend, ringEvidence, verifyRingAuthorization, validRingKey, type ProofChallenge, type RingEvidence } from '@ghostly/core';
/** One foreground approval only: no persistent signer/session/seed. Closing cancels
 * and zeroes local buffers. Backgrounding is supported while this renderer lives;
 * restarting requires a fresh QR and peer nonce. */
export async function withPubkyRing(options:{signal:AbortSignal;onLink(url:string):void;onProgress(message:string):void;prepare(key:string):Promise<ProofChallenge>;submit(challenge:ProofChallenge,evidence:RingEvidence):Promise<void>}):Promise<void>{
  const secret=crypto.getRandomValues(new Uint8Array(32));
  const seed=crypto.getRandomValues(new Uint8Array(32));
  const delegate=toZ32(ed25519.getPublicKey(seed));
  const controller=new AbortController();
  const abort=()=>controller.abort();options.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),180_000);
  try {
    options.signal.throwIfAborted();
    const expires=Math.floor(Date.now()/1000)+180;
    options.onLink(createRingLink(secret,delegate,expires));
    const identity=await ringReceive(secret,'identity',controller.signal) as {key?:string;cancelled?:boolean};
    if(identity?.cancelled)throw new Error('Cancelled in Pubky Ring.');
    if(!identity||typeof identity.key!=='string'||!validRingKey(identity.key))throw new Error('Ring returned an invalid public identity.');
    const challenge=await options.prepare(identity.key);controller.signal.throwIfAborted();
    const statement=proofStatement(challenge);
    options.onProgress(`Compare ${challenge.context.slice(0,16)} in Ring, then approve this conversation.`);
    await ringSend(secret,'challenge',{statement,delegate},controller.signal);
    const response=await ringReceive(secret,'approval',controller.signal) as {authorization?:string;cancelled?:boolean};
    if(response?.cancelled)throw new Error('Cancelled in Pubky Ring.');
    if(typeof response?.authorization!=='string')throw new Error('Ring did not provide an authorization.');
    const claims=verifyRingAuthorization(response.authorization,statement,identity.key,challenge.issuedAt,challenge.expiresAt);
    if(claims.cnf!==delegate)throw new Error('Ring changed the delegated key.');
    controller.signal.throwIfAborted();
    await options.submit(challenge,ringEvidence(response.authorization,statement,seed));
  }catch(e){if(controller.signal.aborted)throw new Error(options.signal.aborted?'Ring connection cancelled.':'Ring approval timed out. Try a new QR code.');throw e;} // eslint-disable-line preserve-caught-error -- Normalize cancellation without retaining relay details; ES2020 has no Error.cause.
  finally {clearTimeout(timer);options.signal.removeEventListener('abort',abort);controller.abort();secret.fill(0);seed.fill(0);options.onLink('');}
}
