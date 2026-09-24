import {beforeEach,expect,it,vi} from 'vitest';
import {ENDPOINT,type GhostLink,type PaymentTarget} from '@ghostly/core';
import {PaymentDesk} from '../src/engine/payments';
import type {CashuWallet} from '../src/engine/wallet';
import type {UsdtWallet} from '../src/engine/paymentAdapters/usdtWallet';
import {resetDb,seed} from './fakes';
// covers: payments.usdt.send
vi.mock('../src/shared/idb',async()=> (await import('./fakes')).idbModule);
beforeEach(()=>resetDb());
const target=():PaymentTarget=>({method:'usdt',network:'evm-local',chainId:31337,asset:'TEST-USDT',unit:'token-base',decimals:6,token:'0x'+'1'.repeat(40),address:'0x'+'2'.repeat(40),provider:'http://127.0.0.1:43210',issuedAt:Date.now(),expiresAt:Date.now()+60000});
it('rejects USDT requests when capability or token units do not match',async()=>{
 const link={supportsUsdtPayments:false};
 const desk=new PaymentDesk({} as CashuWallet,{getLink:()=>link as GhostLink,storeMessage:vi.fn(),onChange:vi.fn()});
 const request={id:'r',timestamp:Date.now(),amount:{value:'1000000',asset:'testusdt'},endpoints:[[ENDPOINT.usdt,JSON.stringify(target())]] as [string,string][]};
 await desk.onPaymentRequest('l',request);expect(desk.payment('r')).toBeUndefined();
 link.supportsUsdtPayments=true;
 await desk.onPaymentRequest('l',{...request,amount:{value:'1000000',asset:'usdt'}});expect(desk.payment('r')).toBeUndefined();
 await desk.onPaymentRequest('l',request);expect(desk.payment('r')).toMatchObject({unit:'testusdt',state:'pending'});
});
it('waits for chain confirmation and does not reuse a receipt to settle a different request',async()=>{
 const t=target();const createdAt=Date.now();
 seed('payments',['r1','r2'].map(id=>({id,linkId:'l',kind:'request',direction:'out',amount:1000000,unit:'testusdt',state:'pending',createdAt,target:t})));
 const receipt=vi.fn().mockResolvedValue({settled:false,pending:true});
 const desk=new PaymentDesk({} as CashuWallet,{getLink:()=>({supportsUsdtPayments:true}) as GhostLink,storeMessage:vi.fn(),onChange:vi.fn()},undefined,{adapter:{receipt}} as unknown as UsdtWallet);
 await desk.start();
 const payment={id:'p',requestId:'r1',timestamp:createdAt,amount:{value:'1000000',asset:'testusdt'},endpoint:[ENDPOINT.usdt,JSON.stringify({txid:'0x'+'a'.repeat(64)})] as [string,string]};
 await desk.onPayment('l',payment);expect(desk.payment('r1')?.state).toBe('pending');
 await desk.onPayment('l',{...payment,id:'p2',requestId:'r2'});expect(desk.payment('p2')).toBeUndefined();
 await desk.onPayment('l',{...payment,id:'p3',requestId:'r2',endpoint:[ENDPOINT.usdt,JSON.stringify({txid:'0x'+'A'.repeat(64)})]});expect(desk.payment('p3'),'the same hash in capitals is the same transaction').toBeUndefined();
 receipt.mockResolvedValue({settled:true});await desk.reconcileUsdtReceipts();
 expect(desk.payment('r1')?.state).toBe('settled');expect(desk.payment('r2')?.state).toBe('pending');
});
