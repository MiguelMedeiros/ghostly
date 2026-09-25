import { Fragment } from "react";
import { Notice } from "../wallet/ui";
import type { SubjectPreviewState } from "./useSubjectPreview";

/** The preview under the subject field: its facts, "Looking it up…", or why it cannot be used. */
export function SubjectPreviewFacts({ state }: { state: SubjectPreviewState }) {
  if (state.status === "idle") return null;
  if (state.status === "loading") return <p data-testid="add-identity-preview" data-status="loading" className="text-xs text-text-muted">Looking it up…</p>;
  if (state.status === "error") return <Notice tone="error" testId="add-identity-preview-error">{state.error}</Notice>;
  return (
    <dl data-testid="add-identity-preview" data-status="ok" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-surface-alt p-2.5 text-xs">
      {state.preview.facts.map(f => (
        <Fragment key={f.label}>
          <dt className="text-text-muted">{f.label}</dt>
          <dd data-testid={`add-identity-preview-${f.label.toLowerCase().replace(/\s+/g, "-")}`} className={`min-w-0 [overflow-wrap:anywhere] text-text-primary ${/\s/.test(f.value) ? "" : "font-mono"}`}>{f.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
