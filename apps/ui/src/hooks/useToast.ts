import { useCallback, useRef, useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { readingTime } from "../lib/readingTime";

export type ToastTone = "error" | "success";

export interface ToastMessage {
  /** New on every show: the card is made again, so the same words said twice are read out twice. */
  id: number;
  tone: ToastTone;
  /** What happened, in a few words ("Password not changed"). Optional: the text alone is enough for most. */
  title?: string;
  text: string;
  /** How long it stays before it goes by itself, while it is not pointed at and has not the focus. */
  ms: number;
}

/** How long a card stays before it goes by itself, at least. */
export const TOAST_DURATION = 5_000;

/**
 * A floating card's state: `show` puts one up (replacing the one there), and it goes after `duration` (an error: long
 * enough to read in the app's language, `readingTime`) or when dismissed. Render `<Toast toast={toast} onDismiss={dismiss} />`
 * (components/ui/Toast.tsx) where the card belongs: it runs the time, which waits while the card is pointed at or focused.
 */
export function useToast(duration = TOAST_DURATION) {
  const { language } = useI18n();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const next = useRef(0);
  const dismiss = useCallback(() => setToast(null), []);
  const show = useCallback((text: string, { tone = "error", title }: { tone?: ToastTone; title?: string } = {}) => {
    next.current += 1;
    const ms = tone === "error" ? readingTime(`${title ?? ""}${text}`, language, duration) : duration;
    setToast({ id: next.current, tone, title, text, ms });
  }, [duration, language]);
  return { toast, show, dismiss };
}
