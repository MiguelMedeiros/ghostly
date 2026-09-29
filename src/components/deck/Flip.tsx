import {useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import './flip.css';

/**
 * The turning card: its front (the chosen card's face, as the deck showed it) and its back, in the same place. It
 * starts a card's height and grows to what its back holds as it turns (a payment's review is long), following the
 * back's height after. With reduced motion the faces cross-fade instead of turning.
 *
 * `className` names the kind (`payment` → `payment-flip`, `payment-flip-card`, `payment-flip-front`…), beside the
 * generic `deck-flip…` classes flip.css styles; `tone` is the class that gives the front its card's colour.
 */
export function CardFlip({flipped,front,back,className,tone=''}:{flipped:boolean;front:ReactNode;back:ReactNode;className:string;tone?:string}) {
 const part=(p:string)=>`deck-${p} ${className}-${p}`;
 const box=useRef<HTMLDivElement>(null),backRef=useRef<HTMLDivElement>(null);
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
 return <div ref={box} className={part('flip')} data-flipped={flipped} style={{'--card-w':`${cardWidth}px`,'--card-h':`${cardHeight}px`,height:flipped?backHeight:cardHeight} as CSSProperties}>
  <div className={part('flip-card')}>
   <div className={`${part('flip-front')}${tone?` ${tone}`:''}`} aria-hidden="true">{front}</div>
   <div ref={backRef} className={part('flip-back')}>{back}</div>
  </div>
 </div>;
}

/**
 * On a turned card's back, the way back to the deck: "‹ Cards" in its top-left corner, in the card's ink, where a
 * back button is looked for (Escape does the same, PaymentComposer.tsx). `label` says it in full.
 */
export function FlipTurnButton({testId,label,onClick}:{testId:string;label:string;onClick:()=>void}) {
 return <button type="button" className="deck-flip-turn" data-testid={testId} aria-label={label} title={label} onClick={onClick}>
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
  <span>Cards</span>
 </button>;
}
