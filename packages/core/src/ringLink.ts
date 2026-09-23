import {base64urlnopad} from '@scure/base';
import {validRingKey} from './pubkyRing';
export const RING_LINK_PREFIX='ghostlyring://proof';
export interface RingRequest {secret:Uint8Array;delegate:string;expires:number}
/** Used by the Ghostly QR/link generator and the actual modified Ring parser. */
export function createRingLink(secret:Uint8Array,delegate:string,expires:number):string {
 if(secret.length!==32||!validRingKey(delegate)||!Number.isSafeInteger(expires))throw new Error('Invalid Ring request');
 return `${RING_LINK_PREFIX}?v=1&secret=${base64urlnopad.encode(secret)}&delegate=${delegate}&expires=${expires}`;
}
function normalize(input:string):string {
 let text=input.trim();
 // Clipboard may contain a single percent-encoded whole URI. Never recursively
 // decode query separators or treat an auth/import URL as an identity proof.
 if(/^ghostlyring%3a|^pubkyring%3a/i.test(text)){try{text=decodeURIComponent(text);}catch{/* handled as invalid */}}
 return text;
}
export function isRingLink(input:unknown):input is string {
 if(typeof input!=='string')return false;
 const text=normalize(input);
 return /^ghostlyring:/i.test(text)||/^pubkyring:\/\/ghostly-proof(?:[/?#]|$)/i.test(text);
}
export function parseRingLink(input:string,now=Math.floor(Date.now()/1000)):RingRequest {
 if(input.length>1536)throw new Error('Invalid Ring request. Copy a new connection link from Ghostly.');
 const text=normalize(input);
 const match=/^(?:ghostlyring:\/\/proof|pubkyring:\/\/ghostly-proof)\/?\?([^#]*)$/i.exec(text);
 if(!match)throw new Error('Invalid Ring request. Copy a new connection link from Ghostly.');
 const fields:Record<string,string>=Object.create(null);
 try{
  for(const part of match[1].split('&')){const [key,value,...extra]=part.split('=');if(extra.length||!['v','secret','delegate','expires'].includes(key)||key in fields||value===undefined)throw new Error();fields[key]=decodeURIComponent(value);}
  const secret=base64urlnopad.decode(fields.secret);const expires=Number(fields.expires);
  if(fields.v!=='1'||secret.length!==32||base64urlnopad.encode(secret)!==fields.secret||!validRingKey(fields.delegate)||!/^\d{10}$/.test(fields.expires)||!Number.isSafeInteger(expires))throw new Error();
  if(expires<=now||expires>now+210){secret.fill(0);throw new Error('expired');}
  return {secret,delegate:fields.delegate,expires};
 }catch(e){if(e instanceof Error&&e.message==='expired')throw new Error('This Ring request expired. Create a new QR code in Ghostly.');throw new Error('Invalid Ring request. Copy a new connection link from Ghostly.');} // eslint-disable-line preserve-caught-error -- Never retain input/secret parsing diagnostics.
}
