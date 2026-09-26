import type {WalletNetwork} from '../lib/platform';
import type {InstanceCard} from './walletCardData';
import {CardDeck} from './WalletCardDeck';
export {CardDeck,WalletCardFace,type CardDeckProps} from './WalletCardDeck';

/** A wallet card's test id: its kind and its network (`wallet-card-cashu-testnet`). */
export const walletCardTestId=(id:string)=>`wallet-card-${id.replace(':','-')}`;

/**
 * The wallet page's deck: tabs over the chosen card's panel, one card per wallet. The page shows one network's at a
 * time (`network`: its arrows are `wallet-deck-<network>-prev`/`-next`).
 * `onSelect`: a card came up (the pointer passing over it, a key, a swipe, the arrows); `onChoose`: a person clicked
 * it, tapped it or pressed Enter on it.
 */
export function WalletDeck({cards,selected,onSelect,onChoose,network}:{cards:InstanceCard[];selected:string;onSelect:(id:string)=>void;onChoose?:(id:string)=>void;network?:WalletNetwork}) {
 return <CardDeck<string> cards={cards} selected={selected} onSelect={onSelect} onChoose={onChoose} kind="tabs" name={network?`wallet-deck-${network}`:'wallet-deck'}
  label={network==='mainnet'?'Mainnet wallets':network==='testnet'?'Testnet wallets':'Wallet integrations'} testId={walletCardTestId}/>;
}
