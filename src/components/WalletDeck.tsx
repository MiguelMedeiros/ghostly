import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type KeyboardEvent,type MouseEvent,type PointerEvent} from 'react';
import type {WalletState} from '../lib/platform';
import {walletCards,type WalletRail} from './walletCardData';
import {WalletMark} from './WalletCards';
import './wallet-deck.css';

/**
 * The wallets as a deck of cards. In a wide column the cards fan out in place, the chosen one lifted and lit
 * in its own colour; in a narrow one (a phone, or a desktop column squeezed by a wide chat list) they are a
 * horizontal snapping track, and the card that comes to rest nearest the centre is the chosen one. The column's
 * width decides, never the window's. Arrow keys, Home and End move along the deck; the panel below follows.
 */
const TRACK_BELOW=600;
/** How a card looks at each distance from the chosen one: its scale, its tilt, how far it drops and dims. */
const FAN=[{s:1,tilt:0,y:-20,b:1},{s:.92,tilt:22,y:6,b:.86},{s:.84,tilt:45,y:12,b:.74},{s:.76,tilt:55,y:18,b:.62},{s:.68,tilt:60,y:24,b:.52},{s:.6,tilt:62,y:30,b:.45}];
const look=(distance:number)=>FAN[Math.min(distance,FAN.length-1)];
const PERSPECTIVE=1600,GAP=4;

/** Where a tilted card's outer edge lands on screen: the perspective brings it nearer, so further out. */
function projectedEdge(x:number,distance:number,width:number,side:1|-1) {
 const at=look(distance),half=width*at.s/2,rad=at.tilt*Math.PI/180;
 return (x+side*half*Math.cos(rad))*PERSPECTIVE/(PERSPECTIVE-half*Math.sin(rad));
}

/**
 * The cards' centres when `active` is the chosen one. Every card's centre stays clear of the cards over it, so a
 * click lands on the card it is aimed at: each card starts just past the previous one's outer edge. The whole fan
 * is centred in the deck, whichever card is chosen.
 */
function fanPositions(width:number,cards:number,active:number) {
 let shift=0,xs:number[]=[],left=0,right=0;
 for(let round=0;round<4;round++){
  xs=new Array<number>(cards).fill(0);xs[active]=shift;
  let outer=shift+width/2;
  for(let i=active+1;i<cards;i++){const x=outer+GAP;xs[i]=x;outer=projectedEdge(x,i-active,width,1);}
  right=outer;outer=shift-width/2;
  for(let i=active-1;i>=0;i--){const x=outer-GAP;xs[i]=x;outer=projectedEdge(x,active-i,width,-1);}
  left=outer;shift=-(right+left)/2;
 }
 return {xs,extent:right-left};
}

/** The card size for a deck this wide (the cards shrink until the widest fan fits the column), and every fan. */
function fanGeometry(deckWidth:number,cards:number) {
 const room=deckWidth-16;
 let width=Math.min(340,deckWidth/2);
 for(let round=0;round<8&&cards;round++){
  const worst=Math.max(...Array.from({length:cards},(_,active)=>fanPositions(width,cards,active).extent));
  if(worst<=room)break;
  width*=room/worst;
 }
 width=Math.round(width);
 return {width,xs:Array.from({length:cards},(_,active)=>fanPositions(width,cards,active).xs.map(Math.round))};
}

const reducedMotion=()=>typeof window!=='undefined'&&(document.documentElement.dataset.reduceMotion==='true'||window.matchMedia('(prefers-reduced-motion: reduce)').matches);

export function WalletDeck({state,selected,onSelect,testMints}:{state:WalletState;selected:WalletRail;onSelect:(rail:WalletRail)=>void;testMints:readonly string[]}) {
 const cards=walletCards(state,testMints);
 const active=Math.max(0,cards.findIndex(card=>card.id===selected));
 const root=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null),tabs=useRef<(HTMLButtonElement|null)[]>([]);
 const latest=useRef({onSelect,ids:cards.map(card=>card.id),selected});
 latest.current={onSelect,ids:cards.map(card=>card.id),selected};
 const [width,setWidth]=useState(0);
 const mode=width<TRACK_BELOW?'track':'fan';
 const geometry=useMemo(()=>fanGeometry(width,cards.length),[width,cards.length]);
 const cardWidth=mode==='track'?Math.round(width*.76):geometry.width;

 // The deck sizes itself from the space it gets, not from the window (components/layout/README.md).
 useLayoutEffect(()=>{
  const el=root.current;if(!el)return;
  const measure=()=>setWidth(el.getBoundingClientRect().width);
  measure();
  const observer=new ResizeObserver(measure);observer.observe(el);
  return ()=>observer.disconnect();
 },[]);

 /** Only the track scrolls: the fan is absolutely placed and there is nothing to bring into view. */
 const centre=useCallback((i:number,smooth:boolean)=>{
  const el=track.current,tab=tabs.current[i];
  if(!el||!tab||el.scrollWidth<=el.clientWidth+1)return;
  el.scrollTo({left:tab.offsetLeft-(el.clientWidth-tab.offsetWidth)/2,behavior:smooth&&!reducedMotion()?'smooth':'auto'});
 },[]);
 const choose=(i:number)=>{const id=cards[i]?.id;if(!id)return;if(id!==selected)onSelect(id);centre(i,true);};
 // The remembered card starts centred; a column that turns into a track brings it to the centre too.
 useLayoutEffect(()=>{if(width>0)centre(active,false);},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [mode,width>0]);

 // Track: whichever card rests nearest the centre after a scroll is the chosen one.
 useEffect(()=>{
  const el=track.current;if(!el)return;
  const pick=()=>{
   if(el.scrollWidth<=el.clientWidth+1||el.dataset.dragging)return;
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
 },[]);

 // The chosen card's panel may focus a field as it mounts (Cashu's amount): after an arrow key, the card keeps the focus.
 const focusAfter=useRef<number|null>(null);
 useEffect(()=>{if(focusAfter.current!==null){tabs.current[focusAfter.current]?.focus({preventScroll:true});focusAfter.current=null;}});
 const onKey=(e:KeyboardEvent)=>{
  const n=cards.length;let next:number;
  if(e.key==='ArrowRight'||e.key==='ArrowDown')next=(active+1)%n;
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp')next=(active-1+n)%n;
  else if(e.key==='Home')next=0;
  else if(e.key==='End')next=n-1;
  else return;
  e.preventDefault();
  focusAfter.current=next;
  choose(next);
  tabs.current[next]?.focus({preventScroll:true});
 };

 // A mouse drags the track (a finger scrolls it natively): the snap is off while dragging, and a flick moves one card on.
 const drag=useRef<{x:number;left:number;from:number;moved:boolean;lastX:number;lastT:number;velocity:number;pointer:number}|null>(null);
 const snapTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const onPointerDown=(e:PointerEvent<HTMLDivElement>)=>{
  const el=track.current;
  if(e.pointerType!=='mouse'||e.button!==0||!el||el.scrollWidth<=el.clientWidth+1)return;
  drag.current={x:e.clientX,left:el.scrollLeft,from:active,moved:false,lastX:e.clientX,lastT:performance.now(),velocity:0,pointer:e.pointerId};
 };
 const onPointerMove=(e:PointerEvent<HTMLDivElement>)=>{
  const d=drag.current,el=track.current;if(!d||!el)return;
  const dx=e.clientX-d.x;
  if(!d.moved){if(Math.abs(dx)<5)return;d.moved=true;el.setPointerCapture(d.pointer);el.dataset.dragging='true';clearTimeout(snapTimer.current);}
  const now=performance.now();
  if(now>d.lastT)d.velocity=(e.clientX-d.lastX)/(now-d.lastT);
  d.lastX=e.clientX;d.lastT=now;
  el.scrollLeft=d.left-dx;
 };
 const onPointerUp=()=>{
  const d=drag.current,el=track.current;drag.current=null;if(!d||!el||!d.moved)return;
  el.releasePointerCapture(d.pointer);
  const mid=el.getBoundingClientRect().left+el.clientWidth/2;
  let nearest=active,bestDistance=Infinity;
  tabs.current.forEach((tab,i)=>{if(!tab)return;const r=tab.getBoundingClientRect();const dist=Math.abs(r.left+r.width/2-mid);if(dist<bestDistance){bestDistance=dist;nearest=i;}});
  // Momentum: a quick flick goes one card on from where the drag began; a slow drag settles on the nearest.
  const flick=Math.abs(d.velocity)>.45?(d.velocity<0?1:-1):0;
  const target=Math.min(cards.length-1,Math.max(0,flick?d.from+flick:nearest));
  choose(target);
  snapTimer.current=setTimeout(()=>{delete el.dataset.dragging;},450);
 };
 const onClickCapture=(e:MouseEvent)=>{if(track.current?.dataset.dragging){e.preventDefault();e.stopPropagation();}};

 // The deck wears the chosen card's colour class: its glow and dots take that card's ink.
 return <div ref={root} className={`wallet-deck wallet-card-${cards[active].id}`} data-mode={mode} style={{'--deck-w':`${width}px`,'--card-w':`${cardWidth}px`,'--card-h':`${Math.round(cardWidth/1.586)}px`} as CSSProperties}>
  <div className="wallet-deck-glow" aria-hidden="true"/>
  <div ref={track} className="wallet-deck-track" role="tablist" aria-label="Wallet integrations" onKeyDown={onKey}
   onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onClickCapture={onClickCapture}>
   {cards.map((card,i)=>{
    const offset=i-active,abs=Math.abs(offset),sign=Math.sign(offset);
    const at=look(abs);
    const place={'--x':`${geometry.xs[active]?.[i]??0}px`,'--y':`${at.y}px`,'--ry':`${-sign*at.tilt}deg`,'--s':at.s,'--b':at.b,zIndex:10-abs} as CSSProperties;
    return <button key={card.id} ref={el=>{tabs.current[i]=el;}} type="button" role="tab" id={`wallet-tab-${card.id}`} aria-selected={i===active} aria-controls="wallet-panel" tabIndex={i===active?0:-1}
     className={`wallet-deck-card wallet-card-${card.id}`} data-active={i===active} data-testid={`wallet-card-${card.id}`} style={place} onClick={()=>choose(i)}>
     {/* Name at one end, mark at the other: a card half under its neighbour still says which it is. */}
     <span className="wallet-deck-card-top"><span className="wallet-deck-card-name">{card.name}</span><span className="wallet-deck-card-glyph" aria-hidden="true"><WalletMark rail={card.id}/></span></span>
     <span className="wallet-deck-card-balance">{card.balance}</span>
     <span className="wallet-deck-card-foot"><span className="wallet-deck-card-detail">{card.detail}</span><span className="wallet-deck-card-status">{card.status}</span></span>
    </button>;
   })}
  </div>
  <div className="wallet-deck-dots" aria-hidden="true">{cards.map((card,i)=><span key={card.id} data-on={i===active}/>)}</div>
 </div>;
}
