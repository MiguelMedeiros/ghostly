import {formatPaymentAmount} from '@ghostly/core';
import type {WalletState} from '../lib/platform';
export type WalletRail = 'cashu' | 'lightning' | 'arkade' | 'usdt';
export interface WalletCard {id:WalletRail;name:string;balance:string;detail:string;status:string;ready:boolean}
/** What each card shows, shared by the wallet page and the chat's payment picker. */
export function walletCards(state:WalletState,testMints:readonly string[]):WalletCard[] {
 // The mints shown are the mode's own: in Testnet every sat here is a test sat.
 const testnet=state.mode==='testnet';
 const test=testnet?0:state.mints.filter(m=>testMints.includes(m.url)).reduce((sum,m)=>sum+m.balance,0);
 const cashu=`${Math.max(0,state.balance-test).toLocaleString()} ${testnet?'test sats':'sats'}`;
 const ark=state.ark,usdt=state.usdt;
 // Ready means it can receive: an Ark wallet that has no address yet (its provider has not answered) is not.
 const arkReady=!!ark?.configured&&!ark.locked&&!!ark.address,usdtReady=!!usdt?.configured&&!usdt.locked;
 const arkTest=ark?.network&&ark.network!=='bitcoin',usdtTest=!!usdt?.chainId&&usdt.chainId!==1;
 return [
  {id:'cashu',name:'Cashu',balance:cashu,detail:testnet?'Ecash · test mints':test?`+${test.toLocaleString()} test sats`:'Ecash · your mints',status:state.mints.length?'Ready':'Set up',ready:state.mints.length>0},
  {id:'lightning',name:'Lightning',balance:cashu,detail:'Invoices via Cashu',status:'Shared balance',ready:state.mints.length>0},
  {id:'arkade',name:'Ark',balance:arkReady?`${ark!.balance.toLocaleString()} ${arkTest?'test sats':'sats'}`:ark?.configured&&!ark.automatic?'Locked':'Connecting…',detail:`Arkade · ${arkTest?ark!.network:'Bitcoin'}`,status:arkReady?'Ready':'Experimental',ready:arkReady},
  {id:'usdt',name:'USDT',balance:usdtReady?`${formatPaymentAmount(usdt!.balance,usdt!.decimals)} ${usdtTest?'TEST-USDT':'USDT'}`:usdt?.configured&&!usdt.automatic?'Locked':'Connecting…',detail:usdt?.chainId===31337?'EVM local · test token':usdt?.chainId===11155111?'Sepolia · test token':'Ethereum · via WDK',status:usdtReady?'Ready':'Experimental',ready:usdtReady},
 ];
}
