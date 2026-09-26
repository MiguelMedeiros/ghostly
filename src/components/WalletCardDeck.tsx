import {railOf,type WalletCard,type WalletRail} from './walletCardTypes';
import {WalletMark} from './WalletCards';
import {Deck} from './deck/Deck';
import './wallet-deck.css';

/**
 * The wallets as a deck of payment cards (deck/Deck.tsx does the stack, the track, the keys and the motion): on the
 * wallet page, tabs over the chosen card's panel; in the chat, the choice of how to pay. The website's home shows this
 * same deck: it imports nothing from the engine, so website/scripts/sync-app-deck.mjs copies it there as it is.
 */
/**
 * A card's face: the same on the wallet page, in the chat and on the front of the chat's flipping card. In a deck of
 * checks (the ways of paying a chat accepts) `checked` says whether it is on: its mark wears a check, or dims.
 */
export function WalletCardFace({card,after,checked}:{card:WalletCard<string>;after?:boolean;checked?:boolean}) {
 const check=checked!==undefined&&<span className="wallet-deck-card-check"><svg viewBox="0 0 12 12"><path d="m2.5 6.2 2.3 2.3 4.7-4.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
 return <span className="wallet-deck-face" data-deck="face" data-after={after||undefined} data-checked={checked}>
  <span className="wallet-deck-card-glyph" aria-hidden="true"><WalletMark rail={railOf(card)}/>{check}</span>
  <span className="wallet-deck-card-status">{card.network==='testnet'&&<span className="wallet-deck-card-network" data-testid="wallet-card-network">Testnet</span>}{card.status}</span>
  {/* A card after the chosen one shows only its trailing edge: its mark is there too. */}
  <span className="wallet-deck-card-glyph-end" aria-hidden="true"><WalletMark rail={railOf(card)}/>{check}</span>
  <span className="wallet-deck-card-ghost" data-deck="ghost" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/><circle cx="9" cy="9" r="1.5" fill="var(--ghost-eye)"/><circle cx="15" cy="9" r="1.5" fill="var(--ghost-eye)"/></svg></span>
  <span className="wallet-deck-card-text"><span className="wallet-deck-card-name">{card.name}</span><span className="wallet-deck-card-balance">{card.balance}</span><span className="wallet-deck-card-detail">{card.detail}</span></span>
  <span className="wallet-deck-card-chip" aria-hidden="true"/>
  <span className="wallet-deck-card-sheen" data-deck="sheen" aria-hidden="true"/>
 </span>;
}

export interface CardDeckProps<Id extends string=WalletRail> {
 cards:WalletCard<Id>[];
 selected:Id;
 /** A card came up: by the pointer passing over it, a swipe, the arrows or a key. */
 onSelect:(id:Id)=>void;
 /** A card was clicked (or Enter on it). Without this, a click only selects. In a deck of checks, it turns the card on or off. */
 onChoose?:(id:Id)=>void;
 /** The wallet page's cards are tabs over a panel; the chat's are a choice of how to pay, or the ways it accepts (checks). */
 kind:'tabs'|'radios'|'checks';
 /** In a deck of checks, the cards that are on. */
 checked?:(card:WalletCard<Id>)=>boolean;
 label:string;
 testId:(id:Id)=>string;
 /** Why a card cannot be used here: it still comes up, to say so, but is not chosen. */
 blocked?:(card:WalletCard<Id>)=>string|undefined;
 /** Largest card and its share of the deck's width. */
 size?:{max:number;share:number};
 /** The deck's own name for its arrows' test ids. */
 name:string;
 compact?:boolean;
}

const WALLET_PANEL={id:'wallet-panel',tabId:(rail:string)=>`wallet-tab-${rail}`};

export function CardDeck<Id extends string=WalletRail>({onSelect,onChoose,testId,...props}:CardDeckProps<Id>) {
 return <Deck<WalletCard<Id>> {...props} className="wallet-deck" panel={WALLET_PANEL}
  onSelect={id=>onSelect(id as Id)} onChoose={onChoose&&(id=>onChoose(id as Id))} testId={card=>testId(card.id)}
  face={(card,{after,checked})=><WalletCardFace card={card} after={after} checked={checked}/>} mark={card=><WalletMark rail={railOf(card)}/>} tone={card=>`wallet-card-${railOf(card)}`}/>;
}
