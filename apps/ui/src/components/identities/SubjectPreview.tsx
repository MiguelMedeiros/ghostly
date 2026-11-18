import { Fragment } from "react";
import { Notice } from "../wallet/ui";
import type { SubjectPreviewState } from "./useSubjectPreview";
import { useI18n } from "../../contexts/I18nContext";
import { ownDirection } from "../../lib/ownDirection";

/** The preview under the subject field: its facts, "Looking it up…", or why it cannot be used. */
export function SubjectPreviewFacts({ state }: { state: SubjectPreviewState }) {
  const { t } = useI18n();
  if (state.status === "idle") return null;
  if (state.status === "loading") return <p data-testid="add-identity-preview" data-status="loading" className="text-xs text-text-muted">{t("identities.add.lookingUp")}</p>;
  if (state.status === "error") return <Notice tone="error" testId="add-identity-preview-error">{state.error}</Notice>;
  return (
    <dl data-testid="add-identity-preview" data-status="ok" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-surface-alt p-2.5 text-xs">
      {state.preview.facts.map(f => (
        <Fragment key={f.label}>
          <dt className="text-text-muted">{f.label}</dt>
          {/* A host, URL or "#0 (Ed25519)" left to right even in Arabic, or its "#" and brackets move; a sentence its own way. */}
          <dd data-testid={`add-identity-preview-${f.label.toLowerCase().replace(/\s+/g, "-")}`} dir={f.code ? undefined : ownDirection(f.value)} className={`min-w-0 [overflow-wrap:anywhere] text-text-primary ${f.code ? "font-mono" : ""}`}>
            {f.code ? <bdi dir="ltr">{f.value}</bdi> : f.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
