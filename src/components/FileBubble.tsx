import { useEffect, useId, useRef, useState } from "react";
import { PREVIEWABLE_IMAGE, readImageMeta, sanitizeFileName, type ImageMeta } from "@ghostly/core";
import { useTransfer } from "../hooks/useServicesPlatform";
import { formatFileSize } from "../lib/format";
import { downloadFile } from "../lib/fileDownload";
import { canRetryFile, fileStatus, stalledAction } from "../lib/fileStatus";
import { knownPictureSize, pictureBox, PLACEHOLDER_BOX, rememberPictureSize, sameShape } from "../lib/pictureBox";
import type { FileAction } from "../lib/platform";
import { AvatarViewer } from "./AvatarViewer";
import { Highlight } from "./chat/ChatSearch";
import { RoundRetry, WhyButton, WhyText } from "./chat/RoundRetry";
import { useT } from "../contexts/I18nContext";
import type { ChatFile } from "../lib/types";

/** A press this long is the message's long press (`LONG_PRESS_MS` in MessageBubble.tsx), not a tap. */
const HELD_MS = 500;

const linkButton = "text-xs px-2.5 py-0.5 rounded-full bg-black/20 hover:bg-black/30 border-none text-inherit cursor-pointer transition-colors";

/** A file in the chat: progress while it travels, then a preview (images) and a way to save it. */
export function FileBubble({ file, peerName: named, highlight }: { file: ChatFile; peerName?: string; highlight?: string }) {
  const t = useT();
  const peerName = named ?? t("pairing.contact");
  const { platform, transfer, restoring } = useTransfer(file.id);
  /** The preview's object URL, for this file id. Kept while the bubble shows it: never revoked under the <img>. */
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const picture = PREVIEWABLE_IMAGE.test(file.mime);
  /** A picture's size found here (its first bytes, or as it loaded), when its sender said none or said wrong. */
  const [found, setFound] = useState<{ id: string; size: ImageMeta } | null>(null);
  /** The preview as it loaded, or that it could not be shown, for this URL. */
  const [loaded, setLoaded] = useState<{ url: string; ok: boolean } | null>(null);
  const [actionError, setActionError] = useState("");
  /** A resend or a request asked for, until the transfer answers by moving on. */
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const [missing, setMissing] = useState(false);
  /** The file is kept, but too large for this app to hand out: it is saved through the system instead. */
  const [saveOnly, setSaveOnly] = useState(false);
  // Right after a start the engine has not put its transfers back yet: a file still moving is not shown as finished.
  const settled = (transfer === null && !restoring) || transfer?.state === "done";
  // A transfer seen in progress ends with a little pop; files from history just show up.
  const [watched, setWatched] = useState(false);
  /** The picture open large (a tap on it). */
  const [viewing, setViewing] = useState(false);
  const opener = useRef<HTMLDivElement>(null);
  /** When a finger (or a pen) went down on the picture: held as long as a long press, its tap opens nothing. */
  const pressedAt = useRef<number | null>(null);
  useEffect(() => {
    if (transfer?.state === "transferring") setWatched(true);
  }, [transfer?.state]);
  useEffect(() => setBusy(false), [transfer?.state, transfer?.stalled]);

  // The sender holds its bytes from the start: its preview shows at once, not after the transfer. A received file is
  // read once it is all here. A small file can be announced before its transfer shows up: look again once it has.
  const readable = settled || file.id.includes("-out-");
  // Only while it is readable: a received file read before its transfer showed up (the app had just started) was a
  // part of it. Once the transfer shows it moving again that part is dropped, and read anew when it is all here.
  const blobUrl = preview?.id === file.id && readable ? preview.url : null;
  useEffect(() => {
    if (readable) return;
    setPreview(null);
    setSaveOnly(false);
  }, [readable]);
  useEffect(() => {
    if (!platform || !readable || blobUrl) return;
    let cancelled = false;
    void platform.getFile(file.id).then(async (blob) => {
      if (cancelled) return;
      if (!blob) {
        if (!settled) return;
        setSaveOnly(!!platform.saveFile && transfer?.state === "done");
        setMissing(!platform.saveFile || transfer?.state !== "done");
        return;
      }
      // Its sender said nothing of its size: read here from its first bytes, so the box is right before it shows.
      const size = picture && !file.image && !knownPictureSize(file.id) ? await readImageMeta(blob, file.mime) : undefined;
      if (cancelled) return;
      if (size) { rememberPictureSize(file.id, size); setFound({ id: file.id, size }); }
      setPreview({ id: file.id, url: URL.createObjectURL(blob) });
      setMissing(false);
      setSaveOnly(false);
    });
    return () => { cancelled = true; };
  }, [platform, file.id, file.mime, file.image, picture, readable, settled, transfer?.state, blobUrl]);
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

  // A picture's box is there before it is: from the size its sender said, else from what this device found, else
  // a placeholder while it looks. Nothing is reserved for a picture that will not show (failed, missing, awaiting
  // consent), and one that says it is one size but loads as another is shown as it loaded.
  const failedHere = transfer?.state === "failed" || missing || saveOnly || (loaded?.url === blobUrl && loaded?.ok === false);
  const awaiting = transfer?.state === "transferring" && transfer.stage === "asking";
  const size = (found?.id === file.id ? found.size : undefined) ?? file.image ?? knownPictureSize(file.id);
  const box = !picture || failedHere || awaiting ? null
    : size && (file.image || readable) ? pictureBox(size)
    : readable ? PLACEHOLDER_BOX : null;
  const onPictureLoad = (image: HTMLImageElement, url: string) => {
    const shown = { width: image.naturalWidth, height: image.naturalHeight };
    if (shown.width && shown.height && (!size || !sameShape(size, shown))) {
      rememberPictureSize(file.id, shown);
      setFound({ id: file.id, size: shown });
    }
    setLoaded({ url, ok: true });
  };

  /** The picture is drawn, so it can open large. */
  const drawn = !!blobUrl && loaded?.url === blobUrl && loaded.ok;
  const status = restoring ? t("chat.file.restoring", { size: formatFileSize(file.size) }) : fileStatus(file, transfer, named, missing, t);
  const moving = transfer?.state === "transferring";
  const controls = moving && !!transfer.direction && !!platform?.fileAction;
  const offered = controls && transfer.direction === "in" && transfer.stage === "asking";
  const pausedHere = moving && transfer.stage === "paused" && transfer.pausedBy !== "peer";
  const canPause = controls && !offered && !pausedHere && transfer.stage !== "verifying" && transfer.stage !== "preparing" && transfer.stage !== "asking";
  const canRetry = canRetryFile(file, transfer, platform);
  const stuck = platform?.fileAction ? stalledAction(transfer, t) : null;
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
    <div className="min-w-[220px] max-md:min-w-[min(220px,68vw)] max-w-[min(330px,72vw)]" data-testid="file-bubble" data-stage={transfer?.stage ?? transfer?.state ?? (restoring ? "restoring" : "done")}>
      {box && (
        <div data-testid="file-picture" data-box={size ? "sized" : "placeholder"}
          className={`rounded-[4px] overflow-hidden mb-1 ${blobUrl && loaded?.url === blobUrl ? "" : "bg-black/10"}`}
          style={{ width: box.width, maxWidth: "100%", aspectRatio: box.ratio }}>
          {blobUrl && (
            // A tap opens it large. Not a <button>: a long press on a control is not the message's long press (the
            // reactions' bar), and on a picture it must stay one; the tap that ends a long press opens nothing.
            <div ref={opener} role="button" tabIndex={drawn ? 0 : -1} aria-disabled={!drawn} data-testid="file-picture-open"
              aria-label={t("chat.file.viewPicture", { name: file.name })}
              onPointerDown={(event) => { pressedAt.current = event.pointerType === "mouse" ? null : event.timeStamp; }}
              onClick={(event) => {
                const held = pressedAt.current !== null && event.timeStamp - pressedAt.current >= HELD_MS;
                pressedAt.current = null;
                if (drawn && !held) setViewing(true);
              }}
              onKeyDown={(event) => { if (drawn && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setViewing(true); } }}
              className={`block w-full h-full ${drawn ? "cursor-zoom-in" : ""} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}>
              <img src={blobUrl} alt={file.name} className="block w-full h-full object-contain"
                onLoad={(event) => onPictureLoad(event.currentTarget, blobUrl)} onError={() => setLoaded({ url: blobUrl, ok: false })} />
            </div>
          )}
        </div>
      )}
      {viewing && blobUrl && <AvatarViewer picture src={blobUrl} name={file.name} returnFocus={opener} onClose={() => setViewing(false)} />}
      <div className="flex items-center gap-3 px-2 py-1.5">
        {canRetry ? (
          <RoundRetry danger busy={busy} testId="file-retry" label={t("chat.message.retry")} hint={t("chat.file.notSentHint")}
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
            <Highlight text={file.name} term={highlight} />
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
            title={t("common.save")}
            aria-label={t("common.save")}
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
            {t("chat.file.wantsToSend", { name: peerName, file: file.name, size: formatFileSize(file.size) })}
          </p>
          {typeof transfer.room === "number" && (
            <p className={`text-[11px] m-0 mb-1 ${transfer.room < file.size ? "text-danger-ink" : "text-text-primary/65"}`} data-testid="file-room">
              {transfer.room < file.size ? t("chat.file.noRoomDevice", { size: formatFileSize(transfer.room) }) : t("chat.file.roomDevice", { size: formatFileSize(transfer.room) })}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className="text-xs px-3 py-1 rounded-full bg-accent text-on-accent border-none cursor-pointer disabled:opacity-50"
              data-testid="file-accept" disabled={typeof transfer.room === "number" && transfer.room < file.size} onClick={() => act("accept")}>{t("chat.file.accept")}</button>
            <button type="button" className="text-xs px-3 py-1 rounded-full bg-black/20 text-inherit border-none cursor-pointer" data-testid="file-decline" onClick={() => act("decline")}>{t("chat.file.decline")}</button>
          </div>
        </div>
      )}
      {(controls && !offered) && (
        <div className="flex gap-1.5 px-2 pb-1">
          {canPause && <button type="button" className={linkButton} data-testid="file-pause" onClick={() => act("pause")}>{t("chat.file.pause")}</button>}
          {pausedHere && <button type="button" className={linkButton} data-testid="file-resume" onClick={() => act("resume")}>{t("chat.file.resume")}</button>}
          <button type="button" className={linkButton} data-testid="file-cancel" onClick={() => act("cancel")}>{t("common.cancel")}</button>
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
