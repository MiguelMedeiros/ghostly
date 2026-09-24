import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type KeyboardEvent,type PointerEvent} from 'react';
import type {WalletState} from '../lib/platform';
import {walletCards,type WalletCard,type WalletRail} from './walletCardData';
import {WalletMark} from './WalletCards';
import {stackLayout,stackStrips,stepCard,stripAt} from './walletStack';
import {playSwitch,switchDirection} from './walletDeckMotion';
import './wallet-deck.css';

/**
 * The wallets as a stack of cards, the way they sit in a wallet. With a mouse they overlap in a row and flip
 * up as the pointer passes over them: every card keeps its place (walletStack.ts), so the one that comes up is
 * the one under the pointer. On a touch screen they are a horizontal snapping track instead, and the card that
 * comes to rest in the centre is the chosen one. Either way the arrows under the deck, the arrow keys, Home and
 * End move along it.
 *
 * Each card's button is only the strip of it that shows (the strips tile the stack) and the card's face is a
 * child that takes no clicks: a click lands on the card it is aimed at, whether by a person or by a test that
 * clicks the middle of a card.
 *
 * Changing the chosen card is animated (walletDeckMotion.ts): the new card swings up, the old one tucks back, a
 * sheen crosses the new one and its ghost peeks in. With reduced motion the deck changes at once.
 */
/** How far the chosen card rises: less than a card's bottom padding, so no text of the card behind shows under it. */
const LIFT=9;

const reducedMotion=()=>typeof window!=='undefined'&&(document.documentElement.dataset.reduceMotion==='true'||window.matchMedia('(prefers-reduced-motion: reduce)').matches);
/** A mouse or trackpad that can hover: the stack. A finger: the track. */
const FINE='(hover: hover) and (pointer: fine)';
function useFinePointer() {
 const [fine,setFine]=useState(()=>typeof window==='undefined'||window.matchMedia(FINE).matches);
 useEffect(()=>{const query=window.matchMedia(FINE),change=()=>setFine(query.matches);query.addEventListener('change',change);return ()=>query.removeEventListener('change',change);},[]);
 return fine;
}

/** A card's face: the same on the wallet page, in the chat and on the front of the chat's flipping card. */
export function WalletCardFace({card,after}:{card:WalletCard;after?:boolean}) {
 return <span className="wallet-deck-face" data-after={after||undefined}>
  <span className="wallet-deck-card-glyph" aria-hidden="true"><WalletMark rail={card.id}/></span>
  <span className="wallet-deck-card-status">{card.status}</span>
  {/* A card after the chosen one shows only its trailing edge: its mark is there too. */}
  <span className="wallet-deck-card-glyph-end" aria-hidden="true"><WalletMark rail={card.id}/></span>
  <span className="wallet-deck-card-ghost" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/><circle cx="9" cy="9" r="1.5" fill="var(--ghost-eye)"/><circle cx="15" cy="9" r="1.5" fill="var(--ghost-eye)"/></svg></span>
  <span className="wallet-deck-card-text"><span className="wallet-deck-card-name">{card.name}</span><span className="wallet-deck-card-balance">{card.balance}</span><span className="wallet-deck-card-detail">{card.detail}</span></span>
  <span className="wallet-deck-card-chip" aria-hidden="true"/>
  <span className="wallet-deck-card-sheen" aria-hidden="true"/>
 </span>;
}

export interface CardDeckProps {
 cards:WalletCard[];
 selected:WalletRail;
 /** A card came up: by the pointer passing over it, a swipe, the arrows or a key. */
 onSelect:(rail:WalletRail)=>void;
 /** A card was clicked (or Enter on it). Without this, a click only selects. */
 onChoose?:(rail:WalletRail)=>void;
 /** The wallet page's cards are tabs over a panel; the chat's are a choice of how to pay. */
 kind:'tabs'|'radios';
 label:string;
 testId:(rail:WalletRail)=>string;
 /** Why a card cannot be used here: it still comes up, to say so, but is not chosen. */
 blocked?:(card:WalletCard)=>string|undefined;
 /** Largest card and its share of the deck's width. */
 size?:{max:number;share:number};
 /** How long the pointer rests on a card before it comes up, so a pass across the deck does not flip every card. */
 hoverDelay?:number;
 /** The deck's own name for its arrows' test ids. */
 name:string;
 compact?:boolean;
}

export function CardDeck({cards,selected,onSelect,onChoose,kind,label,testId,blocked,size,hoverDelay=0,name,compact}:CardDeckProps) {
 const active=Math.max(0,cards.findIndex(card=>card.id===selected));
 const root=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null),tabs=useRef<(HTMLButtonElement|null)[]>([]);
 const latest=useRef({onSelect,ids:cards.map(card=>card.id),selected});
 latest.current={onSelect,ids:cards.map(card=>card.id),selected};
 const [width,setWidth]=useState(0);
 const fine=useFinePointer();
 const mode=fine?'stack':'track';
 const layout=useMemo(()=>stackLayout(width,cards.length,size&&{max:size.max,share:size.share}),[width,cards.length,size?.max,size?.share]); // eslint-disable-line react-hooks/exhaustive-deps
 const strips=useMemo(()=>stackStrips(layout,active),[layout,active]);
 const cardWidth=mode==='track'?Math.round(width*.76):layout.width,cardHeight=Math.round(cardWidth/1.586);
 const trackHeight=cardHeight+LIFT+14;

 // Each change of the chosen card, and where it came from: known while rendering, so the change and its animation
 // start in the same frame. A deck whose cards change but whose choice does not (the chat's list) plays nothing.
 const chosen=cards[active]?.id;
 const [shown,setShown]=useState({id:chosen,from:undefined as WalletRail|undefined,n:0});
 if(shown.id!==chosen)setShown({id:chosen,from:shown.id,n:shown.n+1});
 const glow=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  if(!shown.n||reducedMotion())return;
  const ids=cards.map(card=>card.id),to=ids.indexOf(shown.id!),from=shown.from?ids.indexOf(shown.from):-1;
  playSwitch({glow:glow.current,incoming:tabs.current[to],outgoing:from<0?null:tabs.current[from],dir:switchDirection(from,to)});
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[shown.n]);

 // The deck sizes itself from the space it gets, not from the window (components/layout/README.md).
 useLayoutEffect(()=>{
  const el=root.current;if(!el)return;
  const measure=()=>setWidth(el.getBoundingClientRect().width);
  measure();
  const observer=new ResizeObserver(measure);observer.observe(el);
  return ()=>observer.disconnect();
 },[]);

 /** Only the track scrolls: the stack is absolutely placed and there is nothing to bring into view. */
 const centre=useCallback((i:number,smooth:boolean)=>{
  const el=track.current,tab=tabs.current[i];
  if(!el||!tab||el.scrollWidth<=el.clientWidth+1)return;
  el.scrollTo({left:tab.offsetLeft-(el.clientWidth-tab.offsetWidth)/2,behavior:smooth&&!reducedMotion()?'smooth':'auto'});
 },[]);
 const select=(i:number)=>{const id=cards[i]?.id;if(!id)return;if(id!==selected)onSelect(id);centre(i,true);};
 const choose=(i:number)=>{const card=cards[i];if(!card)return;select(i);if(onChoose&&!blocked?.(card))onChoose(card.id);};
 // The remembered card starts centred; a deck that turns into a track brings it to the centre too.
 useLayoutEffect(()=>{if(width>0)centre(active,false);},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [mode,width>0]);

 // Track: whichever card rests nearest the centre after a scroll is the chosen one.
 useEffect(()=>{
  const el=track.current;if(!el||mode!=='track')return;
  const pick=()=>{
   if(el.scrollWidth<=el.clientWidth+1)return;
   const mid=el.getBoundingClientRect().left+el.clientWidth/2;
   let best=-1,bestDistance=Infinity;
   tabs.current.forEach((tab,i)=>{if(!tab)return;const r=tab.getBoundingClientRect();const d=Math.abs(r.left+r.width/2-mid);if(d<bestDistance){bestDistance=d;best=i;}});
   const id=latest.current.ids[best];
   if(id&&id!==latest.current.selected)latest.current.onSelect(id);
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const debounced=()=>{clearTimeout(timer);timer=setTimeout(pick,120);};
  const scrollEnd='onscrollend' in window;
  if(scrollEnd)el.addEventListener('scrollend',pick);else el.addEventListener('scroll',debounced,{passive:true});
  return ()=>{clearTimeout(timer);el.removeEventListener('scrollend',pick);el.removeEventListener('scroll',debounced);};
 },[mode]);

 // Stack: the card under a resting pointer comes up. Only a pointer that moved counts, never a card moving under a
 // still one, and the strips it reads are the ones on screen now.
 const hover=useRef<{x:number;y:number;timer?:ReturnType<typeof setTimeout>}>({x:NaN,y:NaN});
 useEffect(()=>()=>clearTimeout(hover.current.timer),[]);
 const onPointerMove=(e:PointerEvent<HTMLDivElement>)=>{
  const h=hover.current;
  if(mode!=='stack'||e.pointerType!=='mouse'||(e.clientX===h.x&&e.clientY===h.y))return;
  h.x=e.clientX;h.y=e.clientY;
  clearTimeout(h.timer);
  const i=stripAt(strips,e.clientX-(track.current?.getBoundingClientRect().left??0));
  if(i<0||i===active)return;
  const id=cards[i].id,go=()=>{if(latest.current.selected!==id)latest.current.onSelect(id);};
  if(hoverDelay>0)h.timer=setTimeout(go,hoverDelay);else go();
 };
 const onPointerLeave=()=>{clearTimeout(hover.current.timer);hover.current.x=hover.current.y=NaN;};

 // The chosen card's panel may focus a field as it mounts (Cashu's amount): after an arrow key, the card keeps the focus.
 const focusAfter=useRef<number|null>(null);
 useEffect(()=>{if(focusAfter.current!==null){tabs.current[focusAfter.current]?.focus({preventScroll:true});focusAfter.current=null;}});
 const onKey=(e:KeyboardEvent)=>{
  const n=cards.length;let next:number;
  if(e.key==='ArrowRight'||e.key==='ArrowDown')next=stepCard(active,1,n);
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp')next=stepCard(active,-1,n);
  else if(e.key==='Home')next=0;
  else if(e.key==='End')next=n-1;
  else return;
  e.preventDefault();
  focusAfter.current=next;
  select(next);
  tabs.current[next]?.focus({preventScroll:true});
 };

 const top=LIFT+4;
 // The deck wears the chosen card's colour class: its glow and the arrows' marks take that card's ink.
 return <div ref={root} className={`wallet-deck wallet-card-${cards[active].id}${compact?' wallet-deck-compact':''}`} data-mode={mode} style={{'--deck-w':`${width}px`,'--card-w':`${cardWidth}px`,'--card-h':`${cardHeight}px`,'--track-h':`${trackHeight}px`} as CSSProperties}>
  <div ref={glow} className="wallet-deck-glow" aria-hidden="true"/>
  <div ref={track} className="wallet-deck-track" role={kind==='tabs'?'tablist':'radiogroup'} aria-label={label} onKeyDown={onKey} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
   {cards.map((card,i)=>{
    const offset=i-active,distance=Math.abs(offset),why=blocked?.(card),on=i===active;
    // The button is the strip of the card that shows; the face is the whole card, placed from the button.
    const strip=strips[i]??{left:0,right:cardWidth},left=layout.lefts[i]??0;
    const place={'--bl':`${Math.round(strip.left)}px`,'--bw':`${Math.max(6,Math.round(strip.right-strip.left))}px`,'--fl':`${Math.round(left)-Math.round(strip.left)}px`,'--ft':`${top}px`,
     '--y':`${on?-LIFT:0}px`,'--s':on?1:Math.max(.9,1-.025*distance),'--b':on?1:Math.max(.45,.92-.13*distance),'--origin':offset<0?'left center':offset>0?'right center':'center',zIndex:20-distance} as CSSProperties;
    const semantics=kind==='tabs'?{role:'tab',id:`wallet-tab-${card.id}`,'aria-selected':on,'aria-controls':'wallet-panel'}:{role:'radio','aria-checked':on};
    return <button key={card.id} ref={el=>{tabs.current[i]=el;}} type="button" {...semantics} tabIndex={on?0:-1} aria-disabled={why?true:undefined} title={why}
     className={`wallet-deck-card wallet-card-${card.id}`} data-active={on} data-blocked={why?true:undefined} data-testid={testId(card.id)} style={place} onClick={()=>choose(i)}>
     <WalletCardFace card={card} after={offset>0}/>
    </button>;
   })}
  </div>
  <div className="wallet-deck-nav">
   <button type="button" className="wallet-deck-arrow" aria-label="Previous card" data-testid={`${name}-prev`} onClick={()=>select(stepCard(active,-1,cards.length))}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
   </button>
   <div className="wallet-deck-marks" aria-hidden="true" style={{'--mark-i':active} as CSSProperties}>{cards.map((card,i)=><span key={card.id} className={`wallet-card-${card.id}`} data-on={i===active}><WalletMark rail={card.id}/></span>)}</div>
   <button type="button" className="wallet-deck-arrow" aria-label="Next card" data-testid={`${name}-next`} onClick={()=>select(stepCard(active,1,cards.length))}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
   </button>
  </div>
 </div>;
}

/** The wallet page's deck: tabs over the chosen card's panel. */
export function WalletDeck({state,selected,onSelect,testMints}:{state:WalletState;selected:WalletRail;onSelect:(rail:WalletRail)=>void;testMints:readonly string[]}) {
 return <CardDeck cards={walletCards(state,testMints)} selected={selected} onSelect={onSelect} kind="tabs" label="Wallet integrations" name="wallet-deck"
  testId={rail=>`wallet-card-${rail}`} hoverDelay={90}/>;
}
