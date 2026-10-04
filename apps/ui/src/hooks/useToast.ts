import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "error" | "success";

export interface ToastMessage {
  /** New on every show: the card is made again, so the same words said twice are read out twice. */
  id: number;
  tone: ToastTone;
  /** What happened, in a few words ("Password not changed"). Optional: the text alone is enough for most. */
  title?: string;
  text: string;
}

/** How long a card stays before it goes by itself. */
export const TOAST_DURATION = 5_000;

/**
 * A floating card's state: `show` puts one up (replacing the one there), and it goes after `duration` or when
 * dismissed. Render `<Toast toast={toast} onDismiss={dismiss} />` (components/ui/Toast.tsx) where the card belongs.
 */
export function useToast(duration = TOAST_DURATION) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const next = useRef(0);
  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  }, []);
  const show = useCallback((text: string, { tone = "error", title }: { tone?: ToastTone; title?: string } = {}) => {
    if (timer.current) clearTimeout(timer.current);
    next.current += 1;
    setToast({ id: next.current, tone, title, text });
    timer.current = setTimeout(() => { timer.current = null; setToast(null); }, duration);
  }, [duration]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { toast, show, dismiss };
}
