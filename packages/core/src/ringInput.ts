import {isRingLink} from './ringLink';
/** Memory-only dispatch shared by every modified Ring entry point. Raw pairing
 * links never enter Redux/persistence or the generic key-import parser. */
export function createRingInputRouter(){
 let listener:((url:string)=>void)|undefined;
 let pending='';let timer:ReturnType<typeof setTimeout>|undefined;
 const clear=()=>{pending='';if(timer)clearTimeout(timer);timer=undefined;};
 return {
  open(url:string):boolean {
   if(!isRingLink(url))return false;
   if(listener)listener(url);
   else {clear();pending=url;timer=setTimeout(clear,180000);}
   return true;
  },
  subscribe(next:(url:string)=>void):()=>void {
   listener=next;
   if(pending){const url=pending;clear();next(url);}
   return ()=>{if(listener===next)listener=undefined;clear();};
  },
 };
}
const router=createRingInputRouter();
export const openGhostlyProof=router.open;
export const subscribeRingRequests=router.subscribe;
