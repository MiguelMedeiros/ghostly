import {formatPaymentAmount} from '@ghostly/core';
import type {WalletState} from '../lib/platform';
export type WalletRail = 'cashu' | 'lightning' | 'arkade' | 'bark' | 'usdt' | 'bitcoin';
/** The cards a chat can pay with: on-chain Bitcoin is not a chat payment method (yet). */
export type ChatRail = Exclude<WalletRail, 'bitcoin'>;
export const CASHU_MINT_SOURCE = 'cashu-mint';
export interface WalletCard {id:WalletRail;name:string;balance:string;detail:string;status:string;ready:boolean}
/** What each card shows, shared by the wallet page and the chat's payment picker. */
export function walletCards(state:WalletState,testMints:readonly string[]):WalletCard[] {
 // The mints shown are the mode's own: in Testnet every sat here is a test sat.
 const testnet=state.mode==='testnet';
 const test=testnet?0:state.mints.filter(m=>testMints.includes(m.url)).reduce((sum,m)=>sum+m.balance,0);
 const cashu=`${Math.max(0,state.balance-test).toLocaleString()} ${testnet?'test sats':'sats'}`;
 const ark=state.ark,bark=state.bark,usdt=state.usdt;
 // Ready means it can receive: an Ark wallet that has no address yet (its provider has not answered) is not.
 const arkReady=!!ark?.configured&&!ark.locked&&!!ark.address,usdtReady=!!usdt?.configured&&!usdt.locked;
 const arkTest=ark?.network&&ark.network!=='bitcoin',usdtTest=!!usdt?.chainId&&usdt.chainId!==1;
 const barkReady=!!bark?.configured&&!bark.locked&&!!bark.address,barkTest=bark?.network!=='bitcoin';
 return [
  {id:'cashu',name:'Cashu',balance:cashu,detail:testnet?'Ecash · test mints':test?`+${test.toLocaleString()} test sats`:'Ecash · your mints',status:state.mints.length?'Ready':'Set up',ready:state.mints.length>0},
  lightningCard(state,cashu,testnet),
  {id:'arkade',name:'Ark',balance:arkReady?`${ark!.balance.toLocaleString()} ${arkTest?'test sats':'sats'}`:ark?.configured&&!ark.automatic?'Locked':'Connecting…',detail:`Arkade · ${arkTest?ark!.network:'Bitcoin'}`,status:arkReady?'Ready':'Experimental',ready:arkReady},
  {id:'bark',name:'Bark',balance:barkReady?`${bark!.balance.toLocaleString()} ${barkTest?'test sats':'sats'}`:bark?.unavailable?'Testnet only':'Connecting…',detail:`Second's Ark · ${bark?.network==='regtest'?'regtest':bark?.network==='bitcoin'?'Bitcoin':'signet'}`,status:barkReady?'Ready':bark?.unavailable?'Not on Mainnet yet':'Experimental',ready:barkReady},
  bitcoinCard(state,testnet),
  {id:'usdt',name:'USDT',balance:usdtReady?`${formatPaymentAmount(usdt!.balance,usdt!.decimals)} ${usdtTest?'TEST-USDT':'USDT'}`:usdt?.configured&&!usdt.automatic?'Locked':'Connecting…',detail:usdt?.chainId===31337?'EVM local · test token':usdt?.chainId===11155111?'Sepolia · test token':'Ethereum · via WDK',status:usdtReady?'Ready':'Experimental',ready:usdtReady},
 ];
}

/** Lightning goes through the mode's source: the Cashu mints (sharing the Cashu balance) unless another was chosen. */
function lightningCard(state:WalletState,cashu:string,testnet:boolean):WalletCard {
 const ln=state.lightning;
 if(!ln||!ln.providerId||ln.providerId===CASHU_MINT_SOURCE)return {id:'lightning',name:'Lightning',balance:cashu,detail:'Invoices via Cashu',status:'Shared balance',ready:state.mints.length>0};
 const ready=ln.status==='ready';
 return {id:'lightning',name:'Lightning',balance:ready?ln.balance!==undefined?`${ln.balance.toLocaleString()} ${testnet?'test sats':'sats'}`:'Ready':ln.status==='error'?'Unavailable':'Connecting…',detail:`Via ${ln.alias??ln.label??ln.providerId}`,status:ready?'Ready':ln.status==='error'?'Check settings':'Connecting…',ready};
}
/** On-chain Bitcoin through the mode's source; there is none until one is set up. */
function bitcoinCard(state:WalletState,testnet:boolean):WalletCard {
 const bt=state.bitcoin,ready=bt?.status==='ready';
 const sats=(n:number)=>`${n.toLocaleString()} ${testnet?'test sats':'sats'}`;
 return {id:'bitcoin',name:'Bitcoin',balance:ready?sats(bt!.balance??0):!bt||bt.status==='none'?'No source':bt.status==='error'?'Unavailable':'Connecting…',
  detail:bt?.providerId?`On-chain · ${bt.alias??bt.label??bt.providerId}`:'On-chain',status:ready?'Ready':!bt||bt.status==='none'?'Set up':bt.status==='error'?'Check settings':'Connecting…',ready};
}
