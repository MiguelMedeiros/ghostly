import 'fake-indexeddb/auto';
import { test, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Wallet, MnemonicIdentity, ArkNote, RestArkProvider, InMemoryWalletRepository, InMemoryContractRepository } from '@arkade-os/sdk';
import { ArkadeAdapter } from '../src/engine/paymentAdapters/arkade';
import type { PaymentReview, PaymentTarget } from '@ghostly/core';
import { PaymentCoordinator } from '../src/engine/paymentAdapters/coordinator';
import { intentRepository } from '../src/engine/paymentAdapters/persistence';
import {sealSeed} from '../src/engine/paymentAdapters/persistence';
import {ArkWallet} from '../src/engine/paymentAdapters/arkWallet';
import {STORES,transact} from '../src/shared/idb';
// covers-gated: wallet.ark.send, wallet.ark.backup, payments.chat.reconcile
const enabled=process.env.GHOSTLY_ARK_REGTEST==='1';
test.skipIf(!enabled)('real regtest Ark transfer and read-only receipt reconciliation',async()=>{
 const provider='http://127.0.0.1:43010';
 const info=await new RestArkProvider(provider).getInfo();
 const config={network:'regtest' as const,provider,explorer:'http://127.0.0.1:43000/api',serverKey:info.signerPubkey,walletId:crypto.randomUUID()};
 const storage=()=>({walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()});
 const aliceMnemonic=generateMnemonic(wordlist);
 const aliceStorage=storage();
 const funder=await Wallet.create({identity:MnemonicIdentity.fromMnemonic(aliceMnemonic,{isMainnet:false}),arkServerUrl:provider,esploraUrl:config.explorer,settlementConfig:false,walletMode:"hd",storage:aliceStorage});
 const noteOutput=execFileSync('node',['/tmp/ghostly-ark-regtest-20260922/regtest.mjs','arkd','note','--amount','10000'],{encoding:'utf8',stdio:'pipe'});
 const note=noteOutput.match(/arknote[a-zA-Z0-9]+/)?.[0];
 if(!note)throw new Error('Regtest faucet returned no credit note');
 await funder.settle({inputs:[ArkNote.fromString(note)],outputs:[{address:await funder.getAddress(),amount:9900n}]});
 await funder.dispose();
 const alice=await ArkadeAdapter.connect(config,aliceMnemonic,aliceStorage);
 const bobConfig={...config,walletId:crypto.randomUUID()},bobMnemonic=generateMnemonic(wordlist);
 const bob=await ArkadeAdapter.connect(bobConfig,bobMnemonic);
 try {

   const target:PaymentTarget={method:'arkade',network:'regtest',provider,asset:'BTC',unit:'sat',address:await bob.requestAddress(),expiresAt:Date.now()+600000};
   const {fee,prepared}=await alice.prepare(target,1000,20);
   const review:PaymentReview={...target,id:crypto.randomUUID(),payee:'disposable bob',amount:1000,fee,feeCap:20,state:'submitted',createdAt:Date.now()};
   expect(prepared.txid).toMatch(/^[a-f0-9]{64}$/);
   expect(await bob.balance()).toBe(0);
   const result=await alice.execute(review,prepared);
   expect(result.settled).toBe(true);
   await expect.poll(()=>bob.verifyReceipt(result.txid,target.address,1000),{timeout:15000,interval:250}).toBe(true);
   expect(await alice.reconcile(review,prepared)).toEqual(result);
   expect(await bob.balance()).toBe(1000);
   const fresh=await bob.requestAddress();
   expect(fresh).not.toBe(target.address);
   expect(await bob.verifyReceipt(result.txid,fresh,1000)).toBe(false);
   // Spend an HD invoice output, exercising descriptor-based checkpoint signing.
   const back={...target,address:await alice.requestAddress()};
   const coordinator=new PaymentCoordinator(intentRepository,[bob]);
   const returning=await coordinator.prepare(back,500,20,{payee:'disposable alice'});
   const bobProvider=bob['provider'];
   const finalize=bobProvider.finalizeTx.bind(bobProvider);
   const submitted=vi.spyOn(bobProvider,'submitTx');
   vi.spyOn(bobProvider,'finalizeTx').mockImplementationOnce(async(...args)=>{await finalize(...args);throw new Error('simulated response lost after finalization');});
   expect((await coordinator.approve(returning.id)).state).toBe('unknown');
   const saved=await intentRepository.get(returning.id);
   expect(saved?.prepared).toHaveProperty('finalCheckpoints');
   const restarted=new PaymentCoordinator(intentRepository,[bob]);
   await expect.poll(async()=>(await restarted.reconcile(returning.id)).state,{timeout:15000,interval:250}).toBe('settled');
   const returned=(await intentRepository.get(returning.id))!.review;
   expect(await alice.verifyReceipt(returned.txid!,back.address,500)).toBe(true);
   expect(submitted).toHaveBeenCalledTimes(1);
   const lostSubmission=await coordinator.prepare({...back,address:await alice.requestAddress()},100,20,{payee:'disposable alice'});
   submitted.mockImplementationOnce(async(...args)=>{await RestArkProvider.prototype.submitTx.call(bobProvider,...args);throw new Error('simulated lost submit response');});
   expect((await coordinator.approve(lostSubmission.id)).state).toBe('unknown');
   expect((await intentRepository.get(lostSubmission.id))?.prepared).not.toHaveProperty('finalCheckpoints');
   await expect.poll(async()=>(await new PaymentCoordinator(intentRepository,[bob]).reconcile(lostSubmission.id)).state,{timeout:15000,interval:250}).toBe('settled');
   expect(submitted).toHaveBeenCalledTimes(2);
   await bob.dispose();
   const password='disposable backup password';
   const seed=await sealSeed(bobMnemonic,password);
   await transact([STORES.settings],stores=>{stores[STORES.settings].put({config:bobConfig,seed},'arkWallet');});
   const pending={...saved!,review:{...saved!.review,id:crypto.randomUUID(),state:'pending' as const}};
   await intentRepository.put(pending);
   const owner=new ArkWallet(()=>{});await owner.start();
   const encrypted=await owner.exportBackup(password);
   expect(encrypted).not.toContain(bobMnemonic);
   // Isolated fake IndexedDB fixture only: simulate a new device's empty profile.
   await transact([STORES.settings,STORES.intents],stores=>{stores[STORES.settings].delete('arkWallet');stores[STORES.intents].clear();});
   const restoredOwner=new ArkWallet(()=>{});await restoredOwner.start();
   await expect(restoredOwner.restoreBackup(encrypted,'wrong password')).rejects.toThrow('unlock');
   await restoredOwner.restoreBackup(encrypted,password);
   expect(restoredOwner.view.locked).toBe(true);
   expect((await intentRepository.get(pending.review.id))?.review.state).toBe('unknown');
   await expect(restoredOwner.restoreBackup(encrypted,password)).rejects.toThrow('fresh profile');
   await restoredOwner.unlock(password);
   const restoredBob=restoredOwner.require();
   try {
     await expect.poll(()=>restoredBob.balance(),{timeout:15000,interval:250}).toBe(400);
     expect(await restoredBob.requestAddress()).not.toBe(fresh);
     await expect(new PaymentCoordinator(intentRepository,[restoredBob]).approve(pending.review.id)).rejects.toThrow('cannot be submitted');
   } finally {await restoredOwner.lock();}
 } finally {await alice.dispose();await bob.dispose();}
},120000);
