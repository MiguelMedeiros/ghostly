import type {InstanceCard} from './walletCardData';
import {CardDeck} from './WalletCardDeck';
export {CardDeck,WalletCardFace,type CardDeckProps} from './WalletCardDeck';

/** A wallet card's test id: its kind and its network (`wallet-card-cashu-testnet`). */
export const walletCardTestId=(id:string)=>`wallet-card-${id.replace(':','-')}`;

/** The wallet page's deck: tabs over the chosen card's panel, one card per wallet, each on its network. */
export function WalletDeck({cards,selected,onSelect}:{cards:InstanceCard[];selected:string;onSelect:(id:string)=>void}) {
 return <CardDeck<string> cards={cards} selected={selected} onSelect={onSelect} kind="tabs" label="Wallet integrations" name="wallet-deck"
  testId={walletCardTestId}/>;
}
