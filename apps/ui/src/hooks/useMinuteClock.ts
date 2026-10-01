import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/*
 * One clock for every time on screen that reads in minutes ("running for 12 min", "updated 3 min ago"): one timer for
 * the whole page, running only while something watches it, and a card off screen does not watch it. A row that scrolls
 * back into view reads the clock's time at once.
 */

const MINUTE = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
/** The clock's time: set on each tick, so every watcher reads the same one until the next. */
let stamp = Date.now();

const tick = () => { stamp = Date.now(); for (const l of listeners) l(); };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) timer = setInterval(tick, MINUTE);
  // A card coming into view mid-minute: every watcher reads now, not the last tick (at most every few seconds).
  else if (Date.now() - stamp > FRESH) queueMicrotask(tick);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; }
  };
}

/** How old the clock's time may be when something new reads it. */
const FRESH = 5_000;
const idle = () => () => {};
/**
 * The clock's time: the same between ticks while it runs, so a watcher that reads it again draws nothing new; with
 * nothing watching (no ticks), now, give or take a second.
 */
const read = () => {
  const now = Date.now();
  if (now < stamp || (!timer && now - stamp >= 1000)) stamp = now;
  return stamp;
};

/** Elements watched for being on screen, one observer for them all. */
const seen = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;

function watchVisible(el: Element, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") { onChange(true); return () => {}; }
  observer ??= new IntersectionObserver((entries) => { for (const e of entries) seen.get(e.target)?.(e.isIntersecting); });
  seen.set(el, onChange);
  observer.observe(el);
  return () => {
    seen.delete(el);
    observer?.unobserve(el);
    if (!seen.size) { observer?.disconnect(); observer = undefined; }
  };
}

/**
 * The time now, give or take a minute, while `ref`'s element is on screen: it moves once a minute, with the one timer the page
 * shares. Off screen it stands still and costs nothing.
 */
export function useMinuteClock(ref: RefObject<Element | null>): number {
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    return el ? watchVisible(el, setVisible) : undefined;
  }, [ref]);
  return useSyncExternalStore(visible ? subscribe : idle, read);
}
