import { describe,it,expect,vi } from 'vitest';
import type { PaymentAdapter, PaymentTarget } from '@ghostly/core';
import { PaymentCoordinator, type SavedIntent, type IntentRepository } from '../src/engine/paymentAdapters/coordinator';
// covers: payments.chat.reconcile, payments.chat.review
const target=():PaymentTarget=>({method:'arkade',network:'regtest',provider:'http://127.0.0.1:43010',asset:'BTC',unit:'sat',address:'test destination',expiresAt:Date.now()+60000});
function fixture(){
 const records=new Map<string,SavedIntent>();
 const repo:IntentRepository={get:async id=>structuredClone(records.get(id)),list:async()=>structuredClone([...records.values()]),put:async v=>{records.set(v.review.id,structuredClone(v));},cancel:async id=>{const v=records.get(id);if(!v||v.review.state!=='pending')throw new Error('already submitted');v.review.state='cancelled';return structuredClone(v);},claim:async id=>{const v=records.get(id);if(!v||v.review.state!=='pending')throw new Error('already submitted');v.review.state='submitted';return structuredClone(v);}};
 const adapter:PaymentAdapter={method:'arkade',prepare:vi.fn(async()=>({fee:1,prepared:{immutable:'same transaction'}})),execute:vi.fn(async()=>({txid:'existing transaction',settled:true})),reconcile:vi.fn(async()=>({txid:'existing transaction',settled:true}))};
 return{repo,adapter,coordinator:new PaymentCoordinator(repo,[adapter]),records};
}
describe('payment intent authorization and recovery',()=>{
 it('does not execute on prepare or cancel',async()=>{const f=fixture();const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob'});expect(r.state).toBe('pending');await f.coordinator.cancel(r.id);await expect(f.coordinator.approve(r.id)).rejects.toThrow();expect(f.adapter.execute).not.toHaveBeenCalled();});
 it('atomically admits only one spender across coordinator instances',async()=>{const f=fixture();const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob'});const other=new PaymentCoordinator(f.repo,[f.adapter]);await Promise.allSettled([f.coordinator.approve(r.id),other.approve(r.id)]);expect(f.adapter.execute).toHaveBeenCalledTimes(1);expect(f.records.get(r.id)?.review.state).toBe('settled');});
 it('never executes if persistence fails',async()=>{const f=fixture();const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob'});f.repo.claim=async()=>{throw new Error('disk full');};await expect(f.coordinator.approve(r.id)).rejects.toThrow('disk full');expect(f.adapter.execute).not.toHaveBeenCalled();});
 it('reconciles after timeout/restart without retrying the spend or changing methods',async()=>{const f=fixture();vi.mocked(f.adapter.execute).mockRejectedValue(new Error('lost response'));const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob',requestId:'request',linkId:'same authenticated chat'});expect((await f.coordinator.approve(r.id)).state).toBe('unknown');const restarted=new PaymentCoordinator(f.repo,[f.adapter]);await expect(restarted.approve(r.id)).rejects.toThrow();await expect(restarted.prepare(target(),100,2,{payee:'Bob',requestId:'request',linkId:'same authenticated chat'})).rejects.toThrow('already');expect((await restarted.reconcile(r.id)).state).toBe('settled');expect(f.adapter.execute).toHaveBeenCalledTimes(1);expect(f.adapter.reconcile).toHaveBeenCalledTimes(1);});
 it('rejects expired review, non-integer amounts, wrong asset and excess fees',async()=>{const f=fixture();await expect(f.coordinator.prepare(target(),1.5,2,{payee:'Bob'})).rejects.toThrow();await expect(f.coordinator.prepare({...target(),expiresAt:Date.now()-1},100,2,{payee:'Bob'})).rejects.toThrow();await expect(f.coordinator.prepare({...target(),asset:'USD' as 'BTC'},100,2,{payee:'Bob'})).rejects.toThrow();await expect(f.coordinator.prepare(target(),100,0,{payee:'Bob'})).rejects.toThrow('fee');const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob'});f.records.get(r.id)!.review.expiresAt=Date.now()-1;await expect(f.coordinator.approve(r.id)).rejects.toThrow('expired');expect(f.adapter.execute).not.toHaveBeenCalled();});
});
describe('outcomes that must not turn into a second payment',()=>{
 it('a failure before anything was signed is final, and then the request can be paid again',async()=>{
  const {PaymentPreflightError}=await import('@ghostly/core');
  const f=fixture();vi.mocked(f.adapter.execute).mockRejectedValueOnce(new PaymentPreflightError('not enough funds'));
  const context={payee:'Bob',requestId:'r',linkId:'l'};
  const first=await f.coordinator.prepare(target(),100,2,context);
  expect(await f.coordinator.approve(first.id)).toMatchObject({state:'failed',error:'not enough funds'});
  const second=await f.coordinator.prepare(target(),100,2,context);
  expect((await f.coordinator.approve(second.id)).state).toBe('settled');
 });
 it('a double click approves once',async()=>{
  const f=fixture();const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob'});
  const [a,b]=await Promise.all([f.coordinator.approve(r.id),f.coordinator.approve(r.id)]);
  expect(a).toEqual(b);expect(f.adapter.execute).toHaveBeenCalledTimes(1);
 });
 it('a settled or pending review is never reconciled into a new spend, and an unknown one is only checked',async()=>{
  const f=fixture();const r=await f.coordinator.prepare(target(),100,2,{payee:'Bob'});
  expect((await f.coordinator.reconcile(r.id)).state).toBe('pending');
  await f.coordinator.approve(r.id);
  expect((await f.coordinator.reconcile(r.id)).state).toBe('settled');
  expect(f.adapter.reconcile).not.toHaveBeenCalled();
  vi.mocked(f.adapter.reconcile).mockRejectedValueOnce(new Error('offline'));
  f.records.get(r.id)!.review.state='unknown';
  expect(await f.coordinator.reconcile(r.id)).toMatchObject({state:'unknown',error:expect.stringContaining('No second payment')});
  expect(f.adapter.execute).toHaveBeenCalledTimes(1);
 });
 it('a fee the adapter reports above the limit, or a method nobody handles, stops before saving anything',async()=>{
  const f=fixture();vi.mocked(f.adapter.prepare).mockResolvedValueOnce({fee:5,prepared:{}});
  await expect(f.coordinator.prepare(target(),100,2,{payee:'Bob'})).rejects.toThrow('fee exceeds');
  await expect(f.coordinator.prepare({...target(),method:'cashu'},100,2,{payee:'Bob'})).rejects.toThrow('unavailable');
  await expect(f.coordinator.prepare(target(),100,-1,{payee:'Bob'})).rejects.toThrow('maximum fee');
  expect(f.records.size).toBe(0);
 });
});
