import type { LinkPreviewDraft } from "../../hooks/useLinkPreviewDraft";

/** The preview above the composer, with a × to send the link without it. */
export function LinkPreviewDraftCard({ draft, onRemove }: { draft: LinkPreviewDraft; onRemove: () => void }) {
  const host = (() => { try { return new URL(draft.key).hostname.replace(/^www\./, ""); } catch { return draft.link; } })();
  const preview = draft.preview;
  return (
    <div data-testid="composer-link-preview" data-status={draft.status} role="status"
      className="mb-2 flex items-stretch gap-2 rounded-lg bg-surface-alt border-s-4 border-link overflow-hidden animate-fade-in">
      {preview?.i && <img src={preview.i} alt="" className="w-16 h-16 object-cover shrink-0 self-center" draggable={false} />}
      <div className="min-w-0 flex-1 py-1.5 ps-1">
        {draft.status === "loading" ? (
          <p className="text-[12.5px] text-text-secondary truncate">Loading preview of {host}…</p>
        ) : (
          <>
            <p className="text-[13px] font-semibold text-text-primary truncate" data-testid="composer-link-preview-title">{preview?.t ?? host}</p>
            {preview?.d && <p className="text-[12px] text-text-secondary line-clamp-2 leading-snug">{preview.d}</p>}
            <p className="text-[11px] text-text-muted truncate">{preview?.s ? `${preview.s} · ` : ""}{host}</p>
          </>
        )}
      </div>
      <button type="button" data-testid="link-preview-remove" onClick={onRemove} aria-label="Remove link preview" title="Send without a preview"
        className="shrink-0 w-9 flex items-start justify-center pt-1.5 text-text-muted hover:text-text-primary cursor-pointer bg-transparent border-0 text-lg leading-none">
        &times;
      </button>
    </div>
  );
}
