import { useId, useState, type ReactNode } from "react";
import { useCopyKey } from "../../hooks/useCopyKey";
import { useOptionalI18n } from "../../contexts/I18nContext";
import { InfoButton } from "../layout/Section";
import type { Problem } from "../../lib/problemText";

/**
 * How a notice reads: `error` (red) only when the person has something to do; `wait` when the app tries again by
 * itself (never red); `warning` before something risky; `success`; `muted` for a plain note.
 */
export type NoticeTone = "muted" | "error" | "success" | "warning" | "wait";

const COLOR: Record<NoticeTone, string> = {
  muted: "text-text-muted", wait: "text-text-secondary", error: "text-danger", success: "text-accent", warning: "text-yellow-500",
};

/**
 * One error, warning or note, the app's way (docs: short labels, details behind ⓘ): a title of a few words saying what
 * happened, maybe a next step under it, and the rest (the engine's own English, addresses, codes) behind an ⓘ with a
 * Copy button, never in the line itself. A plain `children` is the title, as the wallet's notices always were.
 * `problem` (lib/problemText.ts) gives the three parts and the tone at once.
 */
export function Notice({ tone, title, next, details, problem, children, testId, className = "text-xs" }: {
  tone?: NoticeTone; title?: ReactNode; next?: ReactNode; details?: string; problem?: Problem; children?: ReactNode; testId?: string; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const i18n = useOptionalI18n();
  const said = problem ? { tone: problem.tone, title: problem.title, next: problem.next, details: problem.detail } : {};
  const kind: NoticeTone = tone ?? said.tone ?? "muted";
  const head = title ?? said.title ?? children, then = next ?? said.next, more = details ?? said.details;
  const { copied, copy } = useCopyKey(more ?? "");
  return (
    <div role={kind === "error" ? "alert" : undefined} data-testid={testId} data-tone={kind} className={`${COLOR[kind]} ${className}`}>
      <div className="flex items-start gap-1.5">
        <p className="m-0 min-w-0 flex-1 break-words">
          <span data-testid={testId ? `${testId}-title` : undefined}>{head}</span>
          {then && <span data-testid={testId ? `${testId}-next` : undefined} className="block text-text-secondary">{then}</span>}
        </p>
        {more && <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId={testId ? `${testId}-info` : undefined} className="mt-px" />}
      </div>
      {more && open && <div id={id} data-testid={testId ? `${testId}-details` : undefined} className="mt-1 flex items-start gap-2 border-s-2 border-border ps-2 text-text-secondary">
        <p dir="ltr" lang="en" className="m-0 min-w-0 flex-1 break-words font-mono text-[11px] leading-4">{more}</p>
        <button type="button" onClick={copy} data-testid={testId ? `${testId}-copy` : undefined}
          className="shrink-0 rounded-md px-1.5 text-[11px] text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {copied ? i18n?.t("common.copied") ?? "Copied!" : i18n?.t("common.copy") ?? "Copy"}
        </button>
      </div>}
    </div>
  );
}
