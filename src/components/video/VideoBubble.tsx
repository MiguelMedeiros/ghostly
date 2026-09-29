import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { formatFileSize, formatVideoDuration, sanitizeFileName } from "@ghostly/core";
import { useChosenSpeaker } from "../../hooks/useChosenSpeaker";
import { useTransfer } from "../../hooks/useServicesPlatform";
import { downloadFile } from "../../lib/fileDownload";
import { canRetryFile, fileStatus, stalledAction } from "../../lib/fileStatus";
import type { FileAction } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { claimPlayback, registerVoicePlayer, releasePlayback } from "../../lib/voicePlayback";
import { openStoredMedia, type StoredMedia } from "../../lib/storedMedia";
import { canPlayVideo, videoBox, videoFormat as formatOf } from "../../lib/videoPlayer";
import { localPoster, posterUrl } from "../../lib/videoPoster";
import { RoundRetry, WhyButton, WhyText } from "../chat/RoundRetry";
import { useT } from "../../contexts/I18nContext";

type Phase = "poster" | "loading" | "playing";
type Problem = "unsupported" | "too-large" | "missing" | "not-yet";

const linkButton = "text-xs px-2.5 py-0.5 rounded-full bg-black/20 hover:bg-black/30 border-none text-inherit cursor-pointer transition-colors";

/**
 * A video in the chat. Before it plays: a poster (the sender's, or one made here once the file is in), its
 * length, and a big play button; a large one a person has to accept first shows "Download <size>"; one on its
 * way shows how far it got. A tap plays it in place with the browser's own controls (seek, time, volume, full
 * screen). One video or voice message plays at a time; a video scrolled out of view stops and lets go of its
 * bytes, and starts again from there. A type this device does not play offers the file instead.
 */
export function VideoBubble({ file, sender, peerName: named }: { file: ChatFile; sender: "me" | "peer"; peerName?: string }) {
  const t = useT();
  const peerName = named ?? t("pairing.contact");
  const { platform, transfer } = useTransfer(file.id);
  const ready = transfer === null || transfer.state === "done";
  const [playable] = useState(() => canPlayVideo(file.mime));
  const [phase, setPhase] = useState<Phase>("poster");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [local, setLocal] = useState<{ url: string; width: number; height: number; duration: number } | null>(null);
  /** On screen: true, off it: false, not known yet (no answer from the observer so far): null. */
  const [visible, setVisible] = useState<boolean | null>(() => (typeof IntersectionObserver === "undefined" ? true : null));
  /**
   * Full screen where the engine's own is off (Desktop on Linux: WebKitGTK aborts the app entering it): the window
   * goes full screen and the video fills it. Elsewhere the player's own Full screen button does it.
   */
  const [theater, setTheater] = useState(false);
  const canTheater = typeof document !== "undefined" && !document.fullscreenEnabled && !!platform?.fullscreenWindow;
  const [actionError, setActionError] = useState("");
  /** A resend or a request asked for, until the transfer answers by moving on. */
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const whyId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useChosenSpeaker(videoRef, phase === "playing" ? src : null);
  const srcRef = useRef<string | null>(null);
  /** The source playing: a blob URL, or a file the platform streams (released when it stops). */
  const sourceRef = useRef<StoredMedia | null>(null);
  /** A stream the player refused was tried again from the file's bytes, once. */
  const fellBack = useRef(false);
  const resumeAt = useRef(0);
  /** A play started by a tap: the element gets the keyboard once it is there. */
  const focusOnStart = useRef(false);

  const meta = file.video;
  const width = meta?.width ?? local?.width;
  const height = meta?.height ?? local?.height;
  const box = videoBox(width, height);
  const durationMs = meta?.duration ?? (local && Number.isFinite(local.duration) ? local.duration * 1000 : undefined);
  const poster = posterUrl(meta?.poster) ?? local?.url;

  // Is it on screen: a poster is made only for one that is, and one that leaves it stops.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), { rootMargin: "200px 0px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // No poster from the sender: one made here from the first frame, once the file is in.
  useEffect(() => {
    if (meta?.poster || !ready || !playable || !visible || !platform) return;
    let cancelled = false;
    void localPoster(file.id, () => platform.getFile(file.id)).then((made) => { if (!cancelled && made) setLocal(made); });
    return () => { cancelled = true; };
  }, [meta?.poster, ready, playable, visible, platform, file.id]);

  const unload = useCallback(() => {
    const video = videoRef.current;
    if (video) resumeAt.current = video.ended ? 0 : video.currentTime;
    video?.pause();
    releasePlayback(file.id);
    sourceRef.current?.release();
    sourceRef.current = null;
    srcRef.current = null;
    setSrc(null);
    setPhase("poster");
    setTheater(false);
  }, [file.id]);

  // In full screen: the window with it, until Escape, the exit button, or the video stopping for any reason.
  useEffect(() => {
    const fullscreen = theater ? platform?.fullscreenWindow : null;
    if (!fullscreen) return;
    void fullscreen(true).catch(() => {});
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setTheater(false); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      void fullscreen(false).catch(() => {});
    };
  }, [theater, platform]);

  const play = useCallback(async () => {
    if (!platform || phase === "loading") return;
    if (videoRef.current && srcRef.current) { void videoRef.current.play().catch(() => {}); return; }
    setProblem(null);
    setPhase("loading");
    claimPlayback(file.id);
    // Desktop streams its files from Rust, in ranges, as a video seeks; elsewhere the bytes come as a Blob. One on
    // its way from here plays from what the page holds.
    const source = await openStoredMedia(platform, file.id, file.mime, { bytes: !ready || fellBack.current });
    if (!source) {
      releasePlayback(file.id);
      setPhase("poster");
      // Desktop hands out a file only by saving it when nothing streams it; a file still being sent from here may
      // not be readable yet.
      setProblem(!ready ? "not-yet" : platform.saveFile ? "too-large" : "missing");
      return;
    }
    sourceRef.current = source;
    srcRef.current = source.url;
    setSrc(source.url);
    setPhase("playing");
  }, [platform, phase, file.id, file.mime, ready]);

  /** The player refused it: a stream is tried again from the file's bytes, once; anything else is unplayable here. */
  const refused = useCallback(() => {
    const retry = sourceRef.current?.streamed && !fellBack.current;
    const at = videoRef.current?.currentTime ?? 0;
    unload();
    if (!retry) { setProblem("unsupported"); return; }
    fellBack.current = true;
    resumeAt.current = at;
    void play();
  }, [unload, play]);
  const refusedRef = useRef(refused);
  refusedRef.current = refused;

  // The element is there: from where it was, and playing.
  useEffect(() => {
    const video = videoRef.current;
    if (phase !== "playing" || !video || !src) return;
    if (resumeAt.current > 0) video.currentTime = resumeAt.current;
    if (focusOnStart.current) { focusOnStart.current = false; rootRef.current?.focus(); }
    video.play().catch((error: Error) => {
      // Not allowed to start by itself: its controls are there for a tap.
      if (error?.name === "NotAllowedError" || error?.name === "AbortError") return;
      refusedRef.current();
    });
  }, [phase, src]);

  // Another video or voice message starts: this one stops and lets go of its bytes, so only one is ever held.
  useEffect(() => registerVoicePlayer(file.id, { play: () => void play(), pause: () => { if (srcRef.current) unload(); } }), [file.id, play, unload]);

  // Scrolled away: it stops, and its bytes go (a Blob in memory, or the platform stops serving the stream).
  useEffect(() => { if (visible === false && phase === "playing") unload(); }, [visible, phase, unload]);

  useEffect(() => () => {
    releasePlayback(file.id);
    sourceRef.current?.release();
    sourceRef.current = null;
    srcRef.current = null;
  }, [file.id]);

  useEffect(() => setBusy(false), [transfer?.state, transfer?.stalled]);

  const act = (action: FileAction) => {
    setActionError("");
    void platform?.fileAction?.(file.id, action).catch((error: Error) => setActionError(String(error.message ?? error)));
  };
  const save = () => {
    if (!platform) return;
    setActionError("");
    void downloadFile(platform, file, sanitizeFileName(file.name)).then((result) => { if (result === "missing") setProblem("missing"); })
      .catch((error: Error) => setActionError(String(error.message ?? error)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys on the box itself; the controls inside keep their own.
    if (event.target !== event.currentTarget) return;
    const video = videoRef.current;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!video) { if (ready && playable) void play(); return; }
      if (video.paused) void video.play().catch(() => {}); else video.pause();
    } else if (event.key === "Escape" && typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
  };

  const moving = transfer?.state === "transferring";
  const controls = moving && !!transfer.direction && !!platform?.fileAction;
  const offered = controls && transfer.direction === "in" && transfer.stage === "asking";
  const noRoom = offered && typeof transfer.room === "number" && transfer.room < file.size;
  const pausedHere = moving && transfer.stage === "paused" && transfer.pausedBy !== "peer";
  const canPause = controls && !offered && !pausedHere && transfer.stage !== "verifying" && transfer.stage !== "preparing" && transfer.stage !== "asking";
  const canRetry = canRetryFile(file, transfer, platform);
  const stuck = platform?.fileAction ? stalledAction(transfer, t) : null;
  const failed = transfer?.state === "failed";
  const status = moving || failed ? fileStatus(file, transfer, named, false, t) : null;
  // The engine's words (why it failed, why a click did not work) are behind the ⓘ, not in the bubble.
  const reason = actionError || (failed ? transfer.error : undefined);
  const again = (action: () => Promise<unknown>) => {
    setActionError("");
    setBusy(true);
    void action().catch((error: Error) => setActionError(String(error.message ?? error))).finally(() => setBusy(false));
  };
  const percent = moving ? Math.floor((transfer.transferred / Math.max(1, transfer.size)) * 100) : 0;
  // A video sent from here can be watched while it goes, once it has been copied.
  const canPlay = playable && (ready || (sender === "me" && transfer?.stage !== "preparing" && transfer?.state !== "failed"));
  const showRing = moving && !offered && !(sender === "me" && canPlay);

  const problemText = problem === "unsupported" ? t("chat.video.cantPlay", { format: formatOf(file.mime) })
    : problem === "too-large" ? t("chat.video.tooLarge")
    : problem === "missing" ? t("chat.file.gone")
    : problem === "not-yet" ? t("chat.media.notYet")
    : !playable && ready ? t("chat.video.cantPlay", { format: formatOf(file.mime) })
    : null;

  return (
    <div className="max-w-full" data-testid="video-bubble" data-stage={transfer?.stage ?? transfer?.state ?? "done"} data-phase={phase} data-playable={playable ? "true" : "false"}>
      <div
        ref={rootRef}
        tabIndex={phase === "playing" ? 0 : -1}
        role="group"
        aria-label={`Video, ${durationMs ? formatVideoDuration(durationMs) : formatFileSize(file.size)}`}
        onKeyDown={onKeyDown}
        className={`${theater ? "fixed inset-0 z-[2147483000] rounded-none" : "relative rounded-[4px] max-w-full"} overflow-hidden bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
        style={theater ? { width: "100vw", height: "100vh" } : { width: box.width, height: box.height }}
        data-testid="video-frame"
        data-theater={theater ? "true" : undefined}
      >
        {phase === "playing" && src ? (
          <>
            <video
              ref={videoRef}
              src={src}
              poster={poster}
              controls
              playsInline
              preload="auto"
              aria-label={file.name}
              data-testid="video-player"
              className="w-full h-full object-contain block bg-black"
              onPlay={() => claimPlayback(file.id)}
              onPause={() => releasePlayback(file.id)}
              onEnded={() => { resumeAt.current = 0; unload(); }}
              onError={refused}
            />
            {canTheater && (
              <button
                type="button"
                data-testid="video-fullscreen"
                aria-label={theater ? t("chat.video.exitFullScreen") : t("chat.video.fullScreen")}
                title={theater ? t("chat.video.exitFullScreen") : t("chat.video.fullScreen")}
                aria-pressed={theater}
                onClick={() => setTheater(!theater)}
                className="absolute top-[6px] end-[6px] w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center border-none cursor-pointer"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {theater
                    ? <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                    : <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />}
                </svg>
              </button>
            )}
          </>
        ) : (
          <>
            {poster ? (
              <img src={poster} alt="" data-testid="video-poster" className="w-full h-full object-contain block" draggable={false} />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-black/80 to-black/40" data-testid="video-blank" />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/10">
              {offered ? (
                <>
                  <button
                    type="button"
                    data-testid="video-accept"
                    disabled={noRoom}
                    onClick={() => act("accept")}
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 hover:bg-black/75 text-white text-[14px] font-medium border-none cursor-pointer disabled:opacity-50 disabled:cursor-default"
                  >
                    <DownloadIcon size={18} />
                    {t("chat.media.downloadSize", { size: formatFileSize(file.size) })}
                  </button>
                  <button type="button" data-testid="video-decline" onClick={() => act("decline")} className="text-[12px] text-white/90 underline bg-transparent border-none cursor-pointer">{t("chat.file.decline")}</button>
                </>
              ) : showRing ? (
                <ProgressRing percent={percent} paused={transfer?.stage === "paused" || transfer?.stage === "waiting" || !!transfer?.stalled} />
              ) : canPlay && !problem ? (
                <button
                  type="button"
                  data-testid="video-play"
                  aria-label={t("chat.video.play")}
                  disabled={phase === "loading"}
                  onClick={(event) => { focusOnStart.current = event.detail === 0; void play(); }}
                  className="w-14 h-14 rounded-full bg-black/55 hover:bg-black/70 text-white flex items-center justify-center border-none cursor-pointer disabled:opacity-60 disabled:cursor-default"
                >
                  {phase === "loading" ? <Spinner /> : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
                  )}
                </button>
              ) : null}
            </div>
            <span className="absolute bottom-[5px] start-[6px] inline-flex items-center gap-1 bg-[rgba(11,20,26,0.6)] text-white/90 rounded-full px-[7px] py-[2px] text-[11px] tabular-nums" data-testid="video-duration">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" /></svg>
              {durationMs ? formatVideoDuration(durationMs) : formatFileSize(file.size)}
            </span>
            {ready && (
              <button
                type="button"
                data-testid="video-save"
                title={t("common.save")}
                aria-label={t("chat.video.save")}
                onClick={save}
                className="absolute top-[6px] end-[6px] w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center border-none cursor-pointer"
              >
                <DownloadIcon size={16} />
              </button>
            )}
          </>
        )}
      </div>
      {offered && typeof transfer.room === "number" && (
        <p className={`text-[11px] m-0 mt-1 px-1 ${noRoom ? "text-danger-ink" : "text-text-primary/65"}`} data-testid="video-room">
          {noRoom ? t("chat.media.noRoom", { size: formatFileSize(transfer.room) }) : t("chat.media.wantsToSend", { name: peerName, size: formatFileSize(transfer.room) })}
        </p>
      )}
      {(status || canRetry || stuck) && !offered && (
        <div className="flex items-center gap-2 mt-1 px-1">
          {canRetry ? (
            <RoundRetry danger busy={busy} testId="video-retry" label={t("chat.message.retry")} hint={t("chat.file.notSentHint")}
              onClick={() => again(() => platform!.retryFile!(file.id))} />
          ) : stuck ? (
            <RoundRetry busy={busy} testId={`video-${stuck.action}`} label={stuck.label} hint={stuck.hint}
              onClick={() => again(() => platform!.fileAction!(file.id, stuck.action))} />
          ) : null}
          {status && (
            <p className={`flex items-center gap-1 min-w-0 text-[11px] m-0 ${failed ? "text-danger-ink" : "text-text-primary/65"}`}>
              <span className="min-w-0 truncate" data-testid="video-status">{status}</span>
              {reason && <WhyButton open={why} onToggle={() => setWhy(!why)} controls={whyId} testId="video-why" danger />}
            </p>
          )}
        </div>
      )}
      {controls && !offered && (
        <div className="flex gap-1.5 mt-1 px-1">
          {canPause && <button type="button" className={linkButton} data-testid="video-pause-transfer" onClick={() => act("pause")}>{t("chat.file.pause")}</button>}
          {pausedHere && <button type="button" className={linkButton} data-testid="video-resume-transfer" onClick={() => act("resume")}>{t("chat.file.resume")}</button>}
          <button type="button" className={linkButton} data-testid="video-cancel" onClick={() => act("cancel")}>{t("common.cancel")}</button>
        </div>
      )}
      {reason && why && <WhyText id={whyId} testId="video-why-text">{reason}</WhyText>}
      {problemText && (
        <p className={`text-[12px] m-0 mt-1 px-1 ${problem === "not-yet" ? "text-text-primary/65" : "text-danger-ink"}`} role={problem === "not-yet" ? undefined : "alert"} data-testid="video-problem">
          {problemText}{" "}
          {(problem === "unsupported" || problem === "too-large" || (!playable && ready)) && (
            <button type="button" data-testid="video-download" onClick={save} className="underline text-inherit bg-transparent border-none p-0 cursor-pointer text-[12px]">{t("chat.message.download")}</button>
          )}
        </p>
      )}
      {actionError && !status && <p className="text-xs text-danger-ink px-1 m-0" role="alert">{actionError}</p>}
    </div>
  );
}

function DownloadIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true" className="animate-spin">
      <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
    </svg>
  );
}

/** How much of it is here, around its percentage. */
function ProgressRing({ percent, paused }: { percent: number; paused: boolean }) {
  const t = useT();
  const radius = 22, circumference = 2 * Math.PI * radius;
  return (
    <div className="relative w-14 h-14 rounded-full bg-black/55 text-white flex items-center justify-center" data-testid="video-progress" role="progressbar" aria-label={t("chat.video.arriving")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <svg width="56" height="56" viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <circle cx="28" cy="28" r={radius} fill="none" stroke="currentColor" strokeOpacity={paused ? 0.5 : 1} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} className="transition-[stroke-dashoffset] duration-200" />
      </svg>
      <span className="text-[12px] font-medium tabular-nums">{percent}%</span>
    </div>
  );
}
