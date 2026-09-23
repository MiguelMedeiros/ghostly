import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { intentRepository, sealSeed, unsealSeed } from '../src/engine/paymentAdapters/persistence';
import type { SavedIntent } from '../src/engine/paymentAdapters/coordinator';

function intent(requestId=crypto.randomUUID()):SavedIntent {
 return {review:{id:crypto.randomUUID(),requestId,linkId:'peer',payee:'peer',method:'arkade',network:'regtest',provider:'http://127.0.0.1:43010',asset:'BTC',unit:'sat',address:'fixture',expiresAt:Date.now()+60000,createdAt:Date.now(),amount:10,fee:0,feeCap:0,state:'pending'},prepared:{}};
}
test('different intent IDs cannot claim the same request concurrently',async()=>{
 const a=intent(),b=intent(a.review.requestId);
 await intentRepository.put(a);await intentRepository.put(b);
 const results=await Promise.allSettled([intentRepository.claim(a.review.id),intentRepository.claim(b.review.id)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const winner=results.find(r=>r.status==='fulfilled');
 expect(winner?.status==='fulfilled' && winner.value.review.state).toBe('submitted');
});
test('cancel and claim are mutually exclusive across database transactions',async()=>{
 const a=intent();await intentRepository.put(a);
 const results=await Promise.allSettled([intentRepository.claim(a.review.id),intentRepository.cancel(a.review.id)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect((await intentRepository.get(a.review.id))?.review.state).toBe('submitted');
});
test('wallet vault round trip rejects wrong password and modified ciphertext',async()=>{
 const sealed=await sealSeed('disposable fixture, not a wallet seed','test-only password');
 expect(await unsealSeed(sealed,'test-only password')).toBe('disposable fixture, not a wallet seed');
 await expect(unsealSeed(sealed,'wrong password')).rejects.toThrow('unlock');
 sealed.ciphertext[0]^=1;
 await expect(unsealSeed(sealed,'test-only password')).rejects.toThrow('unlock');
});
