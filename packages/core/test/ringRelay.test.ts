import {it,expect} from 'vitest';
import {ringSend,ringReceive} from '../src/pubkyRing';
it.skipIf(process.env.TEST_RING_RELAY!=='1')('exchanges an encrypted disposable approval envelope over the real public relay',async()=>{
 const secret=crypto.getRandomValues(new Uint8Array(32)),abort=new AbortController();const timer=setTimeout(()=>abort.abort(),35000);
 try{const received=ringReceive(secret,'identity',abort.signal);await ringSend(secret,'identity',{probe:'disposable-test'},abort.signal);expect(await received).toEqual({probe:'disposable-test'});}finally{clearTimeout(timer);abort.abort();secret.fill(0);}
},40000);
