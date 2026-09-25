import {formatPaymentAmount} from '@ghostly/core';
import type {WalletState} from '../lib/platform';
export type WalletRail = 'cashu' | 'lightning' | 'arkade' | 'bark' | 'usdt' | 'bitcoin' | 'fedimint';
/** The cards a chat can pay with: all of them. */
export type ChatRail = WalletRail;
export const CASHU_MINT_SOURCE = 'cashu-mint';
/** The fee limit an on-chain payment starts with, in sats: a small transaction at a few sat/vB. The review shows the real fee. */
export const ONCHAIN_FEE_CAP = 2_000;
/**
 * The unit of a balance on the wallet page, which wears the Testnet badge and banner: in Testnet a test sat is
 * just "sats" there. In Mainnet a wallet on a test network (a test mint, Bark on signet) still says "test sats".
 */
export const pageUnit=(state:Pick<WalletState,'mode'>,isTest:boolean)=>isTest&&state.mode!=='testnet'?'test sats':'sats';
export interface WalletCard {id:WalletRail;name:string;balance:string;detail:string;status:string;ready:boolean}
/**
 * What each card shows, shared by the wallet page and the chat's payment picker.
 *
 * `badged`: the cards sit under the Testnet badge and banner (the wallet page), so in Testnet their sats are just
 * "sats". A chat has no badge beside it: there a test sat always says so, and in Mainnet a card on a test network
 * does too, wherever it is.
 */
export function walletCards(state:WalletState,testMints:readonly string[],{badged=false}:{badged?:boolean}={}):WalletCard[] {
 // The mints shown are the mode's own: in Testnet every sat here is a test sat.
 const testnet=state.mode==='testnet';
 const unit=(isTest:boolean)=>badged?pageUnit(state,isTest):isTest?'test sats':'sats';
 const test=testnet?0:state.mints.filter(m=>testMints.includes(m.url)).reduce((sum,m)=>sum+m.balance,0);
 const cashu=`${Math.max(0,state.balance-test).toLocaleString()} ${unit(testnet)}`;
 const ark=state.ark,bark=state.bark,usdt=state.usdt;
 // Ready means it can receive: an Ark wallet that has no address yet (its provider has not answered) is not.
 const arkReady=!!ark?.configured&&!ark.locked&&!!ark.address,usdtReady=!!usdt?.configured&&!usdt.locked;
 const arkTest=ark?.network&&ark.network!=='bitcoin',usdtTest=!!usdt?.chainId&&usdt.chainId!==1;
 const barkReady=!!bark?.configured&&!bark.locked&&!!bark.address,barkTest=bark?.network!=='bitcoin';
 return [
  {id:'cashu',name:'Cashu',balance:cashu,detail:testnet?'Ecash · test mints':test?`+${test.toLocaleString()} test sats`:'Ecash · your mints',status:state.mints.length?'Ready':'Set up',ready:state.mints.length>0},
  lightningCard(state,cashu,unit(testnet)),
  {id:'arkade',name:'Ark',balance:arkReady?`${ark!.balance.toLocaleString()} ${unit(!!arkTest)}`:ark?.configured&&!ark.automatic?'Locked':'Connecting…',detail:`Arkade · ${arkTest?ark!.network:'Bitcoin'}`,status:arkReady?'Ready':'Experimental',ready:arkReady},
  {id:'bark',name:'Bark',balance:barkReady?`${bark!.balance.toLocaleString()} ${unit(barkTest)}`:bark?.unavailable?'Testnet only':'Connecting…',detail:`Second's Ark · ${bark?.network==='regtest'?'regtest':bark?.network==='bitcoin'?'Bitcoin':'signet'}`,status:barkReady?'Ready':bark?.unavailable?'Not on Mainnet yet':'Experimental',ready:barkReady},
  bitcoinCard(state,unit(testnet)),
  fedimintCard(state,unit),
  {id:'usdt',name:'USDT',balance:usdtReady?`${formatPaymentAmount(usdt!.balance,usdt!.decimals)} ${usdtTest?'TEST-USDT':'USDT'}`:usdt?.configured&&!usdt.automatic?'Locked':'Connecting…',detail:usdt?.chainId===31337?'EVM local · test token':usdt?.chainId===11155111?'Sepolia · test token':'Ethereum · via WDK',status:usdtReady?'Ready':'Experimental',ready:usdtReady},
 ];
}

/** Lightning goes through the mode's source: the Cashu mints (sharing the Cashu balance) unless another was chosen. */
function lightningCard(state:WalletState,cashu:string,unit:string):WalletCard {
 const ln=state.lightning;
 if(!ln||!ln.providerId||ln.providerId===CASHU_MINT_SOURCE)return {id:'lightning',name:'Lightning',balance:cashu,detail:'Invoices via Cashu',status:'Shared balance',ready:state.mints.length>0};
 const ready=ln.status==='ready';
 // Reconnecting: the last balance it read (the status says it is not a fresh one), until it is unavailable.
 const last=ln.status==='connecting'&&ln.balance!==undefined?`${ln.balance.toLocaleString()} ${unit}`:undefined;
 return {id:'lightning',name:'Lightning',balance:ready?ln.balance!==undefined?`${ln.balance.toLocaleString()} ${unit}`:'Ready':ln.status==='error'?'Unavailable':last??'Connecting…',detail:`Via ${ln.alias??ln.label??ln.providerId}`,status:ready?'Ready':ln.status==='error'?'Check settings':'Connecting…',ready};
}
/** Federation ecash: the federations joined in this mode, one balance. None is joined by default. */
function fedimintCard(state:WalletState,unit:(isTest:boolean)=>string):WalletCard {
 const fm=state.fedimint,federations=fm?.federations??[],ready=federations.some(f=>f.status==='ready');
 const test=federations.some(f=>f.network&&f.network!=='bitcoin')||state.mode==='testnet';
 const detail=federations.length===1?federations[0].name??'1 federation':federations.length?`${federations.length} federations`:'Federation ecash';
 if(fm?.unavailable)return {id:'fedimint',name:'Fedimint',balance:'Testnet only',detail,status:'Not on Mainnet yet',ready:false};
 if(!federations.length)return {id:'fedimint',name:'Fedimint',balance:'No federation',detail,status:'Set up',ready:false};
 return {id:'fedimint',name:'Fedimint',balance:ready?`${(fm!.balance).toLocaleString()} ${unit(test)}`:federations.some(f=>f.status==='error')?'Unavailable':'Connecting…',detail,status:ready?'Ready':'Connecting…',ready};
}
/** On-chain Bitcoin through the mode's source; there is none until one is set up. */
function bitcoinCard(state:WalletState,unit:string):WalletCard {
 const bt=state.bitcoin,ready=bt?.status==='ready';
 const sats=(n:number)=>`${n.toLocaleString()} ${unit}`;
 const last=bt?.status==='connecting'&&bt.balance!==undefined?sats(bt.balance):undefined;
 return {id:'bitcoin',name:'Bitcoin',balance:ready?sats(bt!.balance??0):!bt||bt.status==='none'?'No source':bt.status==='error'?'Unavailable':last??'Connecting…',
  detail:bt?.providerId?`On-chain · ${bt.alias??bt.label??bt.providerId}`:'On-chain',status:ready?'Ready':!bt||bt.status==='none'?'Set up':bt.status==='error'?'Check settings':'Connecting…',ready};
}
