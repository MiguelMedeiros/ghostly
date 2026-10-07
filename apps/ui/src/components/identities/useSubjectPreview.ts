import { useEffect, useState } from "react";
import type { IdentityProofProvider, IdentitySigner, SubjectPreview } from "@ghostly/browser/proofs/contract";
import { problemLine } from "../../lib/problemText";
import { useT } from "../../contexts/I18nContext";


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
  const t = useT();
  const [state, setState] = useState<SubjectPreviewState>({ status: "idle" });
  useEffect(() => {
    const preview = provider?.subject.preview;
    if (!provider || !preview || !input.trim()) { setState({ status: "idle" }); return; }
    const controller = new AbortController();
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      let subject: string;
      try { subject = provider.subject.normalize(input); } catch (e) { setState({ status: "error", error: problemLine(e, t) }); return; }
      preview(subject, { signal: controller.signal }).then(
        result => { if (!controller.signal.aborted) setState({ status: "ok", subject, preview: result }); },
        e => { if (!controller.signal.aborted) setState({ status: "error", error: problemLine(e, t) }); });
    }, delayMs);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [provider, input, delayMs, t]);
  return state;
}

/** The signers the preview says apply to this subject (a did:key cannot publish a file); all of them otherwise. */
export const applicableSigners = <E,>(signers: IdentitySigner<E>[], state: SubjectPreviewState) =>
  state.status === "ok" && state.preview.signers ? signers.filter(s => state.preview.signers!.includes(s.id)) : signers;
