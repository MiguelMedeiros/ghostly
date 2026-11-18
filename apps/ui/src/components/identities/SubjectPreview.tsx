import { Fragment } from "react";
import { Notice } from "../wallet/ui";
import type { SubjectPreviewState } from "./useSubjectPreview";
import { useI18n } from "../../contexts/I18nContext";

/** The preview under the subject field: its facts, "Looking it up…", or why it cannot be used. */
export function SubjectPreviewFacts({ state }: { state: SubjectPreviewState }) {
  const { t } = useI18n();
  const said = state.status === "loading" ? t("identities.add.lookingUp")
    : state.status === "ok" && state.preview.facts.length ? t("identities.add.lookedUp", { what: state.preview.facts[0].value }) : "";
  return <>
    {/* Said out loud (a did:dht lookup can wait 10 s on a relay): always there, so its first words are heard. A refusal is the alert's. */}
    <p role="status" data-testid="add-identity-preview-live" className="sr-only">{said}</p>
    {state.status === "loading" && <p aria-hidden="true" data-testid="add-identity-preview" data-status="loading" className="text-xs text-text-muted">{t("identities.add.lookingUp")}</p>}
    {state.status === "error" && <Notice tone="error" testId="add-identity-preview-error">{state.error}</Notice>}
    {state.status === "ok" && (
      <dl data-testid="add-identity-preview" data-status="ok" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-surface-alt p-2.5 text-xs">
        {state.preview.facts.map(f => (
          <Fragment key={f.label}>
            <dt className="text-text-muted">{f.label}</dt>
            <dd data-testid={`add-identity-preview-${f.label.toLowerCase().replace(/\s+/g, "-")}`} className={`min-w-0 [overflow-wrap:anywhere] text-text-primary ${/\s/.test(f.value) ? "" : "font-mono"}`}>{f.value}</dd>
          </Fragment>
        ))}
      </dl>
    )}
  </>;
}
