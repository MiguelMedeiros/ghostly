"use client";

import { useSyncExternalStore } from "react";

/**
 * A media query as a boolean, read during the hydration commit so the first
 * client frame already has the right layout. The server (and the hydration
 * render) answer false; one MediaQueryList per query is shared by every caller.
 */
const lists = new Map<string, MediaQueryList>();
const subscribers = new Map<string, (cb: () => void) => () => void>();

function list(query: string): MediaQueryList {
  let l = lists.get(query);
  if (!l) {
    l = window.matchMedia(query);
    lists.set(query, l);
  }
  return l;
}

function subscriber(query: string) {
  let s = subscribers.get(query);
  if (!s) {
    s = (cb: () => void) => {
      const l = list(query);
      l.addEventListener("change", cb);
      return () => l.removeEventListener("change", cb);
    };
    subscribers.set(query, s);
  }
  return s;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscriber(query),
    () => list(query).matches,
    () => false,
  );
}
