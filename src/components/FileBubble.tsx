import { useEffect, useId, useState } from "react";
import { PREVIEWABLE_IMAGE, sanitizeFileName } from "@ghostly/core";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { formatFileSize } from "../lib/format";
import { downloadFile } from "../lib/fileDownload";
import { canRetryFile, fileStatus, stalledAction } from "../lib/fileStatus";
import type { FileAction } from "../lib/platform";
import { RoundRetry, WhyButton, WhyText } from "./chat/RoundRetry";
import type { ChatFile } from "../lib/types";

const linkButton = "text-xs px-2.5 py-0.5 rounded-full bg-black/20 hover:bg-black/30 border-none text-inherit cursor-pointer transition-colors";

/** A file in the chat: progress while it travels, then a preview (images) and a way to save it. */
export function FileBubble({ file, peerName = "Your contact" }: { file: ChatFile; peerName?: string }) {
  const platform = useServicesPlatform();
  const transfer = platform?.getTransfer(file.id) ?? null;
  /** The preview's object URL, for this file id. Kept while the bubble shows it: never revoked under the <img>. */
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const blobUrl = preview?.id === file.id ? preview.url : null;
  const [actionError, setActionError] = useState("");
  /** A resend or a request asked for, until the transfer answers by moving on. */
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const [missing, setMissing] = useState(false);
  /** The file is kept, but too large for this app to hand out: it is saved through the system instead. */
  const [saveOnly, setSaveOnly] = useState(false);
  const settled = transfer === null || transfer.state === "done";
  // A transfer seen in progress ends with a little pop; files from history just show up.
  const [watched, setWatched] = useState(false);
  useEffect(() => {
    if (transfer?.state === "transferring") setWatched(true);
  }, [transfer?.state]);
  useEffect(() => setBusy(false), [transfer?.state, transfer?.stalled]);

  // The sender holds its bytes from the start: its preview shows at once, not after the transfer. A received file is
  // read once it is all here. A small file can be announced before its transfer shows up: look again once it has.
  const readable = settled || file.id.includes("-out-");
  useEffect(() => {
    if (!platform || !readable || blobUrl) return;
    let cancelled = false;
    void platform.getFile(file.id).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        if (!settled) return;
        setSaveOnly(!!platform.saveFile && transfer?.state === "done");
        setMissing(!platform.saveFile || transfer?.state !== "done");
        return;
      }
      setPreview({ id: file.id, url: URL.createObjectURL(blob) });
      setMissing(false);
      setSaveOnly(false);
    });
    return () => { cancelled = true; };
  }, [platform, file.id, readable, settled, transfer?.state, blobUrl]);
  // Revoked only once nothing shows it: another file in this bubble, or the bubble gone.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const act = (action: FileAction) => {
    setActionError("");
    void platform?.fileAction?.(file.id, action).catch((error: Error) => setActionError(String(error.message ?? error)));
  };
  /** The same path as Download in the message's menu: the system's save dialog where there is one, else a download. */
  const save = () => {
    if (!platform) return;
    setActionError("");
    void downloadFile(platform, file, sanitizeFileName(file.name)).then((result) => { if (result === "missing") setMissing(true); })
      .catch((error: Error) => setActionError(String(error.message ?? error)));
  };

  const status = fileStatus(file, transfer, peerName, missing);
  const moving = transfer?.state === "transferring";
  const controls = moving && !!transfer.direction && !!platform?.fileAction;
  const offered = controls && transfer.direction === "in" && transfer.stage === "asking";
  const pausedHere = moving && transfer.stage === "paused" && transfer.pausedBy !== "peer";
  const canPause = controls && !offered && !pausedHere && transfer.stage !== "verifying" && transfer.stage !== "preparing" && transfer.stage !== "asking";
  const canRetry = canRetryFile(file, transfer, platform);
  const stuck = platform?.fileAction ? stalledAction(transfer) : null;
  const failed = transfer?.state === "failed";
  // The engine's words (why it failed, why a click did not work) are behind the ⓘ, not in the bubble.
  const reason = actionError || (failed ? transfer.error : undefined);
  const again = (action: () => Promise<unknown>) => {
    setActionError("");
    setBusy(true);
    // The ring turns until the transfer moves, or the request comes back without moving it.
    void action().catch((error: Error) => setActionError(String(error.message ?? error))).finally(() => setBusy(false));
  };

  return (
    <div className="min-w-[220px] max-md:min-w-[min(220px,68vw)] max-w-[min(330px,72vw)]" data-testid="file-bubble" data-stage={transfer?.stage ?? transfer?.state ?? "done"}>
      {blobUrl && PREVIEWABLE_IMAGE.test(file.mime) && (
        <img src={blobUrl} alt={file.name} className="rounded-[4px] max-w-full max-h-[330px] object-contain block mb-1" />
      )}
      <div className="flex items-center gap-3 px-2 py-1.5">
        {canRetry ? (
          <RoundRetry danger busy={busy} testId="file-retry" label="Send again" hint="Not sent. Send it again."
            onClick={() => again(() => platform!.retryFile!(file.id))} />
        ) : stuck ? (
          <RoundRetry busy={busy} testId={`file-${stuck.action}`} label={stuck.label} hint={stuck.hint}
            onClick={() => again(() => platform!.fileAction!(file.id, stuck.action))} />
        ) : (
          <span className="w-9 h-9 rounded-full bg-black/20 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-tight truncate m-0" title={file.name}>
            {file.name}
          </p>
          <p className={`flex items-center gap-1 text-[11px] m-0 ${failed || missing ? "text-danger-ink" : "text-text-primary/65"}`}>
            <span className="min-w-0 truncate" data-testid="file-status">{status}</span>
            {reason && <WhyButton open={why} onToggle={() => setWhy(!why)} controls={whyId} testId="file-why" danger />}
          </p>
        </div>
        {(blobUrl || saveOnly) && (
          <a
            href={blobUrl ?? undefined}
            download={blobUrl ? file.name : undefined}
            onClick={(event) => { event.preventDefault(); save(); }}
            role="button"
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
        <div className="flex gap-1.5 px-2 pb-1">
          {canPause && <button type="button" className={linkButton} data-testid="file-pause" onClick={() => act("pause")}>Pause</button>}
          {pausedHere && <button type="button" className={linkButton} data-testid="file-resume" onClick={() => act("resume")}>Resume</button>}
          <button type="button" className={linkButton} data-testid="file-cancel" onClick={() => act("cancel")}>Cancel</button>
        </div>
      )}
      {reason && why && <WhyText id={whyId} testId="file-why-text">{reason}</WhyText>}
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
