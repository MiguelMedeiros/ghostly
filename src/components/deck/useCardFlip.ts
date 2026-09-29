import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {playCue} from '../../lib/cues';

/** How long the card takes to turn (flip.css's transitions). */
export const FLIP_MS=520;
/** With reduced motion the faces cross-fade instead, this long. */
export const FADE_MS=200;
const reducedMotion=()=>typeof window!=='undefined'&&(document.documentElement.dataset.reduceMotion==='true'||window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * A card chosen from a deck, turned over: the chat's payment picker (PaymentComposer.tsx: the amount on a payment
 * card's back) and its identity picker (identities/ComposerIdentities.tsx: what the contact sees, on an ID card's
 * back). `side` is which of the two the picker shows (the deck, or the chosen card); `flipped` is where the card is
 * in its turn. `turn()` mounts the card face up and turns it on the next frames, so the turn is a transition from
 * the front; `turnBack()` turns it face up again, then gives the deck back once the turn is over.
 */
export function useCardFlip(initial:'cards'|'back'='cards') {
 const [side,setSide]=useState(initial);
 const [flipped,setFlipped]=useState(initial==='back');
 useLayoutEffect(()=>{
  if(side!=='back')return;
  let frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>setFlipped(true));});
  return ()=>cancelAnimationFrame(frame);
 },[side]);
 const timer=useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 const turn=useCallback(()=>{clearTimeout(timer.current);setSide('back');playCue('flip');},[]);
 const turnBack=useCallback(()=>{
  setFlipped(false);clearTimeout(timer.current);playCue('flip');
  timer.current=setTimeout(()=>setSide('cards'),reducedMotion()?FADE_MS:FLIP_MS);
 },[]);
 return {side,flipped,turn,turnBack};
}
