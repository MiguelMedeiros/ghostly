import {Interface} from 'ethers';
import {USDT_LOCAL} from '../support/usdt-local.mjs';
import {chat,connect,expect,link,openChat,openWallet,test,useTestnet,type Peer} from '../support/fixtures';

test('WDK local token request, approval and confirmed receipt across two peers',{tag:['@gated','@feature:payments.usdt.send','@feature:payments.chat.review']},async({peer},testInfo)=>{
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
  // Test chains belong to the Testnet mode; there an empty wallet may move to the local test chain.
  await useTestnet(p);
  await openWallet(p,'usdt');
  await panel(p).getByRole('radio',{name:'Local test chain',exact:true}).click({timeout:60000});
  await panel(p).getByLabel('Token contract',{exact:true}).fill(config.token);
  await panel(p).getByRole('button',{name:'Switch network',exact:true}).click();
  // Testnet starts on Sepolia, also "TEST-USDT": wait for the local chain itself.
  await expect(p.page.getByTestId('wallet-card-usdt')).toContainText('EVM local',{timeout:60000});
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
 await bob.page.getByTestId('payment-button').click();
 await bob.page.getByTestId('payment-card-usdt').click();
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
 await openWallet(bob,'usdt');
 await expect(panel(bob).getByTestId('usdt-balance')).toHaveText('1.25 TEST-USDT',{timeout:30000});
 await bob.page.screenshot({path:testInfo.outputPath('usdt-recipient.png'),fullPage:true});

 // Send, with no request: Bob's app asks Alice's for an address, then the payment waits for his approval.
 await rpc('anvil_setBalance',[(await panel(bob).getByTestId('usdt-address').innerText()).trim(),'0xde0b6b3a7640000']);
 await openChat(bob);
 await bob.page.getByTestId('payment-button').click();
 await bob.page.getByTestId('payment-card-usdt').click();
 await bob.page.getByTestId('payment-amount').fill('0.5');
 await bob.page.getByTestId('payment-send').click();
 const direct=bob.page.getByTestId('payment-composer').getByTestId('payment-review');
 await expect(direct).toContainText('0.5 TEST-USDT',{timeout:60000});
 await direct.getByRole('button',{name:'Approve payment'}).click();
 await expect(direct.getByTestId('review-status')).toHaveText('confirmed',{timeout:60000});
 await openWallet(alice,'usdt');
 await expect(panel(alice).getByTestId('usdt-balance')).toHaveText('9.25 TEST-USDT',{timeout:30000});
});

test('wallet cards fit a narrow screen, keep keyboard focus and respect reduced motion',{tag:['@feature:wallet.deck']},async({peer},testInfo)=>{
 const p=await peer('wallet-cards-mobile',{mobile:true,viewport:{width:390,height:844}});
 await p.page.emulateMedia({reducedMotion:'reduce'});
 await p.page.goto('/#/wallet');
 const cards=p.page.getByRole('tablist',{name:'Wallet integrations'});
 // Cashu, Lightning, Ark, Bark, Bitcoin, USDT: six cards on a snapping track, and the page itself never scrolls sideways at 390 px.
 await expect(cards.getByRole('tab')).toHaveCount(6);
 await p.page.getByTestId('wallet-card-usdt').focus();
 await expect(p.page.getByTestId('wallet-card-usdt')).toBeFocused();
 await p.page.keyboard.press('Enter');
 await expect(p.page.getByTestId('wallet-card-usdt')).toHaveAttribute('aria-selected','true');
 await expect(p.page.getByTestId('wallet-card-usdt')).toContainText('Ethereum',{timeout:60000});
 expect(await p.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 expect(await p.page.getByTestId('wallet-card-usdt').evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
 await p.page.screenshot({path:testInfo.outputPath('wallet-cards-mobile.png'),fullPage:true});
});

test('Testnet has its own USDT wallet, and Mainnet gets the same one back',{tag:['@network','@feature:wallet.usdt.create','@feature:wallet.mode']},async({peer})=>{
 // Sepolia's public RPC can take a minute to answer a new wallet.
 test.setTimeout(4*60_000);
 const p=await peer('usdt-network-back');
 await openWallet(p,'usdt');
 const panel=p.page.getByTestId('usdt-wallet');
 await expect(panel.getByTestId('usdt-address')).toHaveText(/^\s*0x/,{timeout:60000});
 const address=(await panel.getByTestId('usdt-address').innerText()).trim();
 // Mainnet is Ethereum only: the test chains are chosen with the Testnet mode.
 await expect(panel.getByRole('radio',{name:'Sepolia',exact:true})).toHaveCount(0);
 await useTestnet(p);
 await openWallet(p,'usdt');
 await expect(p.page.getByTestId('wallet-card-usdt')).toContainText('Sepolia',{timeout:150_000});
 await expect(panel.getByRole('radio',{name:'Sepolia',exact:true})).toHaveAttribute('aria-checked','true',{timeout:60000});
 await expect(panel.getByRole('radio',{name:'Ethereum',exact:true})).toHaveCount(0);
 // Back to Mainnet: the wallet that was parked, not a new one.
 await p.page.getByTestId('wallet-mode').getByRole('radio',{name:'Mainnet'}).click();
 await expect(panel.getByTestId('usdt-address'),'the same wallet, not a new one').toHaveText(address,{timeout:60000});
});
