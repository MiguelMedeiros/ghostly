/**
 * Opening an installed mini-app (WISP 1200): the screens ask `openApp`, and the client that can run apps registers how
 * (`setAppOpener`: the web app's runner and broker, `webOpener.ts`). Where none is registered, apps cannot run here.
 */
import { useSyncExternalStore } from "react";

/** How to open it. `runAnyway`: the person chose "Run anyway" for a version a store of theirs removed (never a revoked one). */
export interface OpenAppOptions { runAnyway?: boolean }

/** Opens `ref` in the 1:1 chat `linkId`, or alone when it is null. Rejects when it cannot start (revoked, removed, no runner…). */
export type AppOpener = (ref: string, linkId: string | null, options?: OpenAppOptions) => Promise<void>;

let opener: AppOpener | null = null;
const listeners = new Set<() => void>();

export function setAppOpener(next: AppOpener | null): void {
  opener = next;
  for (const listener of [...listeners]) listener();
}

export function openApp(ref: string, linkId: string | null = null, options: OpenAppOptions = {}): Promise<void> {
  return opener ? opener(ref, linkId, options) : Promise.reject(new Error("Apps cannot run in this app"));
}

/** The registered opener, or null where apps cannot run (a screen hides what would open one). */
export function useAppOpener(): AppOpener | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => opener, () => opener);
}
