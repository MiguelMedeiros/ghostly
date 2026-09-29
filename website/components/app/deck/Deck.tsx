// Copied from src/components/deck/Deck.tsx by website/scripts/sync-app-deck.mjs. Edit the app's file, then run npm run sync:app-deck.
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type KeyboardEvent,type PointerEvent,type ReactNode} from 'react';
import {stackLayout,stackStrips,stepCard,stripAt} from './stack';
import {deckSwitchSound,playSwitch,switchDirection} from './motion';
import './deck.css';

/**
 * Cards as a stack, the way they sit in a wallet: the wallet's payment methods (WalletDeck.tsx), the person's
 * identities (identities/IdentityProofsSection.tsx) and the ways of paying a chat accepts (ChatPaymentAccept.tsx). With a mouse they overlap in a row and flip up as the pointer
 * passes over them: every card keeps its place (stack.ts), so the one that comes up is the one under the pointer. On
 * a touch screen they are a horizontal snapping track instead, and the card that comes to rest in the centre is the
 * chosen one. Either way the arrows under the deck, the arrow keys, Home and End move along it.
 *
 * Each card's button is only the strip of it that shows (the strips tile the stack) and the card's face is a
 * child that takes no clicks: a click lands on the card it is aimed at, whether by a person or by a test that
 * clicks the middle of a card.
 *
 * Changing the chosen card is animated (motion.ts): the new card swings up, the old one tucks back, a sheen crosses
 * the new one and its ghost peeks in. With reduced motion the deck changes at once.
 *
 * The deck owns the mechanics; each kind of deck brings its face (whose root is marked `data-deck="face"`), the
 * mark shown for each card under the deck, and a colour class per card that sets `--card-rgb` (the glow, the arrows,
 * the lit mark).
 */
/** How far the chosen card rises: less than a card's bottom padding, so no text of the card behind shows under it. */
const LIFT=9;
/** How far a card that is on sits raised in a deck of checks: less than the chosen card's lift, so that one still shows it is chosen. */
const RAISE=5;
/**
 * The narrowest a card of the stack may be. Under it (a page squeezed by the chat list, a phone-wide column with a
 * mouse) the deck is the snapping track instead, one card whole in the centre: cards shrunk to fit a stack are
 * cards nobody can read.
 */
export const STACK_MIN_CARD=210;
/** The width each deck (by name) last had: a deck opened again starts at it instead of measuring itself first. */
const lastWidth=new Map<string,number>();

const reducedMotion=()=>typeof window!=='undefined'&&(document.documentElement.dataset.reduceMotion==='true'||window.matchMedia('(prefers-reduced-motion: reduce)').matches);
/** A mouse or trackpad that can hover: the stack. A finger: the track. */
const FINE='(hover: hover) and (pointer: fine)';
function useFinePointer() {
 const [fine,setFine]=useState(()=>typeof window==='undefined'||window.matchMedia(FINE).matches);
 useEffect(()=>{const query=window.matchMedia(FINE),change=()=>setFine(query.matches);query.addEventListener('change',change);return ()=>query.removeEventListener('change',change);},[]);
 return fine;
}

export interface DeckCard {id:string}

export interface DeckProps<C extends DeckCard> {
 cards:C[];
 selected:string;
 /** A card came up: by the pointer passing over it, a swipe, the arrows or a key. */
 onSelect:(id:string)=>void;
 /** A card was clicked (or Enter on it). Without this, a click only selects. In a deck of checks, it turns the card on or off. */
 onChoose?:(id:string)=>void;
 /**
  * Tabs over a panel (`panel` names it and each tab's id), a choice of one among the cards (radios), or any number
  * of them turned on (checks: each card is a switch, `checked` says which are on, and those sit a little raised).
  */
 kind:'tabs'|'radios'|'checks';
 checked?:(card:C)=>boolean;
 /** A card's accessible name, when its face does not say what choosing it does (a switch: "Accept Cashu (Testnet) from Alice"). */
 cardLabel?:(card:C)=>string;
 panel?:{id:string;tabId:(id:string)=>string};
 label:string;
 testId:(card:C)=>string;
 /** The card itself: its root marked `data-deck="face"`, and `"sheen"`/`"ghost"` the parts the switch moves. */
 face:(card:C,place:{active:boolean;after:boolean;checked?:boolean})=>ReactNode;
 /** The card's small mark in the row under the deck. */
 mark:(card:C)=>ReactNode;
 /** The class that gives a card its colour (`--card-rgb`): worn by the card, and by the deck for the chosen one. */
 tone:(card:C)=>string;
 /** Why a card cannot be used here: it still comes up, to say so, but is not chosen. */
 blocked?:(card:C)=>string|undefined;
 /** Largest card and its share of the deck's width. */
 size?:{max:number;share:number};
 /** The deck's own name: its arrows' test ids (`<name>-prev`/`-next`). */
 name:string;
 /** The kind of deck, as a class on the deck and, suffixed, on its parts (`wallet-deck`, `wallet-deck-track`…). */
 className:string;
 compact?:boolean;
}

export function Deck<C extends DeckCard>({cards,selected,onSelect,onChoose,kind,checked,cardLabel,panel,label,testId,face,mark,tone,blocked,size,name,className,compact}:DeckProps<C>) {
 const part=(p:string)=>`deck-${p} ${className}-${p}`;
 const active=Math.max(0,cards.findIndex(card=>card.id===selected));
 const root=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null),tabs=useRef<(HTMLButtonElement|null)[]>([]);
 const [width,setWidth]=useState(()=>lastWidth.get(name)??0);
 const fine=useFinePointer();
 const layout=useMemo(()=>stackLayout(width,cards.length,size&&{max:size.max,share:size.share}),[width,cards.length,size?.max,size?.share]); // eslint-disable-line react-hooks/exhaustive-deps
 // A mouse gets the stack while its cards stay readable (not yet measured: as it was last time, or a stack).
 const mode=fine&&(width===0||layout.width>=STACK_MIN_CARD)?'stack':'track';
 const latest=useRef({onSelect,ids:cards.map(card=>card.id),selected,mode});
 latest.current={onSelect,ids:cards.map(card=>card.id),selected,mode};
 const strips=useMemo(()=>stackStrips(layout,active),[layout,active]);
 const cardWidth=mode==='track'?Math.round(width*.76):layout.width,cardHeight=Math.round(cardWidth/1.586);
 const trackHeight=cardHeight+LIFT+14;

 // Each change of the chosen card, and where it came from: known while rendering, so the change and its animation
 // start in the same frame. A deck whose cards change but whose choice does not (the chat's list) plays nothing.
 const chosen=cards[active]?.id;
 const [shown,setShown]=useState({id:chosen,from:undefined as string|undefined,n:0});
 if(shown.id!==chosen)setShown({id:chosen,from:shown.id,n:shown.n+1});
 const glow=useRef<HTMLDivElement>(null);
 /** The card the deck itself last chose (a key, a click, a swipe, the pointer): any other change came from outside. */
 const own=useRef(chosen);
 useLayoutEffect(()=>{
  // The person moved to another card: a quiet slide (Interface sounds), with or without the motion.
  if(shown.n&&own.current===shown.id)deckSwitchSound();
  if(!shown.n||reducedMotion())return;
  const ids=cards.map(card=>card.id),to=ids.indexOf(shown.id!),from=shown.from?ids.indexOf(shown.from):-1;
  playSwitch({glow:glow.current,incoming:tabs.current[to],outgoing:from<0?null:tabs.current[from],dir:switchDirection(from,to)});
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[shown.n]);

 // The deck sizes itself from the space it gets, not from the window (components/layout/README.md). Only the first
 // deck of its name measures itself as it mounts: a forced layout of the whole page just built, and a second render
 // before the first paint. A deck opened again starts at the width that deck last had, which is right unless the
 // column changed meanwhile, and the observer corrects it then. (Not synchronously: a re-layout inside the observer's
 // own delivery is the "ResizeObserver loop" error.)
 useLayoutEffect(()=>{
  const el=root.current;if(!el)return;
  const measure=()=>{const next=el.getBoundingClientRect().width;lastWidth.set(name,next);setWidth(next);};
  if(!lastWidth.has(name))measure();
  const observer=new ResizeObserver(measure);observer.observe(el);
  return ()=>observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);

 /** Only the track scrolls: the stack is absolutely placed, nothing to bring into view (and no layout to read for it). Says whether it moves. */
 const centre=useCallback((i:number,smooth:boolean)=>{
  const el=track.current,tab=tabs.current[i];
  if(!el||!tab||latest.current.mode!=='track'||el.scrollWidth<=el.clientWidth+1)return false;
  const left=Math.max(0,Math.min(el.scrollWidth-el.clientWidth,tab.offsetLeft-(el.clientWidth-tab.offsetWidth)/2));
  const moves=Math.abs(el.scrollLeft-left)>=1;
  el.scrollTo({left,behavior:smooth&&!reducedMotion()?'smooth':'auto'});
  return moves;
 },[]);
 /**
  * Where the track is being taken, for a moment, and by whom. A card chosen from outside the deck (a proof just added,
  * a panel's link to another card): a card added before the one at rest makes the browser snap back to that one, which
  * is not the person choosing it, so the track is sent there again. A card the deck chose itself (an arrow, a key, a
  * tap): the end of an earlier scroll, cut off by a quick second key, chooses nothing. Touching the track ends it.
  */
 const steer=useRef<{id:string;until:number;resnap:boolean}|null>(null);
 const select=(i:number)=>{
  const id=cards[i]?.id;if(!id)return;own.current=id;if(id!==selected)onSelect(id);
  // Already at rest there: no scroll, so no end to wait for.
  steer.current=centre(i,true)?{id,until:performance.now()+1000,resnap:false}:null;
 };
 const choose=(i:number)=>{const card=cards[i];if(!card)return;select(i);if(onChoose&&!blocked?.(card))onChoose(card.id);};
 // The remembered card starts centred; a deck that turns into a track brings it to the centre too.
 useLayoutEffect(()=>{if(width>0)centre(active,false);},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [mode,width>0]);
 // A card chosen from outside the deck comes to the centre too, and the track is steered there (`steer`).
 useLayoutEffect(()=>{
  if(!chosen||own.current===chosen)return;
  own.current=chosen;
  steer.current={id:chosen,until:performance.now()+1000,resnap:true};
  centre(active,true);
 },[chosen,active,centre]);

 // Track: whichever card rests nearest the centre after a scroll is the chosen one.
 useEffect(()=>{
  const el=track.current;if(!el||mode!=='track')return;
  const pick=()=>{
   if(el.scrollWidth<=el.clientWidth+1)return;
   const mid=el.getBoundingClientRect().left+el.clientWidth/2;
   let best=-1,bestDistance=Infinity;
   tabs.current.forEach((tab,i)=>{if(!tab)return;const r=tab.getBoundingClientRect();const d=Math.abs(r.left+r.width/2-mid);if(d<bestDistance){bestDistance=d;best=i;}});
   const steering=steer.current;
   if(steering&&performance.now()<steering.until){
    const want=latest.current.ids.indexOf(steering.id);
    if(want>=0&&best!==want){if(steering.resnap)centre(want,true);return;}
   }
   steer.current=null;
   const id=latest.current.ids[best];
   if(id&&id!==latest.current.selected){own.current=id;latest.current.onSelect(id);}
  };
  const touched=()=>{steer.current=null;};
  let timer:ReturnType<typeof setTimeout>|undefined;
  const debounced=()=>{clearTimeout(timer);timer=setTimeout(pick,120);};
  const scrollEnd='onscrollend' in window;
  if(scrollEnd)el.addEventListener('scrollend',pick);else el.addEventListener('scroll',debounced,{passive:true});
  for(const type of ['pointerdown','touchstart','wheel'])el.addEventListener(type,touched,{passive:true});
  return ()=>{clearTimeout(timer);el.removeEventListener('scrollend',pick);el.removeEventListener('scroll',debounced);for(const type of ['pointerdown','touchstart','wheel'])el.removeEventListener(type,touched);};
 },[mode,centre]);

 // Stack: the card under the pointer comes up at once, on every deck alike (the page's and the chat's): the lift's
 // own spring is the only easing. Only a pointer that moved counts, never a card moving under a still one, and the
 // strips it reads are the ones on screen now.
 const hover=useRef({x:NaN,y:NaN});
 const onPointerMove=(e:PointerEvent<HTMLDivElement>)=>{
  const h=hover.current;
  if(mode!=='stack'||e.pointerType!=='mouse'||(e.clientX===h.x&&e.clientY===h.y))return;
  h.x=e.clientX;h.y=e.clientY;
  const i=stripAt(strips,e.clientX-(track.current?.getBoundingClientRect().left??0));
  if(i<0||i===active)return;
  const id=cards[i].id;
  if(latest.current.selected!==id){own.current=id;latest.current.onSelect(id);}
 };
 const onPointerLeave=()=>{hover.current.x=hover.current.y=NaN;};

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
 const current=cards[active];
 // The deck wears the chosen card's colour class: its glow and the arrows' marks take that card's ink.
 // Left to right in every language: the stack, its arrows and its marks are placed and moved in physical pixels.
 return <div ref={root} dir="ltr" className={`deck ${className}${current?` ${tone(current)}`:''}${compact?` deck-compact ${className}-compact`:''}`} data-mode={mode} style={{'--deck-w':`${width}px`,'--card-w':`${cardWidth}px`,'--card-h':`${cardHeight}px`,'--track-h':`${trackHeight}px`} as CSSProperties}>
  <div ref={glow} className={part('glow')} aria-hidden="true"/>
  <div ref={track} className={part('track')} role={kind==='tabs'?'tablist':kind==='checks'?'group':'radiogroup'} aria-label={label} onKeyDown={onKey} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
   {cards.map((card,i)=>{
    const offset=i-active,distance=Math.abs(offset),why=blocked?.(card),on=i===active,ticked=kind==='checks'?!!checked?.(card):undefined;
    // The button is the strip of the card that shows; the face is the whole card, placed from the button.
    const strip=strips[i]??{left:0,right:cardWidth},left=layout.lefts[i]??0;
    const place={'--bl':`${Math.round(strip.left)}px`,'--bw':`${Math.max(6,Math.round(strip.right-strip.left))}px`,'--fl':`${Math.round(left)-Math.round(strip.left)}px`,'--ft':`${top}px`,
     '--y':`${on?-LIFT:ticked?-RAISE:0}px`,'--s':on?1:Math.max(.9,1-.025*distance),'--dim':on?0:1-Math.max(.45,.92-.13*distance),'--origin':offset<0?'left center':offset>0?'right center':'center',zIndex:20-distance} as CSSProperties;
    const semantics=kind==='tabs'?{role:'tab',id:panel?.tabId(card.id),'aria-selected':on,'aria-controls':panel?.id}:kind==='checks'?{role:'switch','aria-checked':ticked}:{role:'radio','aria-checked':on};
    return <button key={card.id} ref={el=>{tabs.current[i]=el;}} type="button" {...semantics} aria-label={cardLabel?.(card)} tabIndex={on?0:-1} aria-disabled={why?true:undefined} title={why}
     className={`${part('card')} ${tone(card)}`} data-active={on} data-checked={ticked} data-blocked={why?true:undefined} data-testid={testId(card)} style={place} onClick={()=>choose(i)}>
     {face(card,{active:on,after:offset>0,checked:ticked})}
    </button>;
   })}
  </div>
  {cards.length>1&&<div className={part('nav')}>
   <button type="button" className={part('arrow')} aria-label="Previous card" data-testid={`${name}-prev`} onClick={()=>select(stepCard(active,-1,cards.length))}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
   </button>
   <div className={part('marks')} aria-hidden="true" style={{'--mark-i':active} as CSSProperties}>{cards.map((card,i)=><span key={card.id} className={tone(card)} data-on={i===active} data-checked={kind==='checks'?!!checked?.(card):undefined}>{mark(card)}</span>)}</div>
   <button type="button" className={part('arrow')} aria-label="Next card" data-testid={`${name}-next`} onClick={()=>select(stepCard(active,1,cards.length))}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
   </button>
  </div>}
 </div>;
}
