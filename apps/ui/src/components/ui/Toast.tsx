import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import type { ToastMessage } from "../../hooks/useToast";

/**
 * The floating card: over the content at the bottom centre on a desktop, above the tab bar on a phone (and above the
 * keyboard while it is open), where the person is looking after pressing a button, unlike a line at the top of a page.
 * Its live region is always there, empty when idle, so a screen reader reads each card out as it comes.
 *
 * It goes to `document.body`, except `inPlace`: inside a modal `<dialog>`, where everything outside the dialog is inert
 * and under its backdrop, the card must be rendered within the dialog.
 */
export function Toast({ toast, onDismiss, inPlace = false, testId = "toast" }: { toast: ToastMessage | null; onDismiss(): void; inPlace?: boolean; testId?: string }) {
  const { t } = useI18n();
  const card: ReactNode = (
    <div role="status" aria-live="polite" aria-atomic="true" className="toast-place" data-testid={`${testId}-region`}>
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
  return inPlace ? card : createPortal(card, document.body);
}
