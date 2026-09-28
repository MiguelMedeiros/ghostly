import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatFileSize, formatVideoDuration, safeBlobType, sanitizeFileName } from "@ghostly/core";
import { useOptionalI18n } from "../../contexts/I18nContext";
import { useChosenSpeaker } from "../../hooks/useChosenSpeaker";
import { useServicesPlatform } from "../../hooks/useServicesPlatform";
import { languageTag } from "../../lib/documentLanguage";
import { downloadFile } from "../../lib/fileDownload";
import { canRetryFile, fileStatus, stalledAction } from "../../lib/fileStatus";
import type { FileAction } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { audioFormat, canPlayAudio } from "../../lib/videoPlayer";
import { applyVoiceRate, claimPlayback, onVoiceRate, registerVoicePlayer, releasePlayback, voiceRate } from "../../lib/voicePlayback";
import { claimMediaSession, mediaSessionPosition, mediaSessionState, releaseMediaSession, type MediaSessionPlayer } from "../../lib/mediaSession";
import { ProgressRing, RoundRetry, WhyButton, WhyText } from "../chat/RoundRetry";
import { SpeedPill } from "../voice/VoiceBubble";

type PlayState = "idle" | "loading" | "playing" | "paused";
type Problem = "unsupported" | "too-large" | "missing" | "not-yet";

const pill = "text-xs px-2.5 py-0.5 rounded-full bg-black/20 hover:bg-black/30 border-none text-inherit cursor-pointer transition-colors";

/**
 * An audio file in the chat (an MP3, an M4A, a FLAC: sent as a file, not recorded as a voice message): its name, a
 * play button, a seek bar, the time and, while it plays, the speed voice messages share. Its bytes are read only
 * when it first plays. One audio file, video or voice message plays at a time; the one that loses its turn lets
 * go of its bytes and goes on from where it was. A large one asks first ("Download 40.0 MB"); one this device
 * does not play offers Download.
 */
export function AudioBubble({ file, sender, peerName = "Your contact" }: { file: ChatFile; sender: "me" | "peer"; peerName?: string }) {
  const platform = useServicesPlatform();
  const locale = languageTag(useOptionalI18n()?.language ?? "en");
  const transfer = platform?.getTransfer(file.id) ?? null;
  const ready = transfer === null || transfer.state === "done";
  const [playable] = useState(() => canPlayAudio(file.mime));
  const [state, setPlayState] = useState<PlayState>("idle");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(voiceRate);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const whyId = useId();

  const audioRef = useRef<HTMLAudioElement>(null);
  useChosenSpeaker(audioRef, src);
  const playRef = useRef<HTMLButtonElement>(null);
  const srcRef = useRef<string | null>(null);
  const resumeAt = useRef(0);
  /** What the system's media controls call (lock screen, media keys): set on every render, below. */
  const mediaRef = useRef<MediaSessionPlayer | null>(null);

  useEffect(() => setBusy(false), [transfer?.state, transfer?.stalled]);
  useEffect(() => onVoiceRate((next) => {
    setRate(next);
    if (audioRef.current) applyVoiceRate(audioRef.current, next);
  }), []);

  const unload = useCallback(() => {
    const audio = audioRef.current;
    if (audio) { resumeAt.current = audio.ended ? 0 : audio.currentTime; audio.pause(); }
    releasePlayback(file.id);
    releaseMediaSession(file.id);
    if (srcRef.current) URL.revokeObjectURL(srcRef.current);
    srcRef.current = null;
    setSrc(null);
    const next: PlayState = resumeAt.current > 0 ? "paused" : "idle";
    setPlayState((was) => (was === "idle" ? was : next));
  }, [file.id, setPlayState]);

  const play = useCallback(async () => {
    if (!platform || state === "loading") return;
    claimPlayback(file.id);
    const audio = audioRef.current;
    if (audio && srcRef.current) {
      applyVoiceRate(audio, voiceRate());
      audio.play().catch(() => {});
      return;
    }
    setProblem(null);
    setPlayState("loading");
    const blob = await platform.getFile(file.id).catch(() => null);
    if (!blob) {
      releasePlayback(file.id);
      setPlayState("idle");
      setProblem(!ready ? "not-yet" : platform.saveFile ? "too-large" : "missing");
      return;
    }
    const type = safeBlobType(file.mime);
    const url = URL.createObjectURL(blob.type === type ? blob : blob.slice(0, blob.size, type));
    srcRef.current = url;
    setSrc(url);
  }, [platform, state, file.id, file.mime, ready, setPlayState, setProblem]);

  // The source is set: from where it was, at the shared speed, playing.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    if (resumeAt.current > 0) audio.currentTime = resumeAt.current;
    applyVoiceRate(audio, voiceRate());
    audio.play().catch((error: Error) => {
      if (error?.name === "NotAllowedError" || error?.name === "AbortError") { setPlayState("paused"); return; }
      unload();
      setPlayState("idle");
      setProblem("unsupported");
    });
  }, [src, unload]);

  // Another audio file, video or voice message starts: this one stops and lets go of its bytes.
  useEffect(() => registerVoicePlayer(file.id, { play: () => void play(), pause: () => { if (srcRef.current) unload(); } }), [file.id, play, unload]);

  useEffect(() => () => {
    releasePlayback(file.id);
    releaseMediaSession(file.id);
    if (srcRef.current) URL.revokeObjectURL(srcRef.current);
    srcRef.current = null;
  }, [file.id]);

  const pause = () => audioRef.current?.pause();
  const seek = (to: number) => {
    const clamped = Math.max(0, Math.min(duration || 0, to));
    setPosition(clamped);
    resumeAt.current = clamped;
    if (audioRef.current && srcRef.current) audioRef.current.currentTime = clamped;
  };
  mediaRef.current = { title: file.name, artist: sender === "me" ? "You" : peerName, play: () => void play(), pause, seekTo: seek };

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
  const again = (action: () => Promise<unknown>) => {
    setActionError("");
    setBusy(true);
    void action().catch((error: Error) => setActionError(String(error.message ?? error))).finally(() => setBusy(false));
  };

  const moving = transfer?.state === "transferring";
  const controls = moving && !!transfer.direction && !!platform?.fileAction;
  const offered = controls && transfer.direction === "in" && transfer.stage === "asking";
  const noRoom = offered && typeof transfer.room === "number" && transfer.room < file.size;
  const pausedHere = moving && transfer.stage === "paused" && transfer.pausedBy !== "peer";
  const canPause = controls && !offered && !pausedHere && transfer.stage !== "verifying" && transfer.stage !== "preparing" && transfer.stage !== "asking";
  const canRetry = canRetryFile(file, transfer, platform);
  const stuck = platform?.fileAction ? stalledAction(transfer) : null;
  const failed = transfer?.state === "failed";
  const status = (moving && !offered) || failed ? fileStatus(file, transfer, peerName, false) : null;
  const reason = actionError || (failed ? transfer.error : undefined);
  // One sent from here can be listened to while it goes, once it has been copied.
  const canPlay = playable && (ready || (sender === "me" && transfer?.stage !== "preparing" && !failed));
  const arriving = moving && !offered && !(sender === "me" && canPlay);
  const active = state === "playing" || state === "paused" || position > 0;
  const known = duration > 0;

  const problemText = problem === "unsupported" || (!playable && ready) ? `This device can't play this audio (${audioFormat(file.mime)}). Download it to listen.`
    : problem === "too-large" ? "Too large to play here. Download it to listen."
    : problem === "missing" ? "No longer available"
    : problem === "not-yet" ? "It plays once it has been sent."
    : null;

  return (
    <div className="w-[300px] max-w-full pt-1" data-testid="audio-bubble" data-state={state} data-playable={playable ? "true" : "false"} data-stage={transfer?.stage ?? transfer?.state ?? "done"}>
      <div className="flex items-center gap-2">
        {canRetry ? (
          <RoundRetry danger busy={busy} testId="audio-retry" label="Send again" hint="Not sent. Send it again." onClick={() => again(() => platform!.retryFile!(file.id))} />
        ) : stuck ? (
          <RoundRetry busy={busy} testId={`audio-${stuck.action}`} label={stuck.label} hint={stuck.hint} onClick={() => again(() => platform!.fileAction!(file.id, stuck.action))} />
        ) : (
          <span className="relative w-9 h-9 shrink-0">
            <button
              ref={playRef}
              type="button"
              data-testid="audio-play"
              aria-label={state === "playing" ? "Pause audio" : "Play audio"}
              disabled={!canPlay || !!problem || state === "loading"}
              onClick={() => (state === "playing" ? pause() : void play())}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-black/20 border-none text-text-primary/90 cursor-pointer disabled:opacity-40 disabled:cursor-default hover:bg-black/30"
            >
              {state === "playing" ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
              )}
            </button>
            {arriving && <ProgressRing fraction={transfer.transferred / Math.max(1, transfer.size)} testId="audio-progress" />}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] leading-tight truncate m-0" title={file.name} data-testid="audio-name"><bdi>{file.name}</bdi></p>
          <input
            type="range"
            data-testid="audio-seek"
            aria-label="Position in audio"
            aria-valuetext={`${formatVideoDuration(position * 1000)} of ${formatVideoDuration(duration * 1000)}`}
            min={0}
            max={known ? duration : 1}
            step="any"
            value={known ? position : 0}
            disabled={!known}
            onChange={(event) => seek(Number(event.currentTarget.value))}
            className="block w-full h-3 my-0.5 accent-accent cursor-pointer disabled:cursor-default disabled:opacity-50"
          />
          <div className="flex items-center gap-1.5 h-[18px] text-[11px] text-text-primary/65" data-testid="audio-meta">
            {active && <SpeedPill rate={rate} locale={locale} onGone={() => playRef.current?.focus()} />}
            <span className="tabular-nums" data-testid="audio-time">
              {known ? `${formatVideoDuration(position * 1000)} / ${formatVideoDuration(duration * 1000)}` : formatFileSize(file.size)}
            </span>
            {status && <span data-testid="audio-status" className={`min-w-0 truncate ${failed ? "text-danger-ink" : ""}`}>· <bdi>{status}</bdi></span>}
            {reason && <WhyButton open={why} onToggle={() => setWhy(!why)} controls={whyId} testId="audio-why" danger />}
          </div>
        </div>
        {ready && (
          <button type="button" data-testid="audio-save" title="Save" aria-label="Save audio" onClick={save}
            className="w-8 h-8 rounded-full bg-black/20 hover:bg-black/30 flex items-center justify-center shrink-0 text-inherit border-none cursor-pointer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        )}
      </div>
      {offered && (
        <div className="mt-1.5 px-1" data-testid="audio-offer">
          <div className="flex items-center gap-2">
            <button type="button" data-testid="audio-accept" disabled={noRoom} onClick={() => act("accept")}
              className="text-xs px-3 py-1 rounded-full bg-accent text-on-accent border-none cursor-pointer disabled:opacity-50 disabled:cursor-default">
              Download {formatFileSize(file.size)}
            </button>
            <button type="button" data-testid="audio-decline" onClick={() => act("decline")} className={pill}>Decline</button>
          </div>
          {typeof transfer.room === "number" && (
            <p className={`text-[11px] m-0 mt-1 ${noRoom ? "text-danger-ink" : "text-text-primary/65"}`} data-testid="audio-room">
              {noRoom ? `Not enough space: ${formatFileSize(transfer.room)} free` : `${peerName} wants to send it · ${formatFileSize(transfer.room)} free`}
            </p>
          )}
        </div>
      )}
      {controls && !offered && (
        <div className="flex gap-1.5 mt-1 px-1">
          {canPause && <button type="button" className={pill} data-testid="audio-pause-transfer" onClick={() => act("pause")}>Pause</button>}
          {pausedHere && <button type="button" className={pill} data-testid="audio-resume-transfer" onClick={() => act("resume")}>Resume</button>}
          <button type="button" className={pill} data-testid="audio-cancel" onClick={() => act("cancel")}>Cancel</button>
        </div>
      )}
      {reason && why && <WhyText id={whyId} testId="audio-why-text">{reason}</WhyText>}
      {problemText && (
        <p className={`text-[12px] m-0 mt-1 px-1 ${problem === "not-yet" ? "text-text-primary/65" : "text-danger-ink"}`} role={problem === "not-yet" ? undefined : "alert"} data-testid="audio-problem">
          {problemText}{" "}
          {(problem === "unsupported" || problem === "too-large" || (!playable && ready)) && (
            <button type="button" data-testid="audio-download" onClick={save} className="underline text-inherit bg-transparent border-none p-0 cursor-pointer text-[12px]">Download</button>
          )}
        </p>
      )}
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="auto"
          data-testid="audio-element"
          onLoadedMetadata={(event) => { const d = event.currentTarget.duration; if (Number.isFinite(d)) setDuration(d); }}
          onDurationChange={(event) => { const d = event.currentTarget.duration; if (Number.isFinite(d)) setDuration(d); }}
          onTimeUpdate={(event) => {
            const audio = event.currentTarget;
            setPosition(audio.currentTime);
            mediaSessionPosition(file.id, audio.currentTime, audio.duration, audio.playbackRate);
          }}
          onPlay={() => {
            claimPlayback(file.id);
            setPlayState("playing");
            // The lock screen and media keys drive the one playing now.
            const shown = mediaRef.current!;
            claimMediaSession(file.id, { title: shown.title, artist: shown.artist, play: () => mediaRef.current?.play(), pause: () => mediaRef.current?.pause(), seekTo: (at) => mediaRef.current?.seekTo(at) });
          }}
          onPause={() => { releasePlayback(file.id); mediaSessionState(file.id, "paused"); setPlayState((was) => (was === "playing" ? "paused" : was)); }}
          onEnded={() => { resumeAt.current = 0; setPosition(0); unload(); setPlayState("idle"); }}
          onError={() => { unload(); setPlayState("idle"); setProblem("unsupported"); }}
        />
      )}
    </div>
  );
}
