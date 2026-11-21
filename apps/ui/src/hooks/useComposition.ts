import { useCallback, useMemo, useRef, type CompositionEvent, type KeyboardEvent } from "react";

/**
 * How close a keydown must follow the end of a composition to be the key that ended it. WebKit (Safari, the macOS
 * and Linux Desktop apps) fires `compositionend` before the keydown of the Enter that confirmed the candidate, and
 * that keydown no longer says it is composing. Both come from the same key press, a few milliseconds apart.
 */
export const COMPOSITION_END_WINDOW_MS = 100;

/**
 * Whether a keydown is the input method's: while it composes, or the key that ended a composition at `endedAt` (the
 * `compositionend`'s timeStamp, null for none). For a listener on the whole page; a field takes `useComposition`.
 */
export function composingKey(e: globalThis.KeyboardEvent, endedAt: number | null): boolean {
  // 229: the key went to the input method (WebKit reports it, and older Chrome, without `isComposing`).
  if (e.isComposing || e.keyCode === 229) return true;
  return endedAt !== null && Math.abs(e.timeStamp - endedAt) < COMPOSITION_END_WINDOW_MS;
}

/**
 * Keys that belong to an input method (Japanese, Chinese, Korean…): while it composes, Enter confirms a candidate,
 * the arrows move among candidates and Escape drops the composition. A field that acts on those keys asks
 * `composing(e)` first and leaves the key alone when it says true. Spread `inputProps` on the field.
 */
export function useComposition() {
  const endedAt = useRef<number | null>(null);
  const onCompositionEnd = useCallback((e: CompositionEvent) => { endedAt.current = e.timeStamp; }, []);
  /** Call once per keydown: the end of a composition answers for the one keydown that follows it. */
  const composing = useCallback((e: KeyboardEvent | globalThis.KeyboardEvent): boolean => {
    const native = "nativeEvent" in e ? e.nativeEvent : e;
    const ended = endedAt.current;
    endedAt.current = null;
    return composingKey(native, ended);
  }, []);
  const inputProps = useMemo(() => ({ onCompositionEnd }), [onCompositionEnd]);
  return { composing, inputProps };
}
