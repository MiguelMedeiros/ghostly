import { STORES, openDb, store, transact, wrap } from "../../shared/idb";
import type { IntentRepository, SavedIntent } from "./coordinator";
export const intentRepository: IntentRepository = {
  async get(id) { return wrap<SavedIntent | undefined>((await store(STORES.intents,"readonly")).get(id)); },
  async list() { return wrap<SavedIntent[]>((await store(STORES.intents,"readonly")).getAll()); },
  async put(intent) { await transact([STORES.intents],s=>{s[STORES.intents].put(intent);}); },
  async claim(id) {
    const tx=(await openDb()).transaction(STORES.intents,"readwrite");
    return new Promise<SavedIntent>((resolve,reject)=>{
      let saved:SavedIntent;
      const request=tx.objectStore(STORES.intents).getAll();
      request.onsuccess=()=>{
        const intents:SavedIntent[]=request.result;
        saved=intents.find(item=>item.review.id===id)!;
        if(!saved || saved.review.state!=="pending") {tx.abort();return;}
        const duplicate=saved.review.requestId && intents.some(({review})=>review.id!==id && review.requestId===saved.review.requestId && review.linkId===saved.review.linkId && ["submitted","settled","unknown"].includes(review.state));
        const pendingNonce = saved.review.method === "usdt" && intents.some(({review}) => review.id !== id && review.method === "usdt" && review.chainId === saved.review.chainId && review.evm?.from === saved.review.evm?.from && ["submitted","unknown"].includes(review.state));
        if(duplicate || pendingNonce){tx.abort();return;}
        saved.review={...saved.review,state:"submitted",error:undefined};
        tx.objectStore(STORES.intents).put(saved);
      };
      tx.oncomplete=()=>resolve(saved);
      tx.onabort=tx.onerror=()=>reject(new Error("This payment was already submitted or could not be saved"));
    });
  },
  async cancel(id) {
    const tx=(await openDb()).transaction(STORES.intents,"readwrite");
    return new Promise<SavedIntent>((resolve,reject)=>{
      let saved:SavedIntent;
      const request=tx.objectStore(STORES.intents).get(id);
      request.onsuccess=()=>{
        saved=request.result;
        if(!saved || saved.review.state!=="pending"){tx.abort();return;}
        saved.review={...saved.review,state:"cancelled"};
        tx.objectStore(STORES.intents).put(saved);
      };
      tx.oncomplete=()=>resolve(saved);
      tx.onabort=tx.onerror=()=>reject(new Error("A submitted payment cannot be cancelled; reconcile it instead"));
    });
  },
};
/** Key for a wallet that needs no password: its seed is protected like the Cashu proofs in the same database. */
export function newDeviceKey():string {return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=+$/,"");}
export interface EncryptedSeed {version:1;salt:number[];iv:number[];ciphertext:number[]}
async function passwordKey(password:string,salt:Uint8Array<ArrayBuffer>) {
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt,iterations:600000},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
export async function sealSeed(seed:string,password:string):Promise<EncryptedSeed> {
  if(password.length<12)throw new Error("Use at least 12 characters for the wallet password");
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv},await passwordKey(password,salt),new TextEncoder().encode(seed));
  return {version:1,salt:[...salt],iv:[...iv],ciphertext:[...new Uint8Array(ciphertext)]};
}
export async function unsealSeed(seed:EncryptedSeed,password:string):Promise<string> {
  if(seed.version!==1)throw new Error("Unsupported wallet backup version");
  try {return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(seed.iv)},await passwordKey(password,new Uint8Array(seed.salt)),new Uint8Array(seed.ciphertext)));}
  catch {throw new Error("Could not unlock the wallet. Check the password and backup.");}
}
