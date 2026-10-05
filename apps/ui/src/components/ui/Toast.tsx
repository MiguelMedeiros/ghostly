import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import type { ToastMessage } from "../../hooks/useToast";

/**
 * The floating card: over the content at the bottom centre on a desktop, above the tab bar on a phone (and above the
 * keyboard while it is open), where the person is looking after pressing a button, unlike a line at the top of a page.
 * Its live region is always there, empty when idle, so a screen reader reads each card out as it comes.
 *
 * Where it is rendered (`place`):
 * - `screen`: in `document.body`, over the whole window;
 * - `page`: as a Page's `overlay`, centred over that column (not over the chat list beside it on a desktop) and
 *   above the tab bar and the keyboard on a phone, since the column ends there;
 * - `dialog`: inside a modal `<dialog>`, where everything outside it is inert and under its backdrop.
 *
 * It never covers the field it is about: where the card at the bottom would be over the focused field or the error
 * line under it (a short screen with the keyboard up, a phone on its side), it goes to the top (`useClearOfField`).
 */
export function Toast({ toast, onDismiss, place = "screen", testId = "toast" }: { toast: ToastMessage | null; onDismiss(): void; place?: "screen" | "page" | "dialog"; testId?: string }) {
  const { t } = useI18n();
  const region = useClearOfField(toast);
  const card: ReactNode = (
    <div ref={region} role="status" aria-live="polite" aria-atomic="true" className={place === "page" ? "toast-place toast-place-page" : "toast-place"} data-testid={`${testId}-region`}>
      {toast && (
        <div key={toast.id} data-testid={testId} data-tone={toast.tone}
          className="toast-card pointer-events-auto flex items-start gap-2.5 w-full max-w-sm rounded-xl border border-border bg-sidebar-bg px-4 py-3 shadow-2xl animate-fade-in">
          <span aria-hidden="true" className={`mt-0.5 shrink-0 ${toast.tone === "error" ? "text-danger" : "text-success"}`}>
            {toast.tone === "error" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><path d="M8 12.5l2.5 2.5L16 9.5" />
              </svg>
            )}
          </span>
          <span className="min-w-0 flex-1 text-sm leading-snug text-text-primary break-words">
            {toast.title && <span data-testid={`${testId}-title`} className="block font-semibold">{toast.title}</span>}
            <span data-testid={`${testId}-text`} className={`block ${toast.title ? "text-text-secondary" : ""}`}>{toast.text}</span>
          </span>
          <button type="button" onClick={onDismiss} aria-label={t("common.close")} data-testid={`${testId}-close`}
            className="-me-1.5 -mt-1 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-lg leading-none text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            ×
          </button>
        </div>
      )}
    </div>
  );
  return place === "screen" ? createPortal(card, document.body) : card;
}

/** The focused field and the lines that describe it (its error), where the card must not be; null when none has the focus. */
function fieldBoxes(): DOMRect[] | null {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !field.matches("input, textarea, select, [contenteditable=true]")) return null;
  const described = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
  return [field, ...described].map((el) => el.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
}

/** How many pixels of `boxes` the card's box covers. */
function covered(card: DOMRect, boxes: readonly DOMRect[]): number {
  let area = 0;
  for (const box of boxes) {
    const w = Math.min(card.right, box.right) - Math.max(card.left, box.left);
    const h = Math.min(card.bottom, box.bottom) - Math.max(card.top, box.top);
    if (w > 0 && h > 0) area += w * h;
  }
  return area;
}

/**
 * Puts the card at the top of its place (`data-at="top"`) while at the bottom it would cover the focused field or its
 * error, and back at the bottom otherwise: where it covers less when both would. Measured when it shows, when the
 * focus moves, and when the visible area changes (the keyboard, a scroll, the phone turning).
 */
function useClearOfField(toast: ToastMessage | null): RefObject<HTMLDivElement | null> {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = region.current;
    if (!toast || !el) return;
    const place = () => {
      const card = el.firstElementChild;
      const boxes = fieldBoxes();
      el.removeAttribute("data-at");
      if (!card || !boxes?.length) return;
      const atBottom = covered(card.getBoundingClientRect(), boxes);
      if (!atBottom) return;
      el.dataset.at = "top";
      if (covered(card.getBoundingClientRect(), boxes) >= atBottom) el.removeAttribute("data-at");
    };
    place();
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    const viewport = window.visualViewport;
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    document.addEventListener("scroll", later, { capture: true, passive: true });
    window.addEventListener("resize", later);
    viewport?.addEventListener("resize", later);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      document.removeEventListener("scroll", later, { capture: true });
      window.removeEventListener("resize", later);
      viewport?.removeEventListener("resize", later);
      el.removeAttribute("data-at");
    };
  }, [toast]);
  return region;
}
