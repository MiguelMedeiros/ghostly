import type {WalletState} from '../lib/platform';
import {walletCards,type WalletRail} from './walletCardData';
import {CardDeck} from './WalletCardDeck';
export {CardDeck,WalletCardFace,type CardDeckProps} from './WalletCardDeck';

/** The wallet page's deck: tabs over the chosen card's panel. */
export function WalletDeck({state,selected,onSelect,testMints}:{state:WalletState;selected:WalletRail;onSelect:(rail:WalletRail)=>void;testMints:readonly string[]}) {
 return <CardDeck cards={walletCards(state,testMints,{badged:true})} selected={selected} onSelect={onSelect} kind="tabs" label="Wallet integrations" name="wallet-deck"
  testId={rail=>`wallet-card-${rail}`}/>;
}
