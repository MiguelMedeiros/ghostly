import { wrap } from '../../shared/idb';

interface SnapshotStore {
 name:string;keyPath:string|string[]|null;autoIncrement:boolean;
 indexes:{name:string;keyPath:string|string[];unique:boolean;multiEntry:boolean}[];
 keys:IDBValidKey[];values:unknown[];
}
export interface ArkDatabaseSnapshot {version:number;stores:SnapshotStore[]}
const allowed=new Set(['vtxos','utxos','transactions','walletState','contracts','contractsCollections','intents','virtualTxs','vtxoBranches']);
export const encodeBackup=(value:unknown)=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?{$ghostly:'bigint',value:String(v)}:v instanceof Uint8Array?{$ghostly:'bytes',value:Array.from(v)}:v);
export const decodeBackup=(text:string):unknown=>JSON.parse(text,(_key,v)=>v?.$ghostly==='bigint'?BigInt(v.value):v?.$ghostly==='bytes'?new Uint8Array(v.value):v);
export async function snapshotArkDatabase(walletId:string):Promise<ArkDatabaseSnapshot>{
 const db=await wrap(indexedDB.open(`ghostly-ark-${walletId}`));
 try {
  const names=Array.from(db.objectStoreNames);
  if(!names.length || names.some(n=>!allowed.has(n)))throw new Error(`Unsupported Ark database schema: ${names.join(',') || 'empty'}`);
  const tx=db.transaction(names,'readonly');
  const stores=await Promise.all(names.map(async name=>{
   const store=tx.objectStore(name);
   const indexes=Array.from(store.indexNames).map(name=>{const i=store.index(name);return{name,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry};});
   const keys=wrap(store.getAllKeys()),values=wrap(store.getAll());
   return{name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes,keys:await keys,values:await values};
  }));
  return{version:db.version,stores};
 } finally {db.close();}
}
/** Only imports into a freshly allocated database; never replaces an existing wallet. */
export async function restoreArkDatabase(walletId:string,snapshot:ArkDatabaseSnapshot):Promise<void>{
 if(snapshot.version!==3 || !Array.isArray(snapshot.stores) || snapshot.stores.length>allowed.size || new Set(snapshot.stores.map(s=>s.name)).size!==snapshot.stores.length || snapshot.stores.some(s=>!allowed.has(s.name) || !Array.isArray(s.values) || !Array.isArray(s.keys) || s.values.length!==s.keys.length))throw new Error('Unsupported Ark backup schema');
 for(const name of ['vtxos','utxos','transactions','walletState','contracts','contractsCollections'])if(!snapshot.stores.some(s=>s.name===name))throw new Error('Incomplete Ark database backup');
 const request=indexedDB.open(`ghostly-ark-${walletId}`,snapshot.version);
 let created=false;
 request.onupgradeneeded=event=>{
  if(event.oldVersion!==0){request.transaction?.abort();return;}
  created=true;
  for(const entry of snapshot.stores){
   const store=request.result.createObjectStore(entry.name,{keyPath:entry.keyPath,autoIncrement:entry.autoIncrement});
   for(const index of entry.indexes)store.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:index.multiEntry});
   entry.values.forEach((value,i)=>entry.keyPath===null?store.put(value,entry.keys[i]):store.put(value));
  }
 };
 // An existing database is never written to: opened without an upgrade (or refused), it stays as it was.
 const db=await wrap(request).catch(()=>null);db?.close();
 if(!created)throw new Error(`An Ark database for ${walletId} already exists`);
}
