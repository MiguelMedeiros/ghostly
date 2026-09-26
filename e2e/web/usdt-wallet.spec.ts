import {Interface} from 'ethers';
import {USDT_LOCAL} from '../support/usdt-local.mjs';
import type {BrowserContext} from '@playwright/test';
import {chat,connect,createWallet,expect,link,openChat,openWallet,test,walletCard,type Peer} from '../support/fixtures';
import {mockMainnetMints} from '../support/mint';
import {paymentCard} from '../support/payments';
import { composerRow } from "../support/composer";

/**
 * Mainnet USDT without Mainnet: the Ethereum RPC a Mainnet USDT wallet is made with (ethereum.publicnode.com) is
 * answered here, as a chain with the USDT contract (6 decimals) and nothing in this wallet. No real RPC is reached.
 */
async function mockEthereum(context:BrowserContext):Promise<void>{
 const answer=({id,method,params}:{id:number;method:string;params?:unknown[]})=>{
  const word=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
  const data=String((params?.[0] as {data?:string}|undefined)?.data??'');
  const result=method==='eth_chainId'?'0x1':method==='eth_getCode'?'0x6080604052':method==='eth_call'?word(data.startsWith('0x313ce567')?6:0)
   :method==='eth_getLogs'?[]:method==='eth_blockNumber'?'0x1000':'0x0';
  return {jsonrpc:'2.0',id,result};
 };
 await context.route(/^https:\/\/ethereum\.publicnode\.com/,async route=>{
  if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'POST'}});
  const body=route.request().postDataJSON();
  await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(Array.isArray(body)?body.map(answer):answer(body))});
 });
}

test('WDK local token request, approval and confirmed receipt across two peers',{tag:['@gated','@feature:payments.usdt.send','@feature:payments.chat.review','@feature:wallet.instances.create']},async({peer},testInfo)=>{
 test.skip(process.env.GHOSTLY_USDT_LOCAL!=='1','Requires e2e/infra (npm run e2e:infra:up) and GHOSTLY_USDT_LOCAL=1');
 const config=USDT_LOCAL;
 let id=0;
 const rpc=async(method:string,params:unknown[]=[])=>{
  const response=await fetch(config.provider,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
  const result=await response.json();if(result.error)throw new Error('Local EVM operation failed');return result.result;
 };
 expect(await rpc('eth_chainId')).toBe('0x7a69');
 const [alice,bob]=await Promise.all([peer('usdt-alice',{offlineMainnet:true}),peer('usdt-bob',{offlineMainnet:true})]);
 await link(alice,bob);await connect(alice,bob);
 const panel=(p:Peer)=>p.page.getByTestId('usdt-wallet');
 for(const p of [alice,bob]){
  // A Testnet USDT wallet starts on Sepolia; while empty it may move to the local test chain.
  await createWallet(p,'usdt','testnet');
  await openWallet(p,'usdt-testnet');
  await panel(p).getByRole('radio',{name:'Local test chain',exact:true}).click({timeout:60000});
  await panel(p).getByLabel('Token contract',{exact:true}).fill(config.token);
  await panel(p).getByRole('button',{name:'Switch network',exact:true}).click();
  // Testnet starts on Sepolia, also "TEST-USDT": wait for the local chain itself.
  await expect(walletCard(p.page,'usdt-testnet')).toContainText('EVM local',{timeout:60000});
  await expect(panel(p).getByTestId('usdt-balance')).toHaveText('0 TEST-USDT',{timeout:60000});
 }
 const from=(await panel(alice).getByTestId('usdt-address').innerText()).trim();
 await rpc('anvil_setBalance',[from,'0xde0b6b3a7640000']);
 const accounts=await rpc('eth_accounts');
 const abi=new Interface(['function mint(address,uint256)']);
 await rpc('eth_sendTransaction',[{from:accounts[0],to:config.token,data:abi.encodeFunctionData('mint',[from,10_000_000n])}]);
 await rpc('evm_mine');
 // Incoming tokens show up without touching anything.
 await expect(panel(alice).getByTestId('usdt-balance')).toHaveText('10 TEST-USDT',{timeout:30000});
 for(const p of [alice,bob])await openChat(p);
 await (await composerRow(bob.page, "payment-button")).click();
 // Both have a Testnet USDT wallet, made after they met: each chat is told, and the card meets the other's.
 await expect(paymentCard(bob.page,'usdt-testnet')).not.toHaveAttribute('aria-disabled','true',{timeout:30000});
 await paymentCard(bob.page,'usdt-testnet').click();
 await bob.page.getByTestId('payment-amount').fill('1.25');
 await bob.page.getByTestId('payment-request').click();
 const request=chat(alice).getByTestId('payment-bubble').filter({hasText:'Requests'});
 await expect(request).toContainText('1.25 TEST-USDT');
 await request.getByTestId('payment-pay').click();
 const review=request.getByTestId('payment-review');
 await expect(review).toContainText('1.25 TEST-USDT');
 await review.getByRole('button',{name:'Approve payment'}).click();
 await expect(review.getByTestId('review-status')).toHaveText('confirmed');
 await expect(request.getByTestId('payment-state')).toHaveText('Paid');
 await expect(chat(bob).getByTestId('payment-bubble').filter({hasText:'Sent you'}).getByTestId('payment-state')).toHaveText('Received');
 await expect(review.getByRole('button',{name:'Approve payment'})).toHaveCount(0);
 await alice.page.screenshot({path:testInfo.outputPath('usdt-payer.png'),fullPage:true});
 await openWallet(bob,'usdt-testnet');
 await expect(panel(bob).getByTestId('usdt-balance')).toHaveText('1.25 TEST-USDT',{timeout:30000});
 await bob.page.screenshot({path:testInfo.outputPath('usdt-recipient.png'),fullPage:true});

 // Send, with no request: Bob's app asks Alice's for an address, then the payment waits for his approval.
 await rpc('anvil_setBalance',[(await panel(bob).getByTestId('usdt-address').innerText()).trim(),'0xde0b6b3a7640000']);
 await openChat(bob);
 await (await composerRow(bob.page, "payment-button")).click();
 await paymentCard(bob.page,'usdt-testnet').click();
 await bob.page.getByTestId('payment-amount').fill('0.5');
 await bob.page.getByTestId('payment-send').click();
 const direct=bob.page.getByTestId('payment-composer').getByTestId('payment-review');
 await expect(direct).toContainText('0.5 TEST-USDT',{timeout:60000});
 await direct.getByRole('button',{name:'Approve payment'}).click();
 await expect(direct.getByTestId('review-status')).toHaveText('confirmed',{timeout:60000});
 await openWallet(alice,'usdt-testnet');
 await expect(panel(alice).getByTestId('usdt-balance')).toHaveText('9.25 TEST-USDT',{timeout:30000});
});

test('wallet cards fit a narrow screen, keep keyboard focus and respect reduced motion',{tag:['@feature:wallet.deck','@feature:wallet.instances.create']},async({peer},testInfo)=>{
 const p=await peer('wallet-cards-mobile',{mobile:true,viewport:{width:390,height:844}});
 await p.page.emulateMedia({reducedMotion:'reduce'});
 // Wallets on both networks, none of them reaching a real network: the test mint, mocked Mainnet mints and RPC.
 await mockMainnetMints(p.context);
 await mockEthereum(p.context);
 await p.page.goto('/#/wallet');
 await createWallet(p,'cashu','testnet');
 await createWallet(p,'cashu','mainnet');
 await createWallet(p,'usdt','mainnet');
 const cards=p.page.getByRole('tablist',{name:'Wallet integrations'});
 const usdt=walletCard(p.page,'usdt-mainnet');
 // Cashu and Lightning through it on each network, and USDT: five cards on a snapping track, and the page itself never scrolls sideways at 390 px.
 await expect(cards.getByRole('tab')).toHaveCount(5);
 await walletCard(p.page,'cashu-testnet').click();
 await usdt.focus();
 await expect(usdt).toBeFocused();
 await p.page.keyboard.press('Enter');
 await expect(usdt).toHaveAttribute('aria-selected','true');
 await expect(usdt).toContainText('Ethereum',{timeout:60000});
 expect(await p.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 expect(await usdt.evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
 await p.page.screenshot({path:testInfo.outputPath('wallet-cards-mobile.png'),fullPage:true});
});

test('Testnet and Mainnet each have their own USDT wallet, open at once: Sepolia with its test chains, Ethereum alone',{tag:['@network','@feature:wallet.usdt.create','@feature:wallet.mode','@feature:wallet.instances.networks','@feature:wallet.instances.create']},async({peer})=>{
 // Sepolia's public RPC can take a minute to answer a new wallet.
 test.setTimeout(4*60_000);
 const p=await peer('usdt-network-back');
 await mockEthereum(p.context);
 const panel=p.page.getByTestId('usdt-wallet');
 await createWallet(p,'usdt','mainnet');
 await openWallet(p,'usdt-mainnet');
 await expect(panel.getByTestId('usdt-address')).toHaveText(/^\s*0x/,{timeout:60000});
 const address=(await panel.getByTestId('usdt-address').innerText()).trim();
 await expect(panel.getByTestId('usdt-balance')).toHaveText('0 USDT');
 // A Mainnet wallet is Ethereum only: the test chains are a Testnet wallet's.
 await expect(walletCard(p.page,'usdt-mainnet')).toContainText('Ethereum');
 await expect(panel.getByRole('radio',{name:'Sepolia',exact:true})).toHaveCount(0);

 await createWallet(p,'usdt','testnet',{timeout:150_000});
 await openWallet(p,'usdt-testnet');
 await expect(walletCard(p.page,'usdt-testnet')).toContainText('Sepolia',{timeout:150_000});
 await expect(panel.getByRole('radio',{name:'Sepolia',exact:true})).toHaveAttribute('aria-checked','true',{timeout:60000});
 await expect(panel.getByRole('radio',{name:'Ethereum',exact:true})).toHaveCount(0);
 await expect(panel.getByTestId('usdt-balance')).toHaveText('0 TEST-USDT',{timeout:60000});
 const testnetAddress=(await panel.getByTestId('usdt-address').innerText()).trim();
 expect(testnetAddress,'a wallet of its own').not.toBe(address);
 // The Mainnet one was never parked: the same wallet, still there.
 await openWallet(p,'usdt-mainnet');
 await expect(panel.getByTestId('usdt-address'),'the same wallet, not a new one').toHaveText(address,{timeout:60000});
 await expect(walletCard(p.page,'usdt-testnet')).toContainText('TEST-USDT');
});
