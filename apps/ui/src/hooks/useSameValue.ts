import { useRef } from "react";
import { sameValue } from "../lib/sameValue";

/**
 * `value`, or the one given before while it holds the same data (`sameValue`). The engine sends each state anew, often
 * with new copies of lists that did not change: what is worked out from one is worked out again only when it changes.
 */
export function useSameValue<T>(value: T): T {
  const kept = useRef(value);
  if (!sameValue(kept.current, value)) kept.current = value;
  return kept.current;
}
