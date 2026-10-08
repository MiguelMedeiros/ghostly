import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../contexts/I18nContext";
import { onOpenFailure, openProblem } from "../lib/openFailure";
import type { Problem } from "../lib/problemText";
import { Notice } from "./ui/Notice";

/** How long the card stays when nobody touches it. */
const SHOWN_MS = 8_000;

/**
 * A link that could not be opened, where its own place says nothing (lib/openFailure.ts): a floating card where the
 * toasts go, with what happened, what to do, and the reason behind the ⓘ. It goes by itself unless touched.
 */
export function OpenFailureNotice() {
  const { t } = useI18n();
  const [problem, setProblem] = useState<Problem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => onOpenFailure((error) => {
    hold();
    setProblem(openProblem(error, t));
    timer.current = setTimeout(() => { timer.current = null; setProblem(null); }, SHOWN_MS);
  }), [t]);
  useEffect(() => hold, []);
  return createPortal(
    <div className="toast-place" data-testid="open-failure-region">
      {problem && (
        <div onPointerDown={hold} onFocus={hold}
          className="toast-card pointer-events-auto flex items-start gap-2.5 w-full max-w-sm rounded-xl border border-border bg-sidebar-bg px-4 py-3 shadow-2xl animate-fade-in">
          <Notice problem={problem} testId="open-failure" className="min-w-0 flex-1 text-sm" />
          <button type="button" onClick={() => { hold(); setProblem(null); }} aria-label={t("common.close")} data-testid="open-failure-close"
            className="-me-1.5 -mt-1 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-lg leading-none text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            ×
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
