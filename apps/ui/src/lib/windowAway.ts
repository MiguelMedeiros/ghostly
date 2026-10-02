import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Motion that rests. An animation that loops keeps the window drawing 60 frames a second for as long as it is on
 * screen; where the window is composited by the app's own main thread (Linux: WebKitGTK) that is a core kept busy by
 * an app nobody is touching, and WebKitGTK goes on drawing a window that is on another workspace. So a loop runs
 * only while someone can be looking and while its news is fresh:
 *
 * - while the window is away (hidden, or not the focused one) the loops hold still: `<html data-away>`, which
 *   index.css turns into `animation-play-state: paused` on the loops, and `useWindowAway` for components;
 * - a state that can last for hours (an invite nobody has opened yet) moves for `MOTION_REST_MS` after it began,
 *   then rests as a still picture: `useMotionRest`.
 */

/** How long a state that may never end keeps moving before it rests. */
export const MOTION_REST_MS = 60_000;

/** Hidden (minimised, another tab), or not the window with the focus (behind others, on another workspace). */
export const windowAway = (): boolean => typeof document !== "undefined" && (document.visibilityState === "hidden" || !document.hasFocus());

const listeners = new Set<() => void>();
let away = false;
let watching = false;

function update(): void {
  const next = windowAway();
  // The attribute every time, the listeners on a change: something else may have rewritten <html>'s attributes.
  if (next) document.documentElement.dataset.away = "";
  else delete document.documentElement.dataset.away;
  if (next === away) return;
  away = next;
  for (const listener of listeners) listener();
}

/** Keeps `<html data-away>` in step with the window, from the first call on. Safe to call again. */
export function watchWindowAway(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  // Focus moving into a frame of this page (a contact's web app) blurs the window but not the document.
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pageshow", update);
  document.addEventListener("visibilitychange", update);
  update();
}

/** Tests only: stops nothing, reads the window again. */
export function refreshWindowAway(): void {
  if (watching) update();
}

const subscribe = (listener: () => void) => {
  watchWindowAway();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => away;

/** True while the window is away: a component's own loops and clocks stop then. */
export function useWindowAway(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * True once `state` has stayed the same for `restAfter` ms: its motion has said what it had to say, and the still
 * picture says the rest. A new `state` moves again, and so does the window coming back from being away.
 */
export function useMotionRest(state: string, restAfter = MOTION_REST_MS): boolean {
  const awayNow = useWindowAway();
  const [rested, setRested] = useState<string | null>(null);
  useEffect(() => {
    if (awayNow) return;
    setRested(null);
    const timer = setTimeout(() => setRested(state), restAfter);
    return () => clearTimeout(timer);
  }, [state, restAfter, awayNow]);
  // The state it rested in, not a flag: a new state moves in the very render that brings it.
  return rested === state;
}
