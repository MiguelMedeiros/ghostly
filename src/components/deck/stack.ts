/**
 * Where the cards of a deck's stack sit (Deck.tsx: the wallet's cards, the identities). Every card keeps its own
 * place in a row, overlapping the next like cards tucked in a wallet: choosing one lifts it to the top, and
 * nothing moves sideways. That is what lets a mouse flip through them by passing over them: the card that comes
 * up is always under the pointer, so the pointer never finds itself over a different card only because the
 * chosen one changed.
 *
 * The part of a card that shows is its strip: the chosen card shows whole, the ones before it show their
 * leading edge (where the mark and name are), the ones after it their trailing edge. The strips tile the row,
 * and each card's button is its strip.
 */
export interface Strip {left:number;right:number}
export interface StackLayout {
 /** Card size, in pixels. */
 width:number;height:number;
 /** How far apart two cards are: the width of a strip that shows. */
 step:number;
 /** Each card's left edge, from the deck's left edge. */
 lefts:number[];
}
export const CARD_RATIO=1.586;

export function stackLayout(deckWidth:number,cards:number,{max=340,share=.62,gutter=8}:{max?:number;share?:number;gutter?:number}={}):StackLayout {
 const room=Math.max(0,deckWidth-2*gutter);
 const width=Math.round(Math.min(max,cards>1?room*share:room));
 // A strip is never wider than needed to read a mark and a name, so a wide column keeps the cards together.
 const step=cards>1?Math.max(0,Math.min(width*.42,(room-width)/(cards-1))):0;
 const span=width+step*(cards-1),start=(deckWidth-span)/2;
 return {width,height:Math.round(width/CARD_RATIO),step,lefts:Array.from({length:cards},(_,i)=>start+i*step)};
}

/** The part of each card that shows with `active` on top. */
export function stackStrips(layout:StackLayout,active:number):Strip[] {
 const {lefts,width,step}=layout,strips:Strip[]=[];
 // Each strip starts exactly where the one before it ends, so no point falls between two of them.
 lefts.forEach((left,i)=>{const right=i<active?left+step:left+width;strips.push({left:i?strips[i-1].right:left,right});});
 return strips;
}

/** Which card's strip is under `x`, or -1 beside the stack. */
export function stripAt(strips:readonly Strip[],x:number):number {
 return strips.findIndex(s=>x>=s.left&&x<s.right);
}

/** The card after or before `from`, going round at the ends. */
export const stepCard=(from:number,by:number,cards:number)=>cards?((from+by)%cards+cards)%cards:0;
