import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import type { ToastMessage } from "../../hooks/useToast";
import { touchOnly } from "../../lib/touchOnly";

/**
 * The floating card: over the content at the bottom centre on a desktop, above the tab bar on a phone (and above the
 * keyboard while it is open), where the person is looking after pressing a button, unlike a line at the top of a page.
 * Its live region is always there, empty when idle, so a screen reader reads each card out as it comes.
 *
 * Where it is rendered (`place`):
 * - `screen`: in `document.body`, over the whole window;
 * - `page`: as a Page's `overlay`, centred over that column (not over the chat list beside it on a desktop) and
 *   above the tab bar and the keyboard on a phone, since the column ends there;
 * - `dialog`: inside a modal `<dialog>`, where everything outside it is inert and under its backdrop;
 * - `header`: in a chat's header, shown just under it over the chat's column, near the header button that was pressed
 *   (the call buttons' why): at the bottom it sat over the message field's + and emoji buttons.
 *
 * It never covers the field it is about: where the card at the bottom would be over the focused field, the error
 * line under it or its form's button (a short screen with the keyboard up, a phone on its side), it goes to the top (`useClearOfField`).
 */
export function Toast({ toast, onDismiss, place = "screen", testId = "toast" }: { toast: ToastMessage | null; onDismiss(): void; place?: "screen" | "page" | "dialog" | "header"; testId?: string }) {
  const { t } = useI18n();
  const region = useClearOfField(toast);
  const held = useHeldTime(toast, onDismiss);
  const placeClass = place === "page" ? "toast-place toast-place-page" : place === "header" ? "toast-place toast-place-page toast-place-header" : "toast-place";
  const card: ReactNode = (
    <div ref={region} role="status" aria-live="polite" aria-atomic="true" className={placeClass} data-testid={`${testId}-region`}>
      {toast && (
        <div key={toast.id} {...held} data-testid={testId} data-tone={toast.tone}
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

/**
 * The card's time (`toast.ms`), as the composer's card runs it: it waits while the card is pointed at or has the focus
 * and runs again in full once it is left, so it stays until it has been read. A card that goes with the focus on its ×
 * (by itself or closed) hands the focus back to what had it when the card came (the field, the button that was pressed),
 * or to its dialog, not to the page. On a touch screen a field would bring the keyboard up: there the focus falls.
 */
function useHeldTime(toast: ToastMessage | null, onDismiss: () => void) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef({ pointer: false, focus: false });
  const opener = useRef<HTMLElement | null>(null);
  const run = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!toast || held.current.pointer || held.current.focus) return;
    timer.current = setTimeout(() => { timer.current = null; dismiss.current(); }, toast.ms);
  }, [toast]);
  // Its cleanup also stops a time the leaving card's blur started.
  useEffect(() => {
    held.current = { pointer: false, focus: false };
    run();
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [run]);
  useLayoutEffect(() => {
    const at = document.activeElement;
    if (toast && at instanceof HTMLElement && at !== document.body && !at.closest(".toast-card")) opener.current = at;
  }, [toast]);
  // The ref's cleanup runs while the card and its focused × are still there.
  const ref = useCallback((card: HTMLDivElement) => () => {
    if (!card.contains(document.activeElement)) return;
    const back = opener.current;
    const to = back?.isConnected && !back.matches(":disabled") ? back : card.closest("dialog");
    if (to && !(touchOnly() && to.matches("input, textarea, select, [contenteditable=true]"))) to.focus({ preventScroll: true });
  }, []);
  return {
    ref,
    onPointerEnter: () => { held.current.pointer = true; run(); },
    onPointerLeave: () => { held.current.pointer = false; run(); },
    onFocus: () => { held.current.focus = true; run(); },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      held.current.focus = false;
      run();
    },
  };
}

/**
 * The focused field, the lines that describe it (its error) and its form's buttons (Next, pressed again once it is
 * typed again), where the card must not be; null when none has the focus.
 */
function fieldBoxes(): DOMRect[] | null {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !field.matches("input, textarea, select, [contenteditable=true]")) return null;
  const described = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
  const buttons = [...field.closest("form")?.querySelectorAll("button") ?? []];
  return [field, ...described, ...buttons].map((el) => el.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
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
 * Puts the card at the top of its place (`data-at="top"`) while at the bottom it would cover the focused field, its
 * error or its form's buttons, and back at the bottom otherwise: where it covers less when both would. Measured when it shows, when the
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
