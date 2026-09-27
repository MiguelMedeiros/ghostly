import { useEffect, useReducer } from "react";
import { servicesPlatform } from "../lib/platform";

/** The platform's ephemeral services, or null where they are not available yet. Re-renders on change. */
export function useServicesPlatform() {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => servicesPlatform?.subscribe(refresh), []);
  return servicesPlatform;
}

/**
 * A file's transfer where the message carries one: only then does it re-render on the platform's changes, so a
 * list of text messages does not redraw on every file's progress.
 */
export function useTransfer(fileId?: string) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (fileId ? servicesPlatform?.subscribe(refresh) : undefined), [fileId]);
  return { platform: servicesPlatform, transfer: fileId ? servicesPlatform?.getTransfer(fileId) ?? null : null };
}
