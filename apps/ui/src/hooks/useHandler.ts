import { useCallback, useRef } from "react";

/**
 * `handler` as one function for the component's whole life, calling the `handler` of its latest draw: for a callback a
 * memoized child keeps from an earlier draw (a message row drawn again only when what it shows changes) and calls later.
 */
export function useHandler<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: A) => latest.current(...args), []);
}
