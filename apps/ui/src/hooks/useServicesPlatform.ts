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
  const restoring = useSyncExternalStore(subscribe, () => !!fileId && servicesPlatform?.transfersRestored?.() === false) && transfer === null;
  // A group's file received that shows no transfer is all here, or waits for its person's Download: its record says
  // which. Until it has said, the file is not taken as finished.
  const groupIn = !!fileId && fileId.startsWith("group-") && fileId.includes("-in-") && !!servicesPlatform?.storedTransfer;
  const stored = groupIn && transfer === null && !restoring;
  const [, read] = useReducer((n: number) => n + 1, 0);
  const shown = transfer?.state ?? null;
  useEffect(() => {
    if (!fileId || !groupIn) return;
    // A transfer shows: what the record said may change before the next time it shows none. One that ended all here
    // is not shown for long (the engine keeps none for a group's file all here): it stays so, with nothing to read.
    if (!stored) { if (shown === "done") storedTransfers.set(fileId, null); else if (shown) storedTransfers.delete(fileId); return; }
    if (storedTransfers.has(fileId)) return;
    let cancelled = false;
    void readStoredTransfer(fileId).then(() => { if (!cancelled) read(); });
    return () => { cancelled = true; };
  }, [fileId, groupIn, stored, shown]);
  const known = stored && storedTransfers.has(fileId!);
  return { platform: servicesPlatform, transfer: transfer ?? (known ? storedTransfers.get(fileId!)! : null), restoring: restoring || (stored && !known) };
}

/** What a group file's record said while the engine showed no transfer for it, by file id: read once until one shows. */
const storedTransfers = new Map<string, FileTransferState | null>();
const storedReads = new Map<string, Promise<void>>();

/** Reads it once for every bubble that shows the file (its message's bubble and its menu ask together). */
function readStoredTransfer(fileId: string): Promise<void> {
  let reading = storedReads.get(fileId);
  if (!reading) {
    reading = (servicesPlatform?.storedTransfer?.(fileId) ?? Promise.resolve(null)).catch(() => null)
      .then((transfer) => { storedTransfers.set(fileId, transfer); }).finally(() => storedReads.delete(fileId));
    storedReads.set(fileId, reading);
  }
  return reading;
}
