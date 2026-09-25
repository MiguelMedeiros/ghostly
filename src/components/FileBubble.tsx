import { useEffect, useState } from "react";
import { PREVIEWABLE_IMAGE } from "@ghostly/core";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { formatFileSize } from "../lib/format";
import { fileStatus } from "../lib/fileStatus";
import type { ChatFile } from "../lib/types";

const linkButton = "text-xs underline px-2 py-1 bg-transparent border-none text-inherit cursor-pointer";

/** A file in the chat: progress while it travels, then a preview (images) and a way to save it. */
export function FileBubble({ file, peerName = "Your contact" }: { file: ChatFile; peerName?: string }) {
  const platform = useServicesPlatform();
  const transfer = platform?.getTransfer(file.id) ?? null;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [missing, setMissing] = useState(false);
  /** The file is kept, but too large for this app to hand out: it is saved through the system instead. */
  const [saveOnly, setSaveOnly] = useState(false);
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
      if (!blob) {
        setSaveOnly(!!platform.saveFile && transfer?.state === "done");
        setMissing(!platform.saveFile || transfer?.state !== "done");
        return;
      }
      url = URL.createObjectURL(blob);
      setBlobUrl(url);
      setMissing(false);
      setSaveOnly(false);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [platform, file.id, settled, transfer?.state]);

  const act = (action: "accept" | "decline" | "pause" | "resume" | "cancel") => {
    setActionError("");
    void platform?.fileAction?.(file.id, action).catch((error: Error) => setActionError(String(error.message ?? error)));
  };
  const save = () => {
    setActionError("");
    void platform?.saveFile?.(file.id).then((saved) => { if (saved === null) setMissing(true); })
      .catch((error: Error) => setActionError(String(error.message ?? error)));
  };

  const status = fileStatus(file, transfer, peerName, missing);
  const moving = transfer?.state === "transferring";
  const controls = moving && !!transfer.direction && !!platform?.fileAction;
  const offered = controls && transfer.direction === "in" && transfer.stage === "asking";
  const pausedHere = moving && transfer.stage === "paused" && transfer.pausedBy !== "peer";
  const canPause = controls && !offered && !pausedHere && transfer.stage !== "verifying" && transfer.stage !== "preparing" && transfer.stage !== "asking";
  const canRetry = transfer?.state === "failed" && file.id.includes("-out-") && !!platform?.retryFile && (transfer.direction ? !!transfer.retry : true);

  return (
    <div className="min-w-[220px] max-md:min-w-[min(220px,68vw)] max-w-[min(330px,72vw)]" data-testid="file-bubble" data-stage={transfer?.stage ?? transfer?.state ?? "done"}>
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
        {(blobUrl || saveOnly) && (
          <a
            href={blobUrl ?? undefined}
            download={blobUrl ? file.name : undefined}
            onClick={blobUrl ? undefined : (event) => { event.preventDefault(); save(); }}
            role={blobUrl ? undefined : "button"}
            data-testid="file-save"
            className={`w-9 h-9 rounded-full bg-black/20 hover:bg-black/30 flex items-center justify-center shrink-0 text-inherit transition-colors cursor-pointer ${watched ? "animate-pop" : ""}`}
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
      {offered && (
        <div className="px-2 pb-1.5" data-testid="file-offer">
          <p className="text-[12px] m-0 mb-1">
            {peerName} wants to send {file.name} ({formatFileSize(file.size)}).
          </p>
          {typeof transfer.room === "number" && (
            <p className={`text-[11px] m-0 mb-1 ${transfer.room < file.size ? "text-danger-ink" : "text-text-primary/65"}`} data-testid="file-room">
              {transfer.room < file.size ? `Not enough space: ${formatFileSize(transfer.room)} free on this device` : `${formatFileSize(transfer.room)} free on this device`}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className="text-xs px-3 py-1 rounded-full bg-accent text-on-accent border-none cursor-pointer disabled:opacity-50"
              data-testid="file-accept" disabled={typeof transfer.room === "number" && transfer.room < file.size} onClick={() => act("accept")}>Accept</button>
            <button type="button" className="text-xs px-3 py-1 rounded-full bg-black/20 text-inherit border-none cursor-pointer" data-testid="file-decline" onClick={() => act("decline")}>Decline</button>
          </div>
        </div>
      )}
      {(controls && !offered) && (
        <div className="flex gap-1 px-1">
          {canPause && <button type="button" className={linkButton} data-testid="file-pause" onClick={() => act("pause")}>Pause</button>}
          {pausedHere && <button type="button" className={linkButton} data-testid="file-resume" onClick={() => act("resume")}>Resume</button>}
          <button type="button" className={linkButton} data-testid="file-cancel" onClick={() => act("cancel")}>Cancel</button>
        </div>
      )}
      {canRetry && (
        <button className="text-xs underline px-2 py-1" onClick={() => { setActionError(""); void platform!.retryFile!(file.id).catch(error => setActionError(String(error.message ?? error))); }}>Retry sending</button>
      )}
      {actionError && <p className="text-xs text-danger-ink px-2" role="alert">{actionError}</p>}
      {moving && transfer.stage !== "asking" && (
        <div className="h-1 mx-2 mb-1 rounded-full bg-black/20 overflow-hidden" data-testid="file-progress">
          <div
            className={`h-full transition-[width] duration-200 ${transfer.stage === "paused" || transfer.stage === "waiting" ? "bg-text-primary/40" : "bg-accent"}`}
            style={{ width: `${(transfer.transferred / Math.max(1, transfer.size)) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
