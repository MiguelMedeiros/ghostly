import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { NostrDraft, NostrDraftRequest, NostrPublishResult } from "@ghostly/browser/nostr/types";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { nostrSignerChoices, signNostrDraft, type NostrSignerChoice } from "../../lib/nostr";
import { Button, Notice, input } from "../wallet/ui";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Publication on Nostr, one action at a time: the engine drafts the exact event, the person reads what
 * becomes public and where, chooses their signer, confirms, signs, and the engine sends it to their relays.
 * Nothing leaves before the confirmation; the engine refuses an event that differs from the draft.
 */
export function NostrPublishDialog({ request, onClose, onDone }: { request: NostrDraftRequest; onClose: () => void; onDone?: (result: NostrPublishResult) => void }) {
  const [draft, setDraft] = useState<NostrDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [result, setResult] = useState<NostrPublishResult | null>(null);
  const choices = nostrSignerChoices();
  const [signer, setSigner] = useState<NostrSignerChoice>(choices[0].id);
  const [bunker, setBunker] = useState("");
  const abort = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => { abort.current?.abort(); onClose(); };
  useDialogFocus(dialog, close);
  const backdrop = useBackdropDismiss(close);

  useEffect(() => {
    let cancelled = false;
    engine.call("nostrDraft", request).then(d => { if (!cancelled) setDraft(d); }, e => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
    // The request is the dialog's reason to exist: a new one is a new dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => abort.current?.abort(), []);

  const confirm = async () => {
    if (!draft) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setAuthUrl("");
    try {
      const event = await signNostrDraft(draft, { signer, bunker, signal: controller.signal, onAuth: setAuthUrl, onProgress: setProgress });
      controller.signal.throwIfAborted();
      setProgress("Sending to your relays…");
      const r = await engine.call("nostrPublish", { draftId: draft.draftId, event });
      setResult(r);
      onDone?.(r);
    } catch (e) { if (!controller.signal.aborted) setError(message(e)); }
    finally { setBusy(false); setProgress(""); setBunker(""); if (abort.current === controller) abort.current = null; }
  };

  const t = draft?.template;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="nostr-publish-title" data-testid="nostr-publish-dialog"
        className="focus:outline-none w-full max-w-md max-h-[90dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h2 id="nostr-publish-title" className="text-lg font-medium text-text-primary">{draft?.summary ?? "Publish on Nostr"}</h2>
          <button type="button" aria-label="Close" data-testid="nostr-publish-close" onClick={close} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer">×</button>
        </div>
        {!draft && !error && <p className="text-xs text-text-muted">Preparing…</p>}
        {t && !result && <>
          <div className="rounded-xl border border-border bg-surface-alt p-3 text-sm text-text-primary space-y-1" data-testid="nostr-publish-preview">
            {t.kind === 1 && <p className="whitespace-pre-wrap break-words">{t.content}</p>}
            {t.kind === 3 && <p>Your follow list, {t.tags.filter(x => x[0] === "p").length} {t.tags.filter(x => x[0] === "p").length === 1 ? "account" : "accounts"}, replaced as a whole.</p>}
            {t.kind === 0 && <dl className="text-xs space-y-0.5">{Object.entries(safeJson(t.content)).map(([k, v]) => <div key={k} className="flex gap-2 min-w-0"><dt className="shrink-0 text-text-muted">{k}</dt><dd className="min-w-0 break-words">{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>)}</dl>}
          </div>
          <Notice tone="warning" testId="nostr-publish-notice">Public on Nostr. {draft!.notice}</Notice>
          {choices.length > 1 && (
            <label className="block text-xs text-text-muted">Sign with
              <select data-testid="nostr-publish-signer" value={signer} onChange={e => setSigner(e.target.value as NostrSignerChoice)} className={`${input} mt-1`}>
                {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          )}
          {signer === "nip46" && (
            <label className="block text-xs text-text-muted">Signer connection link
              <input data-testid="nostr-publish-bunker" type="password" autoComplete="off" value={bunker} onChange={e => setBunker(e.target.value)} placeholder="bunker://…" className={`${input} mt-1`} />
            </label>
          )}
          {authUrl && <p className="text-xs text-text-muted">Approve it in your signer: <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline break-all">{authUrl}</a></p>}
          {progress && <p className="text-xs text-text-muted" aria-live="polite">{progress}</p>}
          <div className="flex flex-wrap gap-2 justify-end">
            <Button onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" data-testid="nostr-publish-confirm" disabled={busy || (signer === "nip46" && !bunker.trim())} onClick={() => void confirm()}>{busy ? "Waiting…" : "Sign and publish"}</Button>
          </div>
        </>}
        {result && (
          <div className="space-y-3">
            <Notice tone="success" testId="nostr-publish-result">Published to {result.accepted.join(", ")}.{result.rejected.length ? ` Not accepted by ${result.rejected.map(r => `${r.relay} (${r.reason})`).join(", ")}.` : ""}</Notice>
            <div className="flex justify-end"><Button variant="primary" onClick={close}>Done</Button></div>
          </div>
        )}
        {error && <Notice tone="error" testId="nostr-publish-error">{error}</Notice>}
      </div>
    </div>
  );
}

function safeJson(text: string): Record<string, unknown> {
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
