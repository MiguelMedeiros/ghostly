import type {WalletState} from '../lib/platform';
import {walletCards,type WalletCard} from './walletCardData';
import './wallet-cards.css';
import type {WalletRail} from './walletCardData';
export type {WalletRail} from './walletCardData';
export function WalletMark({rail}:{rail:WalletRail}) {
 return <svg viewBox="0 0 32 32" width="26" height="26" fill="none" aria-hidden="true">
  {rail==='cashu'?<><circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.8"/><path d="M20 10a7 7 0 1 0 0 12M12 7v18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></>:rail==='lightning'?<path d="m19 3-13 16h9l-2 10L27 12h-9l1-9Z" fill="currentColor"/>:rail==='arkade'?<><path d="M5 24 16 6l11 18M10 17h12M9 24h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></>:rail==='bark'?<><path d="M4 20c4-2 7-2 12 0s8 2 12 0M8 20l3-11h10l3 11M16 9V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></>:<><path d="M6 7h20v5h-7v15h-6V12H6V7Z" fill="currentColor"/><ellipse cx="16" cy="16" rx="12" ry="3" stroke="currentColor" strokeWidth="1.5"/></>}
 </svg>;
}
const Check=()=><span className="wallet-card-selected" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2"/></svg></span>;
export function WalletCards({state,selected,onSelect,testMints}:{state:WalletState;selected:WalletRail|null;onSelect:(rail:WalletRail)=>void;testMints:readonly string[]}) {
 return <div className="wallet-card-grid" role="group" aria-label="Wallet integrations">
  {walletCards(state,testMints).map(card=><button key={card.id} type="button" className={`wallet-card wallet-card-${card.id}`} aria-label={`Select ${card.name} wallet`} aria-pressed={selected===card.id} data-testid={`wallet-card-${card.id}`} onClick={()=>onSelect(card.id)}>
   <span className="wallet-card-top"><WalletMark rail={card.id}/><Check/></span>
   <span className="wallet-card-name">{card.name}</span><span className="wallet-card-balance">{card.balance}</span>
   <span className="wallet-card-detail">{card.detail}</span><span className="wallet-card-status">{card.status}</span>
  </button>)}
 </div>;
}
/** The same cards, small, to pick how a payment in the chat is made. */
export function MiniCards({state,testMints,selected,onSelect,disabled}:{state:WalletState;testMints:readonly string[];selected:WalletRail;onSelect:(rail:WalletRail)=>void;disabled?:(card:WalletCard)=>string|undefined}) {
 return <div className="wallet-card-row" role="radiogroup" aria-label="Pay with">
  {walletCards(state,testMints).map(card=>{const why=disabled?.(card);return <button key={card.id} type="button" role="radio" aria-checked={selected===card.id} aria-pressed={selected===card.id} disabled={!!why} title={why??card.detail} className={`wallet-card wallet-card-mini wallet-card-${card.id}`} data-testid={`payment-card-${card.id}`} onClick={()=>onSelect(card.id)}>
   <span className="wallet-card-top"><WalletMark rail={card.id}/><Check/></span>
   <span className="wallet-card-name">{card.name}</span><span className="wallet-card-balance">{card.balance}</span>
  </button>;})}
 </div>;
}
