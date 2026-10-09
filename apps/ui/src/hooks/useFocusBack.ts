import { useEffect, useRef } from "react";

/**
 * A button disabled while its work runs loses the focus to the page, and nothing gives it back. Call the returned
 * function as the work starts: once `busy` is false again, what had the focus gets it back, unless the focus went
 * somewhere else meanwhile or it is gone.
 */
export function useFocusBack(busy: boolean): () => void {
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = back.current;
    if (busy || !el) return;
    back.current = null;
    const active = document.activeElement;
    if ((!active || active === document.body) && el.isConnected && !(el as HTMLButtonElement).disabled) el.focus({ preventScroll: true });
  }, [busy]);
  return () => {
    const active = document.activeElement;
    back.current = active instanceof HTMLElement && active !== document.body ? active : null;
  };
}
