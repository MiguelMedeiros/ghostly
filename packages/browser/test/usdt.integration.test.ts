import 'fake-indexeddb/auto';
import {readFile} from 'node:fs/promises';
import {expect,test,vi} from 'vitest';
import {generateMnemonic} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {Interface} from 'ethers';
import {UsdtAdapter, type UsdtConfig} from '../src/engine/paymentAdapters/usdt';
import {UsdtWallet} from '../src/engine/paymentAdapters/usdtWallet';
import {PaymentCoordinator} from '../src/engine/paymentAdapters/coordinator';
import {intentRepository} from '../src/engine/paymentAdapters/persistence';
import {STORES,transact} from '../src/shared/idb';
// covers-gated: wallet.usdt.create, wallet.usdt.send, wallet.usdt.backup, payments.chat.reconcile
const enabled=process.env.GHOSTLY_USDT_LOCAL==='1';

test.skipIf(!enabled)('WDK signs locally, sends a real local ERC20 transaction and recovers its saved bytes without a second spend',async()=>{
 const params=JSON.parse(await readFile('/tmp/ghostly-usdt-local.json','utf8')) as UsdtConfig;
 const config=await UsdtAdapter.inspect(params);
 const mnemonic=generateMnemonic(wordlist),password='disposable usdt test password';
 const owner=new UsdtWallet(()=>{});await owner.start();
 await owner.create({...config,mnemonic,password});
 const alice=owner.require(),bob=await UsdtAdapter.connect(config,generateMnemonic(wordlist));
 const from=await alice.address();
 const contract=new Interface(['function mint(address,uint256)']);
 const accounts=await alice.rpc<string[]>('eth_accounts');
 const mine=()=>alice.rpc('evm_mine');
 await alice.rpc('anvil_setBalance',[from,'0xde0b6b3a7640000']);
 const mint=await alice.rpc<string>('eth_sendTransaction',[{from:accounts[0],to:config.token,data:contract.encodeFunctionData('mint',[from,100_000_000n])}]);
 await mine();expect(await alice.rpc('eth_getTransactionReceipt',[mint])).toBeTruthy();
 const target=await bob.target();
 const coordinator=new PaymentCoordinator(intentRepository,[alice]);
 try {
  expect((await alice.balances()).balance).toBe('100000000');
  await expect(coordinator.prepare({...target,decimals:18},1_000_000,1e15,{payee:'bob'})).rejects.toThrow();
  await expect(coordinator.prepare({...target,asset:'USDT'},1_000_000,1e15,{payee:'bob'})).rejects.toThrow();
  await expect(coordinator.prepare({...target,address:config.token},1_000_000,1e15,{payee:'bob'})).rejects.toThrow();
  await expect(coordinator.prepare(target,101_000_000,1e15,{payee:'bob'})).rejects.toThrow('Insufficient token');
  await expect(coordinator.prepare(target,1_000_000,1,{payee:'bob'})).rejects.toThrow('gas exceeds');
  await alice.rpc('anvil_setBalance',[from,'0x0']);
  await expect(coordinator.prepare(target,1_000_000,1e15,{payee:'bob'})).rejects.toThrow();
  await alice.rpc('anvil_setBalance',[from,'0xde0b6b3a7640000']);
  const cancelled=await coordinator.prepare(target,1_000_000,1e15,{payee:'bob'});
  expect((await coordinator.cancel(cancelled.id)).state).toBe('cancelled');
  const review=await coordinator.prepare(target,1_250_000,1e15,{payee:'bob',requestId:'disposable-request',linkId:'disposable-chat'});
  const concurrent=await coordinator.prepare(target,2_000_000,1e15,{payee:'bob'});
  expect((await bob.balances()).balance).toBe('0');
  expect((await alice.balances()).balance).toBe('100000000');
  let broadcasts=0;
  const rpc=alice.rpc.bind(alice);
  vi.spyOn(alice,'rpc').mockImplementation(async(method,params)=>{
   if(method==='eth_sendRawTransaction') {
    broadcasts++;
    const saved=await intentRepository.get(review.id);
    expect(saved?.prepared).toHaveProperty('signed.ciphertext');
    expect(JSON.stringify(saved)).not.toContain(mnemonic);
    await rpc(method,params);
    throw new Error('Response lost after the local node accepted the transaction');
   }
   return rpc(method,params);
  });
  expect((await coordinator.approve(review.id)).state).toBe('unknown');
  await expect(coordinator.approve(concurrent.id)).rejects.toThrow('already submitted');
  await mine();await mine();
  const restored=await UsdtAdapter.connect(config,mnemonic);
  try {
   const restarted=new PaymentCoordinator(intentRepository,[restored]);
   await expect.poll(async()=>(await restarted.reconcile(review.id)).state,{timeout:15000}).toBe('settled');
   expect(broadcasts).toBe(1);
   expect((await bob.balances()).balance).toBe('1250000');
   expect((await restored.balances()).balance).toBe('98750000');
   expect((await restarted.approve(concurrent.id)).state).toBe('failed'); // stale nonce, no signing
   const paid=(await intentRepository.get(review.id))!.review;
   await expect(bob.receipt(paid.txid!,{...target,amount:2_000_000})).rejects.toThrow('not the requested');
   await expect(restarted.approve(review.id)).rejects.toThrow('cannot be submitted');
  } finally {await restored.dispose();}
  const backup=await owner.exportBackup(password);expect(backup).not.toContain(mnemonic);
  await owner.lock();expect(()=>owner.require()).toThrow("Unlock");
  await transact([STORES.settings,STORES.intents],s=>{s[STORES.settings].delete('usdtWallet');s[STORES.intents].clear();});
  const restoredOwner=new UsdtWallet(()=>{});await restoredOwner.start();
  await expect(restoredOwner.restoreBackup(backup,'wrong password')).rejects.toThrow('unlock');
  await restoredOwner.restoreBackup(backup,password);expect(restoredOwner.view.locked).toBe(true);
  await expect(restoredOwner.restoreBackup(backup,password)).rejects.toThrow('fresh profile');
  await restoredOwner.unlock(password);
  expect((await restoredOwner.require().balances()).balance).toBe('98750000');
  await restoredOwner.lock();
 } finally {await owner.lock();await bob.dispose();}
},90000);

test.skipIf(!enabled)('replays identical encrypted bytes after a request never reached the node',async()=>{
 const config=await UsdtAdapter.inspect(JSON.parse(await readFile('/tmp/ghostly-usdt-local.json','utf8')));
 const alice=await UsdtAdapter.connect(config,generateMnemonic(wordlist));
 const bob=await UsdtAdapter.connect(config,generateMnemonic(wordlist));
 const from=await alice.address();
 const accounts=await alice.rpc<string[]>('eth_accounts');
 const contract=new Interface(['function mint(address,uint256)']);
 await alice.rpc('anvil_setBalance',[from,'0xde0b6b3a7640000']);
 await alice.rpc('eth_sendTransaction',[{from:accounts[0],to:config.token,data:contract.encodeFunctionData('mint',[from,5_000_000n])}]);await alice.rpc('evm_mine');
 const coordinator=new PaymentCoordinator(intentRepository,[alice]);
 const review=await coordinator.prepare(await bob.target(),1_000_000,1e15,{payee:'bob'});
 const rpc=alice.rpc.bind(alice);const bytes:string[]=[];
 vi.spyOn(alice,'rpc').mockImplementation(async(method,params)=>{
  if(method==='eth_sendRawTransaction'){
   bytes.push(params![0] as string);
   if(bytes.length===1)throw new Error('Request lost before reaching node');
  }
  return rpc(method,params);
 });
 try {
  expect((await coordinator.approve(review.id)).state).toBe('unknown');
  expect((await bob.balances()).balance).toBe('0');
  await coordinator.reconcile(review.id);await rpc('evm_mine');await rpc('evm_mine');
  expect((await coordinator.reconcile(review.id)).state).toBe('settled');
  expect(bytes).toHaveLength(2);expect(bytes[1]).toBe(bytes[0]);
  expect((await bob.balances()).balance).toBe('1000000');
  expect(BigInt(await rpc<string>('eth_getTransactionCount',[from,'latest']))).toBe(1n);
 } finally {await alice.dispose();await bob.dispose();}
},90000);
