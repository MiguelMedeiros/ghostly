import {formatPaymentAmount} from '@ghostly/core';
import type {WalletNetwork, WalletState} from '../lib/platform';
import type {WalletCard,WalletRail} from './walletCardTypes';
export type {ChatRail,WalletCard,WalletRail} from './walletCardTypes';
export const CASHU_MINT_SOURCE = 'cashu-mint';
/** The fee limit an on-chain payment starts with, in sats: a small transaction at a few sat/vB. The review shows the real fee. */
export const ONCHAIN_FEE_CAP = 2_000;

/** A wallet's card: one type on one network. `id` is the wallet's own (`cashu:testnet`). */
export interface InstanceCard extends WalletCard<string> {rail:WalletRail;network:WalletNetwork}
export const cardId=(rail:WalletRail,network:WalletNetwork)=>`${rail}:${network}`;
export const parseCardId=(id:string):{rail:WalletRail;network:WalletNetwork}|undefined=>{
 const [rail,network]=id.split(':');
 return network==='mainnet'||network==='testnet'?{rail:rail as WalletRail,network}:undefined;
};
/** A test wallet's sats are test sats wherever they show: its card says Testnet, and its amounts say so too. */
export const satsUnit=(network:WalletNetwork)=>network==='testnet'?'test sats':'sats';

/**
 * Which network's Lightning pays an invoice or an address found in a chat: a test chain's is Testnet's; an invoice
 * on Bitcoin (a test mint's look the same) goes to the Mainnet Lightning wallet when there is one, else the Testnet one.
 */
export function lightningNetworkFor(state:WalletState|null|undefined,chain?:string):WalletNetwork {
 if(chain&&chain!=='bitcoin')return 'testnet';
 const has=(network:WalletNetwork)=>!!state?.wallets?.some(w=>w.type==='lightning'&&w.network===network);
 return has('mainnet')||!has('testnet')?'mainnet':'testnet';
}

/** One network's wallets, as the cards read them: that network's own views, else (an older engine) the flat state. */
export const networkState=(state:WalletState,network:WalletNetwork):WalletState=>({...state,...state.networks?.[network],mode:network});

/**
 * The wallets' cards, shared by the wallet page and the chat's payment picker: one per wallet the profile has, each
 * on its network, in the deck's order.
 */
export function walletCards(state:WalletState):InstanceCard[] {
 // A network's Lightning shows as its default card for receiving (the one `state.lightning` describes).
 return (state.wallets??[]).filter(w=>w.type!=='lightning'||w.receive!==false).map(w=>walletCard(w.type,w.network,networkState(state,w.network)));
}

/** Real money first, then test money, each network's cards in the deck's order: a deck that mixes both keeps them apart. */
export const byNetwork=<C extends {network:WalletNetwork}>(cards:C[]):C[]=>[...cards.filter(c=>c.network==='mainnet'),...cards.filter(c=>c.network==='testnet')];

/** What one wallet's card shows, from its network's state. */
export function walletCard(rail:WalletRail,network:WalletNetwork,s:WalletState):InstanceCard {
 const unit=satsUnit(network),base={id:cardId(rail,network),rail,network};
 const cashu=`${Math.max(0,s.balance).toLocaleString()} ${unit}`;
 switch(rail) {
  case 'cashu': return {...base,name:'Cashu',balance:cashu,detail:network==='testnet'?'Ecash · test mints':'Ecash · your mints',status:s.mints.length?'Ready':'Set up',ready:s.mints.length>0};
  case 'lightning': return {...base,...lightningCard(s,cashu,unit)};
  case 'arkade': {
   const ark=s.ark,ready=!!ark?.configured&&!ark.locked&&!!ark.address;
   // Ready means it can receive: an Ark wallet that has no address yet (its provider has not answered) is not.
   return {...base,name:'Ark',balance:ready?`${ark!.balance.toLocaleString()} ${unit}`:ark?.configured&&!ark.automatic?'Locked':'Connecting…',detail:`Arkade · ${ark?.network&&ark.network!=='bitcoin'?ark.network:'Bitcoin'}`,status:ready?'Ready':'Experimental',ready};
  }
  case 'bark': {
   const bark=s.bark,ready=!!bark?.configured&&!bark.locked&&!!bark.address;
   return {...base,name:'Bark',balance:ready?`${bark!.balance.toLocaleString()} ${unit}`:'Connecting…',detail:`Second's Ark · ${bark?.network==='regtest'?'regtest':bark?.network==='bitcoin'||network==='mainnet'?'Bitcoin':'signet'}`,status:ready?(network==='mainnet'?'Real bitcoin':'Ready'):'Experimental',ready};
  }
  case 'spark': {
   const spark=s.spark,ready=!!spark?.configured&&!spark.locked&&!!spark.address;
   return {...base,name:'Spark',balance:ready?`${spark!.balance.toLocaleString()} ${unit}`:spark?.needsKey?'Needs a key':'Connecting…',detail:`Spark · ${network==='testnet'?'regtest':'Bitcoin'}`,status:ready?(network==='testnet'?'Ready':'Real bitcoin'):spark?.needsKey?'Set up':'Experimental',ready};
  }
  case 'bitcoin': return {...base,...bitcoinCard(s,unit)};
  case 'fedimint': return {...base,...fedimintCard(s,unit)};
  case 'usdt': {
   const usdt=s.usdt,ready=!!usdt?.configured&&!usdt.locked,test=network==='testnet'||(!!usdt?.chainId&&usdt.chainId!==1);
   return {...base,name:'USDT',balance:ready?`${formatPaymentAmount(usdt!.balance,usdt!.decimals)} ${test?'TEST-USDT':'USDT'}`:usdt?.configured&&!usdt.automatic?'Locked':'Connecting…',detail:usdt?.chainId===31337?'EVM local · test token':usdt?.chainId===11155111||(!usdt?.chainId&&test)?'Sepolia · test token':'Ethereum · via WDK',status:ready?'Ready':'Experimental',ready};
  }
 }
}

type Face=Omit<WalletCard<string>,'id'|'rail'|'network'>;
/** Lightning goes through its network's source: the Cashu mints (sharing the Cashu balance) unless another was chosen. */
function lightningCard(s:WalletState,cashu:string,unit:string):Face {
 const ln=s.lightning;
 if(!ln||!ln.providerId||ln.providerId===CASHU_MINT_SOURCE)return {name:'Lightning',balance:cashu,detail:'Invoices via Cashu',status:'Shared balance',ready:s.mints.length>0};
 const ready=ln.status==='ready';
 // Reconnecting: the last balance it read (the status says it is not a fresh one), until it is unavailable.
 const last=ln.status==='connecting'&&ln.balance!==undefined?`${ln.balance.toLocaleString()} ${unit}`:undefined;
 return {name:'Lightning',balance:ready?ln.balance!==undefined?`${ln.balance.toLocaleString()} ${unit}`:'Ready':ln.status==='error'?'Unavailable':last??'Connecting…',detail:`Via ${ln.alias??ln.label??ln.providerId}`,status:ready?'Ready':ln.status==='error'?'Check settings':'Connecting…',ready};
}
/** Federation ecash: the federations joined on this network, one balance. */
function fedimintCard(s:WalletState,unit:string):Face {
 const fm=s.fedimint,federations=fm?.federations??[],ready=federations.some(f=>f.status==='ready');
 const detail=federations.length===1?federations[0].name??'1 federation':federations.length?`${federations.length} federations`:'Federation ecash';
 if(fm?.unavailable)return {name:'Fedimint',balance:'Testnet only',detail,status:'Not on Mainnet yet',ready:false};
 if(!federations.length)return {name:'Fedimint',balance:'No federation',detail,status:'Set up',ready:false};
 return {name:'Fedimint',balance:ready?`${(fm!.balance).toLocaleString()} ${unit}`:federations.some(f=>f.status==='error')?'Unavailable':'Connecting…',detail,status:ready?'Ready':'Connecting…',ready};
}
/** On-chain Bitcoin through its network's source; there is none until one is set up. */
function bitcoinCard(s:WalletState,unit:string):Face {
 const bt=s.bitcoin,ready=bt?.status==='ready';
 const sats=(n:number)=>`${n.toLocaleString()} ${unit}`;
 const last=bt?.status==='connecting'&&bt.balance!==undefined?sats(bt.balance):undefined;
 return {name:'Bitcoin',balance:ready?sats(bt!.balance??0):!bt||bt.status==='none'?'No source':bt.status==='error'?'Unavailable':last??'Connecting…',
  detail:bt?.providerId?`On-chain · ${bt.alias??bt.label??bt.providerId}`:'On-chain',status:ready?'Ready':!bt||bt.status==='none'?'Set up':bt.status==='error'?'Check settings':'Connecting…',ready};
}
