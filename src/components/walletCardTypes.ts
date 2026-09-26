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
/**
 * One card. `id` is what the deck selects: the rail itself where there is one card per rail (the website's deck), or
 * a wallet's own id where a rail can have a card per network (the app's wallets). `rail` is the kind of wallet when
 * `id` is not it; `network` puts a small Testnet tag on a test wallet's card.
 */
export interface WalletCard<Id extends string = WalletRail> {id:Id;rail?:WalletRail;network?:'mainnet'|'testnet';name:string;balance:string;detail:string;status:string;ready:boolean;
 /** A short mark beside the status: the default Lightning card for receiving says "Default". */
 tag?:string}
/** The kind of wallet a card is. */
export const railOf=(card:Pick<WalletCard<string>,'id'|'rail'>):WalletRail=>card.rail??card.id as WalletRail;
