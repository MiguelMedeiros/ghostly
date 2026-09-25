import { Fragment, useEffect, useState } from "react";
import type { IdentityProofProvider, IdentitySigner, SubjectPreview } from "@ghostly/browser/proofs/contract";
import { Notice } from "../wallet/ui";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type SubjectPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; subject: string; preview: SubjectPreview }
  | { status: "error"; error: string };

/**
 * What the subject being typed turns out to be, for a provider with `subject.preview` (a DID: its method,
 * keys and domain), looked up a moment after the person stops typing. Idle for other providers.
 */
export function useSubjectPreview(provider: IdentityProofProvider | null, input: string, delayMs = 400): SubjectPreviewState {
  const [state, setState] = useState<SubjectPreviewState>({ status: "idle" });
  useEffect(() => {
    const preview = provider?.subject.preview;
    if (!provider || !preview || !input.trim()) { setState({ status: "idle" }); return; }
    const controller = new AbortController();
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      let subject: string;
      try { subject = provider.subject.normalize(input); } catch (e) { setState({ status: "error", error: message(e) }); return; }
      preview(subject, { signal: controller.signal }).then(
        result => { if (!controller.signal.aborted) setState({ status: "ok", subject, preview: result }); },
        e => { if (!controller.signal.aborted) setState({ status: "error", error: message(e) }); });
    }, delayMs);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [provider, input, delayMs]);
  return state;
}

/** The signers the preview says apply to this subject (a did:key cannot publish a file); all of them otherwise. */
export const applicableSigners = <E,>(signers: IdentitySigner<E>[], state: SubjectPreviewState) =>
  state.status === "ok" && state.preview.signers ? signers.filter(s => state.preview.signers!.includes(s.id)) : signers;

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
          <dd data-testid={`add-identity-preview-${f.label.toLowerCase().replace(/\s+/g, "-")}`} className="min-w-0 break-all font-mono text-text-primary">{f.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
