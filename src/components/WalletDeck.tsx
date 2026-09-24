import type {WalletState} from '../lib/platform';
import {walletCards,type WalletCard,type WalletRail} from './walletCardData';
import {WalletMark} from './WalletCards';
import {Deck} from './deck/Deck';
import './wallet-deck.css';

/**
 * The wallets as a deck of payment cards (deck/Deck.tsx does the stack, the track, the keys and the motion): on the
 * wallet page, tabs over the chosen card's panel; in the chat, the choice of how to pay.
 */
/** A card's face: the same on the wallet page, in the chat and on the front of the chat's flipping card. */
export function WalletCardFace({card,after}:{card:WalletCard;after?:boolean}) {
 return <span className="wallet-deck-face" data-deck="face" data-after={after||undefined}>
  <span className="wallet-deck-card-glyph" aria-hidden="true"><WalletMark rail={card.id}/></span>
  <span className="wallet-deck-card-status">{card.status}</span>
  {/* A card after the chosen one shows only its trailing edge: its mark is there too. */}
  <span className="wallet-deck-card-glyph-end" aria-hidden="true"><WalletMark rail={card.id}/></span>
  <span className="wallet-deck-card-ghost" data-deck="ghost" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/><circle cx="9" cy="9" r="1.5" fill="var(--ghost-eye)"/><circle cx="15" cy="9" r="1.5" fill="var(--ghost-eye)"/></svg></span>
  <span className="wallet-deck-card-text"><span className="wallet-deck-card-name">{card.name}</span><span className="wallet-deck-card-balance">{card.balance}</span><span className="wallet-deck-card-detail">{card.detail}</span></span>
  <span className="wallet-deck-card-chip" aria-hidden="true"/>
  <span className="wallet-deck-card-sheen" data-deck="sheen" aria-hidden="true"/>
 </span>;
}

export interface CardDeckProps {
 cards:WalletCard[];
 selected:WalletRail;
 /** A card came up: by the pointer passing over it, a swipe, the arrows or a key. */
 onSelect:(rail:WalletRail)=>void;
 /** A card was clicked (or Enter on it). Without this, a click only selects. */
 onChoose?:(rail:WalletRail)=>void;
 /** The wallet page's cards are tabs over a panel; the chat's are a choice of how to pay. */
 kind:'tabs'|'radios';
 label:string;
 testId:(rail:WalletRail)=>string;
 /** Why a card cannot be used here: it still comes up, to say so, but is not chosen. */
 blocked?:(card:WalletCard)=>string|undefined;
 /** Largest card and its share of the deck's width. */
 size?:{max:number;share:number};
 /** How long the pointer rests on a card before it comes up, so a pass across the deck does not flip every card. */
 hoverDelay?:number;
 /** The deck's own name for its arrows' test ids. */
 name:string;
 compact?:boolean;
}

const WALLET_PANEL={id:'wallet-panel',tabId:(rail:string)=>`wallet-tab-${rail}`};

export function CardDeck({onSelect,onChoose,testId,...props}:CardDeckProps) {
 return <Deck<WalletCard> {...props} className="wallet-deck" panel={WALLET_PANEL}
  onSelect={id=>onSelect(id as WalletRail)} onChoose={onChoose&&(id=>onChoose(id as WalletRail))} testId={card=>testId(card.id)}
  face={(card,{after})=><WalletCardFace card={card} after={after}/>} mark={card=><WalletMark rail={card.id}/>} tone={card=>`wallet-card-${card.id}`}/>;
}

/** The wallet page's deck: tabs over the chosen card's panel. */
export function WalletDeck({state,selected,onSelect,testMints}:{state:WalletState;selected:WalletRail;onSelect:(rail:WalletRail)=>void;testMints:readonly string[]}) {
 return <CardDeck cards={walletCards(state,testMints,{badged:true})} selected={selected} onSelect={onSelect} kind="tabs" label="Wallet integrations" name="wallet-deck"
  testId={rail=>`wallet-card-${rail}`} hoverDelay={90}/>;
}
