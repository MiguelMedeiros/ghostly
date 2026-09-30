import type {WalletNetwork} from '../lib/platform';
import type {InstanceCard} from './walletCardData';
import {CardDeck} from './WalletCardDeck';
import {useI18n} from '../contexts/I18nContext';
export {CardDeck,WalletCardFace,type CardDeckProps} from './WalletCardDeck';

/** A wallet card's test id: its kind and its network (`wallet-card-cashu-testnet`), and one Lightning card of several's id. */
export const walletCardTestId=(id:string)=>`wallet-card-${id.replace(/:/g,'-')}`;

/**
 * The wallet page's deck: tabs over the chosen card's panel, one card per wallet. The page shows one network's at a
 * time (`network`: its arrows are `wallet-deck-<network>-prev`/`-next`).
 * `onSelect`: a card came up (the pointer passing over it, a key, a swipe, the arrows); `onChoose`: a person clicked
 * it, tapped it or pressed Enter on it.
 */
export function WalletDeck({cards,selected,onSelect,onChoose,network}:{cards:InstanceCard[];selected:string;onSelect:(id:string)=>void;onChoose?:(id:string)=>void;network?:WalletNetwork}) {
 const {t}=useI18n();
 return <CardDeck<string> cards={cards} selected={selected} onSelect={onSelect} onChoose={onChoose} kind="tabs" name={network?`wallet-deck-${network}`:'wallet-deck'}
  label={network==='mainnet'?t('wallet.cards.deck.mainnet'):network==='testnet'?t('wallet.cards.deck.testnet'):t('wallet.cards.deck.integrations')} testId={walletCardTestId}/>;
}
