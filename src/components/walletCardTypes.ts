/**
 * A wallet card's shape, apart from how its contents are worked out (walletCardData.ts): the deck, the card's face and
 * its mark (WalletCardDeck.tsx, WalletCards.tsx) need only this, which is what lets the website show the app's own
 * deck (website/scripts/sync-app-deck.mjs copies these files).
 */
export type WalletRail = 'cashu' | 'lightning' | 'arkade' | 'bark' | 'spark' | 'usdt' | 'bitcoin' | 'fedimint';
/** The cards a chat can pay with: all of them. */
export type ChatRail = WalletRail;
/** The cards in the order the wallet shows them (walletCards). */
export const WALLET_RAILS: readonly WalletRail[] = ['cashu','lightning','arkade','bark','spark','bitcoin','fedimint','usdt'];
export interface WalletCard {id:WalletRail;name:string;balance:string;detail:string;status:string;ready:boolean}
