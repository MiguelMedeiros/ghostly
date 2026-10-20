import { useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { sameValue } from "./sameValue";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
/** The engine's state, re-rendered on every change. What draws identities uses the one in `./identities`. */
export const useEngineState = () => useSyncExternalStore(subscribe, snapshot);

/**
 * What `select` reads of the engine's state, drawn again only when that changes by content: the engine sends its whole
 * state anew on every change (up to 20 a second while a file moves), so what reads one part of it would draw on each.
 */
export function useEngineValue<T>(select: (state: typeof engine.state) => T): T {
  const last = useRef<T | undefined>(undefined);
  return useSyncExternalStore(subscribe, () => {
    const now = select(engine.state);
    if (!sameValue(now, last.current)) last.current = now;
    return last.current as T;
  });
}
