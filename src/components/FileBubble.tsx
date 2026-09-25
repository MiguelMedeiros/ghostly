import { useEffect, useState } from "react";
import { PREVIEWABLE_IMAGE } from "@ghostly/core";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { formatFileSize } from "../lib/format";
import type { ChatFile } from "../lib/types";

/** A file in the chat: progress while it travels, then a preview (images) and a way to save it. */
export function FileBubble({ file }: { file: ChatFile }) {
  const platform = useServicesPlatform();
  const transfer = platform?.getTransfer(file.id) ?? null;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const [missing, setMissing] = useState(false);
  const settled = transfer === null || transfer.state === "done";
  // A transfer seen in progress ends with a little pop; files from history just show up.
  const [watched, setWatched] = useState(false);
  useEffect(() => {
    if (transfer?.state === "transferring") setWatched(true);
  }, [transfer?.state]);

  // A small file can be announced before its transfer shows up: look again once it has.
  useEffect(() => {
    if (!platform || !settled) return;
    let url: string | null = null;
    let cancelled = false;
    void platform.getFile(file.id).then((blob) => {
      if (cancelled) return;
      if (!blob) return setMissing(true);
      url = URL.createObjectURL(blob);
      setBlobUrl(url);
      setMissing(false);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [platform, file.id, settled, transfer?.state]);

  let status = formatFileSize(file.size);
  if (transfer?.state === "transferring") {
    status = `${Math.round((transfer.transferred / Math.max(1, transfer.size)) * 100)}% of ${formatFileSize(file.size)}`;
  } else if (transfer?.state === "failed") {
    status = `Failed: ${transfer.error ?? "transfer interrupted"}`;
  } else if (missing) {
    status = "No longer available";
  }

  return (
    <div className="min-w-[220px] max-md:min-w-[min(220px,68vw)] max-w-[min(330px,72vw)]" data-testid="file-bubble">
      {blobUrl && PREVIEWABLE_IMAGE.test(file.mime) && (
        <img src={blobUrl} alt={file.name} className="rounded-[4px] max-w-full max-h-[330px] object-contain block mb-1" />
      )}
      <div className="flex items-center gap-3 px-2 py-1.5">
        <span className="w-9 h-9 rounded-full bg-black/20 flex items-center justify-center shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-tight truncate m-0" title={file.name}>
            {file.name}
          </p>
          <p
            className={`text-[11px] m-0 ${transfer?.state === "failed" || missing ? "text-danger-ink" : "text-text-primary/65"}`}
            data-testid="file-status"
          >
            {status}
          </p>
        </div>
        {blobUrl && (
          <a
            href={blobUrl}
            download={file.name}
            data-testid="file-save"
            className={`w-9 h-9 rounded-full bg-black/20 hover:bg-black/30 flex items-center justify-center shrink-0 text-inherit transition-colors ${watched ? "animate-pop" : ""}`}
            title="Save"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
      {transfer?.state === "failed" && file.id.includes("-out-") && platform?.retryFile && (
        <button className="text-xs underline px-2 py-1" onClick={() => { setRetryError(""); void platform.retryFile!(file.id).catch(error => setRetryError(String(error.message ?? error))); }}>Retry sending</button>
      )}
      {retryError && <p className="text-xs text-danger-ink px-2" role="alert">{retryError}</p>}
      {transfer?.state === "transferring" && (
        <div className="h-1 mx-2 mb-1 rounded-full bg-black/20 overflow-hidden">
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${(transfer.transferred / Math.max(1, transfer.size)) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
