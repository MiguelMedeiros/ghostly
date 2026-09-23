import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type KeyboardEvent,type MouseEvent,type PointerEvent} from 'react';
import type {WalletState} from '../lib/platform';
import {walletCards,type WalletRail} from './walletCardData';
import {WalletMark} from './WalletCards';
import './wallet-deck.css';

/**
 * The wallets as a deck of cards, the one the website shows. In a wide column the cards fan out in place: the
 * chosen one lifted, upright and lit in its own colour, the others stacked tightly behind it, turned and dimmed
 * by their distance. In a narrow column (a phone, or a desktop column squeezed by a wide chat list) they are a
 * horizontal snapping track, and the card that comes to rest nearest the centre is the chosen one. The column's
 * width decides, never the window's. Arrow keys, Home and End move along the deck; the panel below follows.
 *
 * In the fan a card is mostly under its neighbours, so each card's button is only the strip of it that shows
 * (the strips tile the fan) and the card's face is a child that takes no clicks: a click lands on the card it is
 * aimed at, whether by a person or by a test that clicks the middle of a card.
 */
const TRACK_BELOW=600;
const CARD=360,RATIO=1.586,STEP=.2,PERSPECTIVE=1400,LIFT=24,DROP=10,TILT=16;
/** How a card looks at each distance from the chosen one. */
const at=(distance:number)=>({s:Math.max(.64,1-.06*distance),y:distance?DROP*distance:-LIFT,b:Math.max(.3,1-.2*distance)});
/** Where a point `lx` along a card centred at `cx`, turned by `ry` degrees, lands on screen once the perspective is applied. */
function project(cx:number,ry:number,lx:number) {
 const rad=ry*Math.PI/180,x=cx+lx*Math.cos(rad),z=-lx*Math.sin(rad);
 return x*PERSPECTIVE/(PERSPECTIVE-z);
}
interface Strip {left:number;right:number}
/** The cards' centres and visible strips (from the deck's centre) with `active` chosen and the fan shifted by `shift`. */
function fan(width:number,cards:number,active:number,shift:number) {
 const xs=new Array<number>(cards).fill(0),strips:Strip[]=[];
 xs[active]=shift;
 for(let i=0;i<cards;i++)strips[i]={left:0,right:0};
 strips[active]={left:shift-width/2,right:shift+width/2};
 for(const side of [1,-1] as const){
  let covered=shift+side*width/2;
  for(let i=active+side;i>=0&&i<cards;i+=side){
   const o=i-active,half=width*at(Math.abs(o)).s/2,cx=shift+o*STEP*width,ry=-TILT*o;
   xs[i]=cx;
   const outer=project(cx,ry,side*half),inner=project(cx,ry,-side*half);
   // What shows of this card: past what the nearer cards cover, at least 8px so it can still be aimed at.
   if(side===1)strips[i]={left:Math.min(Math.max(covered,inner),outer-8),right:outer};else strips[i]={left:outer,right:Math.max(Math.min(covered,inner),outer+8)};
   covered=outer;
  }
 }
 return {xs,strips,left:Math.min(...strips.map(s=>s.left)),right:Math.max(...strips.map(s=>s.right))};
}
/**
 * The card size for a deck this wide, and every fan. The chosen card sits in the centre; when the cards on one
 * side would run past the column, the fan shifts just enough to keep every card's strip inside, and the cards
 * shrink until the widest fan fits at all.
 */
function fanGeometry(deckWidth:number,cards:number) {
 const room=deckWidth-16,half=deckWidth/2-8;
 let width=Math.min(CARD,deckWidth*.6);
 for(let round=0;round<8&&cards;round++){
  const worst=Math.max(...Array.from({length:cards},(_,active)=>{const f=fan(width,cards,active,0);return f.right-f.left;}));
  if(worst<=room)break;
  width*=room/worst;
 }
 width=Math.round(width);
 const fans=Array.from({length:cards},(_,active)=>{
  let shift=0;
  for(let round=0;round<3;round++){const f=fan(width,cards,active,shift);if(f.right>half)shift-=f.right-half;else if(f.left<-half)shift+=-half-f.left;else break;}
  return fan(width,cards,active,shift);
 });
 return {width,height:Math.round(width/RATIO),fans};
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
 const cardWidth=mode==='track'?Math.round(width*.76):geometry.width,cardHeight=Math.round(cardWidth/RATIO);
 const trackHeight=cardHeight+LIFT+DROP*Math.min(5,cards.length-1)+16;

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

 const laid=geometry.fans[active];
 // The deck wears the chosen card's colour class: its glow and dots take that card's ink.
 return <div ref={root} className={`wallet-deck wallet-card-${cards[active].id}`} data-mode={mode} style={{'--deck-w':`${width}px`,'--card-w':`${cardWidth}px`,'--card-h':`${cardHeight}px`,'--track-h':`${trackHeight}px`} as CSSProperties}>
  <div className="wallet-deck-glow" aria-hidden="true"/>
  <div ref={track} className="wallet-deck-track" role="tablist" aria-label="Wallet integrations" onKeyDown={onKey}
   onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onClickCapture={onClickCapture}>
   {cards.map((card,i)=>{
    const offset=i-active,abs=Math.abs(offset),look=at(abs);
    // The button is the strip of the card that shows; the face is drawn from the deck's centre, moved by its transform.
    const strip=laid?.strips[i]??{left:-cardWidth/2,right:cardWidth/2};
    const left=Math.round(width/2+strip.left),top=Math.round(trackHeight/2+look.y-cardHeight*look.s/2);
    const place={'--bl':`${left}px`,'--bt':`${top}px`,'--bw':`${Math.max(8,Math.round(strip.right-strip.left))}px`,'--bh':`${Math.round(cardHeight*look.s)}px`,
     '--fl':`${Math.round(width/2-cardWidth/2)-left}px`,'--ft':`${Math.round(trackHeight/2-cardHeight/2)-top}px`,
     '--x':`${Math.round(laid?.xs[i]??0)}px`,'--y':`${look.y}px`,'--ry':`${-TILT*offset}deg`,'--s':look.s,'--b':look.b,zIndex:10-abs} as CSSProperties;
    return <button key={card.id} ref={el=>{tabs.current[i]=el;}} type="button" role="tab" id={`wallet-tab-${card.id}`} aria-selected={i===active} aria-controls="wallet-panel" tabIndex={i===active?0:-1}
     className={`wallet-deck-card wallet-card-${card.id}`} data-active={i===active} data-testid={`wallet-card-${card.id}`} style={place} onClick={()=>choose(i)}>
     <span className="wallet-deck-face">
      <span className="wallet-deck-card-glyph" aria-hidden="true"><WalletMark rail={card.id}/></span>
      <span className="wallet-deck-card-status">{card.status}</span>
      <span className="wallet-deck-card-ghost" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/><circle cx="9" cy="9" r="1.5" fill="var(--ghost-eye)"/><circle cx="15" cy="9" r="1.5" fill="var(--ghost-eye)"/></svg></span>
      <span className="wallet-deck-card-text"><span className="wallet-deck-card-name">{card.name}</span><span className="wallet-deck-card-balance">{card.balance}</span><span className="wallet-deck-card-detail">{card.detail}</span></span>
      <span className="wallet-deck-card-chip" aria-hidden="true"/>
     </span>
    </button>;
   })}
  </div>
  <div className="wallet-deck-dots" aria-hidden="true">{cards.map((card,i)=><span key={card.id} data-on={i===active}/>)}</div>
 </div>;
}
