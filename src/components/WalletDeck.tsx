import type {WalletNetwork} from '../lib/platform';
import type {InstanceCard} from './walletCardData';
import {CardDeck} from './WalletCardDeck';
export {CardDeck,WalletCardFace,type CardDeckProps} from './WalletCardDeck';

/** A wallet card's test id: its kind and its network (`wallet-card-cashu-testnet`). */
export const walletCardTestId=(id:string)=>`wallet-card-${id.replace(':','-')}`;

/**
 * The wallet page's deck: tabs over the chosen card's panel, one card per wallet. The page has one per network
 * (`network`: its arrows are `wallet-deck-<network>-prev`/`-next`); the one whose card is not the panel's rests.
 */
export function WalletDeck({cards,selected,onSelect,network,resting}:{cards:InstanceCard[];selected:string;onSelect:(id:string)=>void;network?:WalletNetwork;resting?:boolean}) {
 return <CardDeck<string> cards={cards} selected={selected} onSelect={onSelect} kind="tabs" name={network?`wallet-deck-${network}`:'wallet-deck'} resting={resting}
  label={network==='mainnet'?'Mainnet wallets':network==='testnet'?'Testnet wallets':'Wallet integrations'} testId={walletCardTestId}/>;
}
