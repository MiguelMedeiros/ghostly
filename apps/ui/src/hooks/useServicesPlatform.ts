import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { servicesPlatform, type FileTransferState } from "../lib/platform";
import { sameValue } from "../lib/sameValue";

/** The platform's ephemeral services, or null where they are not available yet. Re-renders on change. */
export function useServicesPlatform() {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => servicesPlatform?.subscribe(refresh), []);
  return servicesPlatform;
}

/**
 * A file's transfer where the message carries one: it re-renders only when that transfer changes, so a list of
 * messages does not redraw on every file's progress, nor its files on every change of the engine's state.
 */
export function useTransfer(fileId?: string) {
  const subscribe = useCallback((listener: () => void) => (fileId && servicesPlatform?.subscribe(listener)) || (() => {}), [fileId]);
  // The engine sends its state anew each time: the same transfer by content is the one already drawn.
  const last = useRef<FileTransferState | null>(null);
  const snapshot = useCallback(() => {
    const now = fileId ? servicesPlatform?.getTransfer(fileId) ?? null : null;
    if (!sameValue(now, last.current)) last.current = now;
    return last.current;
  }, [fileId]);
  const transfer = useSyncExternalStore(subscribe, snapshot);
  // No transfer yet is not "finished" while the engine is still putting its kept transfers back after a start.
  const restoring = useSyncExternalStore(subscribe, () => !!fileId && servicesPlatform?.transfersRestored?.() === false);
  return { platform: servicesPlatform, transfer, restoring: restoring && transfer === null };
}
