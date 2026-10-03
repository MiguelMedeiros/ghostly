import {formatPaymentAmount} from '@ghostly/core';
import type {WalletInstanceView, WalletNetwork, WalletPlatform, WalletState} from '../lib/platform';
import type {WalletCard,WalletRail} from './walletCardTypes';
import type {Translate} from '../contexts/I18nContext';
import {english} from '../lib/english';
import { formatAmount, formatTokenAmount } from "../lib/amount";
export type {ChatRail,WalletCard,WalletRail} from './walletCardTypes';
export const CASHU_MINT_SOURCE = 'cashu-mint';
/** The fee limit an on-chain payment starts with, in sats: a small transaction at a few sat/vB. The review shows the real fee. */
export const ONCHAIN_FEE_CAP = 2_000;

/**
 * A wallet's card: one type on one network. `id` is the wallet's own (`cashu:testnet`). A network with several
 * Lightning cards has one per card (`lightning:testnet:<card>`, `card` its id); its only one is `lightning:testnet`.
 */
export interface InstanceCard extends WalletCard<string> {rail:WalletRail;network:WalletNetwork;card?:string;
 /** One Lightning card of several: the network's default for receiving. */
 receive?:boolean}
export const cardId=(rail:WalletRail,network:WalletNetwork,card?:string)=>card?`${rail}:${network}:${card}`:`${rail}:${network}`;
export const parseCardId=(id:string):{rail:WalletRail;network:WalletNetwork;card?:string}|undefined=>{
 const [rail,network,card]=id.split(':');
 return network==='mainnet'||network==='testnet'?{rail:rail as WalletRail,network,...(card?{card}:{})}:undefined;
};
/** A wallet card's deck id: a network's only Lightning card is its Lightning (`lightning:testnet`), one of several its own. */
export const deckId=(w:Pick<WalletInstanceView,'type'|'network'|'card'>,state:WalletState)=>cardId(w.type,w.network,w.type==='lightning'&&lightningCount(state,w.network)>1?w.card:undefined);
const lightningCount=(state:WalletState,network:WalletNetwork)=>(state.wallets??[]).filter(w=>w.type==='lightning'&&w.network===network).length;
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

/**
 * One network's wallets, as the cards read them: that network's own views, else (an older engine) the flat state.
 * `card`: `lightning` is that Lightning card's, as a platform bound to it (`wallet.forLightning`) sees it.
 */
export const networkState=(state:WalletState,network:WalletNetwork,card?:string):WalletState=>{
 const here=state.networks?.[network];
 const lightning=card?here?.lightnings?.find(c=>c.card===card)??here?.lightning:here?.lightning??state.lightning;
 return {...state,...here,lightning,mode:network};
};
/**
 * The Lightning cards of a network that can pay an invoice, in the deck's order, and the one to start on: the first
 * that is ready and holds enough (when it says), else the first ready one, else the first.
 */
export function lightningPayers(state:WalletState|null|undefined,amount?:number):{cards:NonNullable<WalletState['lightnings']>;first?:string} {
 const cards=(state?.lightnings??[]).filter(c=>c.capabilities?.send!==false);
 const ready=cards.filter(c=>c.status==='ready');
 const first=ready.find(c=>amount===undefined||c.balance===undefined||c.balance>=amount)??ready[0]??cards[0];
 return {cards,first:first?.card};
}
/** The platform a card's panel and payments go through: its network's, and its own Lightning card when it is one of several. */
export const cardWallet=(wallet:WalletPlatform,card:Pick<InstanceCard,'network'|'card'>)=>card.card?wallet.forNetwork(card.network).forLightning(card.card):wallet.forNetwork(card.network);

/**
 * The wallets' cards, shared by the wallet page and the chat's payment picker: one per wallet the profile has, each
 * on its network, in the deck's order.
 */
export function walletCards(state:WalletState,{lightning='cards',t=english}:{lightning?:'cards'|'default';t?:Translate}={}):InstanceCard[] {
 return (state.wallets??[]).flatMap(w=>{
  if(w.type!=='lightning')return [away(w,walletCard(w.type,w.network,networkState(state,w.network),undefined,t),t)];
  // The Accept side: one Lightning card per network, the default for receiving (a request's invoice comes from it).
  if(lightning==='default')return w.receive===false||w.home?[]:[walletCard(w.type,w.network,networkState(state,w.network),undefined,t)];
  const card=deckId(w,state)===cardId(w.type,w.network)?undefined:w.card;
  return [away(w,walletCard(w.type,w.network,networkState(state,w.network,w.card),card,t),t)];
 });
}

/** A wallet at home on another device (WISP 06): its card says where, and it cannot be used here. */
const away=(w:WalletInstanceView,card:InstanceCard,t:Translate):InstanceCard=>w.home?{...card,balance:t('wallet.cards.balance.away',{device:w.home.device||t('wallet.away.otherDevice')}),status:t('wallet.cards.status.away'),ready:false}:card;

/** A network's default Lightning card before its other Lightning cards, the rest in order: a request starts on it. */
export const receivingFirst=<C extends InstanceCard>(cards:C[]):C[]=>{
 const out=[...cards];
 for(const network of ['mainnet','testnet'] as const){
  // The places a network's Lightning cards hold, filled again with the default one first.
  const at=out.flatMap((c,i)=>c.rail==='lightning'&&c.network===network?[i]:[]);
  const ln=at.map(i=>out[i]),sorted=[...ln.filter(c=>c.receive),...ln.filter(c=>!c.receive)];
  at.forEach((i,k)=>{out[i]=sorted[k];});
 }
 return out;
};
/** Real money first, then test money, each network's cards in the deck's order: a deck that mixes both keeps them apart. */
export const byNetwork=<C extends {network:WalletNetwork}>(cards:C[]):C[]=>[...cards.filter(c=>c.network==='mainnet'),...cards.filter(c=>c.network==='testnet')];

/**
 * What one wallet's card shows, from its network's state. `card`: one Lightning card of several on its network. `t`:
 * the app's language (English without it).
 */
export function walletCard(rail:WalletRail,network:WalletNetwork,s:WalletState,card?:string,t:Translate=english):InstanceCard {
 const unit=t(network==='testnet'?'wallet.sats.testnet':'wallet.sats.mainnet'),base={id:cardId(rail,network,card),rail,network,...(card?{card}:{})};
 const sats=(n:number)=>t('wallet.cards.amount',{amount:formatAmount(n, t.language),unit});
 const cashu=sats(Math.max(0,s.balance));
 const ready_=t('wallet.cards.status.ready'),connecting=t('wallet.cards.status.connecting'),experimental=t('wallet.cards.status.experimental'),setUp=t('wallet.cards.status.setUp'),realBitcoin=t('wallet.cards.status.realBitcoin');
 switch(rail) {
  case 'cashu': return {...base,name:'Cashu',balance:cashu,detail:network==='testnet'?t('wallet.cards.detail.cashuTestnet'):t('wallet.cards.detail.cashuMainnet'),status:s.mints.length?ready_:setUp,ready:s.mints.length>0};
  case 'lightning': {
   const face=lightningCard(t,s,cashu,sats);
   // One of several: its own name, and the network's default for receiving says so.
   return card?{...base,...face,name:s.lightning?.name||face.name,...(s.lightning?.receive?{tag:t('wallet.cards.tag.default'),receive:true}:{})}:{...base,...face};
  }
  case 'arkade': {
   const ark=s.ark,ready=!!ark?.configured&&!ark.locked&&!!ark.address;
   // Ready means it can receive: an Ark wallet that has no address yet (its provider has not answered) is not.
   return {...base,name:'Ark',balance:ready?sats(ark!.balance):ark?.configured&&!ark.automatic?t('wallet.cards.balance.locked'):connecting,detail:`Arkade · ${ark?.network&&ark.network!=='bitcoin'?ark.network:'Bitcoin'}`,status:ready?ready_:experimental,ready};
  }
  case 'bark': {
   const bark=s.bark,ready=!!bark?.configured&&!bark.locked&&!!bark.address;
   return {...base,name:'Bark',balance:ready?sats(bark!.balance):connecting,detail:t('wallet.cards.detail.bark',{network:bark?.network==='regtest'?'regtest':bark?.network==='bitcoin'||network==='mainnet'?'Bitcoin':'signet'}),status:ready?(network==='mainnet'?realBitcoin:ready_):experimental,ready};
  }
  case 'spark': {
   const spark=s.spark,ready=!!spark?.configured&&!spark.locked&&!!spark.address;
   return {...base,name:'Spark',balance:ready?sats(spark!.balance):spark?.needsKey?t('wallet.cards.balance.needsKey'):connecting,detail:`Spark · ${network==='testnet'?'regtest':'Bitcoin'}`,status:ready?(network==='testnet'?ready_:realBitcoin):spark?.needsKey?setUp:experimental,ready};
  }
  case 'bitcoin': return {...base,...bitcoinCard(t,s,sats)};
  case 'fedimint': return {...base,...fedimintCard(t,s,sats)};
  case 'usdt': {
   const usdt=s.usdt,ready=!!usdt?.configured&&!usdt.locked,test=network==='testnet'||(!!usdt?.chainId&&usdt.chainId!==1);
   return {...base,name:'USDT',balance:ready?t('wallet.cards.amount',{amount:formatTokenAmount(usdt!.balance,usdt!.decimals,t.language),unit:test?'TEST-USDT':'USDT'}):usdt?.configured&&!usdt.automatic?t('wallet.cards.balance.locked'):connecting,detail:usdt?.chainId===31337?t('wallet.cards.detail.usdtLocal'):usdt?.chainId===11155111||(!usdt?.chainId&&test)?t('wallet.cards.detail.usdtSepolia'):t('wallet.cards.detail.usdtEthereum'),status:ready?ready_:experimental,ready};
  }
 }
}

/**
 * A card whose wallet is not set up yet (its status says Set up, or Shared balance with no mint to share): pass the
 * same `t` the cards were made with, so the comparison is in the same language.
 */
export const cardNotSetUp=(card:Pick<WalletCard<string>,'status'>,t:Translate=english)=>card.status===t('wallet.cards.status.setUp')||card.status===t('wallet.cards.status.sharedBalance');

/**
 * What a card can spend now, from its own wallet: `s` is its network's state (`networkState`, with the card's
 * Lightning). In sats, USDT in whole tokens. `undefined` when the card cannot say (not ready, locked, its source has
 * not read a balance): nothing is claimed then. Lightning through the Cashu mints spends the Cashu balance, as its
 * face says; through its own source (LND, CLN, NWC, Breez...), that source's.
 */
export function spendable(rail:WalletRail,s:WalletState):number|undefined {
 const cashu=s.mints.length?Math.max(0,s.balance):undefined;
 switch(rail){
  case 'cashu': return cashu;
  case 'lightning': {
   const ln=s.lightning;
   if(!ln||!ln.providerId||ln.providerId===CASHU_MINT_SOURCE)return cashu;
   return ln.status==='ready'?ln.balance:undefined;
  }
  case 'arkade': return s.ark?.configured&&!s.ark.locked&&s.ark.address?s.ark.balance:undefined;
  case 'bark': return s.bark?.configured&&!s.bark.locked&&s.bark.address?s.bark.balance:undefined;
  case 'spark': return s.spark?.configured&&!s.spark.locked&&s.spark.address?s.spark.balance:undefined;
  case 'bitcoin': return s.bitcoin?.status==='ready'?s.bitcoin.balance:undefined;
  case 'fedimint': return s.fedimint?.federations?.some(f=>f.status==='ready')?s.fedimint.balance:undefined;
  case 'usdt': return s.usdt?.configured&&!s.usdt.locked?Number(formatPaymentAmount(s.usdt.balance,s.usdt.decimals)):undefined;
 }
}

type Face=Omit<WalletCard<string>,'id'|'rail'|'network'>;
/** Lightning goes through its network's source: the Cashu mints (sharing the Cashu balance) unless another was chosen. */
function lightningCard(t:Translate,s:WalletState,cashu:string,sats:(n:number)=>string):Face {
 const ln=s.lightning;
 if(!ln||!ln.providerId||ln.providerId===CASHU_MINT_SOURCE)return {name:'Lightning',balance:cashu,detail:t('wallet.cards.detail.lightningCashu'),status:t('wallet.cards.status.sharedBalance'),ready:s.mints.length>0};
 const ready=ln.status==='ready';
 // Reconnecting: the last balance it read (the status says it is not a fresh one), until it is unavailable.
 const last=ln.status==='connecting'&&ln.balance!==undefined?sats(ln.balance):undefined;
 return {name:'Lightning',balance:ready?ln.balance!==undefined?sats(ln.balance):t('wallet.cards.status.ready'):ln.status==='error'?t('wallet.cards.balance.unavailable'):last??t('wallet.cards.status.connecting'),detail:t('wallet.cards.detail.lightningVia',{name:ln.alias??ln.label??ln.providerId}),status:ready?t('wallet.cards.status.ready'):ln.status==='error'?t('wallet.cards.status.checkSettings'):t('wallet.cards.status.connecting'),ready};
}
/** Federation ecash: the federations joined on this network, one balance. */
function fedimintCard(t:Translate,s:WalletState,sats:(n:number)=>string):Face {
 const fm=s.fedimint,federations=fm?.federations??[],ready=federations.some(f=>f.status==='ready');
 const detail=federations.length===1?federations[0].name??t('wallet.cards.detail.federationOne'):federations.length?t('wallet.cards.detail.federations',{count:federations.length}):t('wallet.cards.detail.federationEcash');
 if(!federations.length)return {name:'Fedimint',balance:t('wallet.cards.balance.noFederation'),detail,status:t('wallet.cards.status.setUp'),ready:false};
 return {name:'Fedimint',balance:ready?sats(fm!.balance):federations.some(f=>f.status==='error')?t('wallet.cards.balance.unavailable'):t('wallet.cards.status.connecting'),detail,status:ready?t('wallet.cards.status.ready'):t('wallet.cards.status.connecting'),ready};
}
/** On-chain Bitcoin through its network's source; there is none until one is set up. */
function bitcoinCard(t:Translate,s:WalletState,sats:(n:number)=>string):Face {
 const bt=s.bitcoin,ready=bt?.status==='ready';
 const last=bt?.status==='connecting'&&bt.balance!==undefined?sats(bt.balance):undefined;
 return {name:'Bitcoin',balance:ready?sats(bt!.balance??0):!bt||bt.status==='none'?t('wallet.cards.balance.noSource'):bt.status==='error'?t('wallet.cards.balance.unavailable'):last??t('wallet.cards.status.connecting'),
  detail:bt?.providerId?t('wallet.cards.detail.onchainVia',{name:bt.alias??bt.label??bt.providerId}):t('wallet.cards.detail.onchain'),status:ready?t('wallet.cards.status.ready'):!bt||bt.status==='none'?t('wallet.cards.status.setUp'):bt.status==='error'?t('wallet.cards.status.checkSettings'):t('wallet.cards.status.connecting'),ready};
}
