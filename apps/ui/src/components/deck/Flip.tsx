import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {useOptionalI18n} from '../../contexts/I18nContext';
import './flip.css';

/**
 * The turning card: its front (the chosen card's face, as the deck showed it) and its back, in the same place. It
 * starts a card's height and grows to what its back holds as it turns (a payment's review is long), following the
 * back's height after. With reduced motion the faces cross-fade instead of turning.
 *
 * `className` names the kind (`payment` → `payment-flip`, `payment-flip-card`, `payment-flip-front`…), beside the
 * generic `deck-flip…` classes flip.css styles; `tone` is the class that gives the front its card's colour.
 */
export function CardFlip({flipped,front,back,className,tone='',onSettle}:{flipped:boolean;front:ReactNode;back:ReactNode;className:string;tone?:string;
 /** Whether the back is turned and still (`true` once the turn is over), for a back whose buttons wait for that. */
 onSettle?:(settled:boolean)=>void}) {
 const part=(p:string)=>`deck-${p} ${className}-${p}`;
 const box=useRef<HTMLDivElement>(null),backRef=useRef<HTMLDivElement>(null),cardRef=useRef<HTMLDivElement>(null);
 // A click that lands while the card is turning can reach nothing: its back is still swinging round (the matrix saw a
 // Request lost that way, #762). The back is settled once the turn is over, as long as flip.css's transition says;
 // with reduced motion there is no turn (the faces cross-fade where they are), so it is settled at once.
 const [settledTurn,setSettledTurn]=useState(false);
 useLayoutEffect(()=>{
  if(!flipped){setSettledTurn(false);return;}
  const ms=turnMs(cardRef.current);
  if(!ms){setSettledTurn(true);return;}
  const timer=setTimeout(()=>setSettledTurn(true),ms);
  return ()=>clearTimeout(timer);
 },[flipped]);
 const settled=flipped&&settledTurn;
 const onSettleRef=useRef(onSettle);onSettleRef.current=onSettle;
 useLayoutEffect(()=>{onSettleRef.current?.(settled);},[settled]);
 const [backHeight,setBackHeight]=useState(0),[cardWidth,setCardWidth]=useState(0);
 useLayoutEffect(()=>{
  const face=backRef.current,el=box.current;
  if(!face||!el)return;
  const measure=()=>{setBackHeight(face.offsetHeight);setCardWidth(el.clientWidth);};
  measure();
  const observer=new ResizeObserver(measure);observer.observe(face);observer.observe(el);
  return ()=>observer.disconnect();
 },[]);
 const cardHeight=Math.round(cardWidth/1.586);
 return <div ref={box} className={part('flip')} data-flipped={flipped} data-turning={flipped&&!settled||undefined} style={{'--card-w':`${cardWidth}px`,'--card-h':`${cardHeight}px`,height:flipped?backHeight:cardHeight} as CSSProperties}>
  <div ref={cardRef} className={part('flip-card')}>
   <div className={`${part('flip-front')}${tone?` ${tone}`:''}`} aria-hidden="true">{front}</div>
   <div ref={backRef} className={part('flip-back')}>{back}</div>
  </div>
 </div>;
}

/** How long the card's turn lasts, from its transition (flip.css): 0 when there is none (reduced motion, no styles). */
function turnMs(card:HTMLElement|null):number {
 if(!card)return 0;
 const style=getComputedStyle(card);
 const seconds=(list:string)=>list.split(',').map(v=>{const n=parseFloat(v);return Number.isFinite(n)?(v.trim().endsWith('ms')?n/1000:n):0;});
 const durations=seconds(style.transitionDuration||''),delays=seconds(style.transitionDelay||'');
 const longest=Math.max(0,...durations.map((d,i)=>d+(delays[i%Math.max(1,delays.length)]??0)));
 const ms=Math.round(longest*1000);
 // Reduced motion leaves every transition 0.01 ms long (index.css): no turn to wait for.
 return ms<1?0:ms;
}

/**
 * On a turned card's back, the way back to the deck: "‹ Cards" in its top-left corner, in the card's ink, where a
 * back button is looked for (Escape does the same, PaymentComposer.tsx). `label` says it in full.
 */
export function FlipTurnButton({testId,label,onClick}:{testId:string;label:string;onClick:()=>void}) {
 const cards=useOptionalI18n()?.t('common.deck.turnBack')??'Cards';
 return <button type="button" className="deck-flip-turn" data-testid={testId} aria-label={label} title={label} onClick={onClick}>
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
  <span>{cards}</span>
 </button>;
}
