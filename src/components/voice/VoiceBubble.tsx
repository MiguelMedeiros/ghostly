import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatVoiceDuration, type VoiceMeta } from "@ghostly/core";
import { useOptionalI18n } from "../../contexts/I18nContext";
import { useTransfer } from "../../hooks/useServicesPlatform";
import { languageTag } from "../../lib/documentLanguage";
import { canRetryFile, fileStatus, stalledAction } from "../../lib/fileStatus";
import type { ChatFile } from "../../lib/types";
import {
  applyVoiceRate,
  claimPlayback,
  formatVoiceRate,
  isVoicePlayed,
  markVoicePlayed,
  nextVoiceRate,
  onVoiceRate,
  playNextVoice,
  registerVoicePlayer,
  releasePlayback,
  voiceRate,
} from "../../lib/voicePlayback";
import { decodeToWav } from "../../lib/voiceDecode";
import { followSpeaker } from "../../lib/mediaDevices";
import { claimMediaSession, mediaSessionPosition, mediaSessionState, releaseMediaSession, type MediaSessionPlayer } from "../../lib/mediaSession";
import { ProgressRing, RoundRetry, WhyButton, WhyText } from "../chat/RoundRetry";
import { Waveform } from "./Waveform";
import "./voice.css";

type PlayState = "idle" | "loading" | "playing" | "paused";

const FORMATS: Record<string, string> = { "audio/webm": "WebM", "audio/ogg": "Ogg", "audio/mp4": "M4A", "audio/x-m4a": "M4A", "audio/mpeg": "MP3", "audio/aac": "AAC", "audio/wav": "WAV" };
const formatOf = (mime: string) => FORMATS[mime.split(";")[0]!.trim().toLowerCase()] ?? (mime || "unknown");

/** What went wrong, for whoever debugs the next failure: the console in dev builds, `data-error` always. */
function describeFailure(what: string, error: unknown): string {
  if (typeof MediaError !== "undefined" && error instanceof MediaError) return `${what}: MediaError ${error.code}${error.message ? ` (${error.message})` : ""}`;
  if (error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException)) return `${what}: ${(error as Error).name}${(error as Error).message ? ` (${(error as Error).message})` : ""}`;
  return `${what}: ${String(error)}`;
}

/**
 * A voice message in the chat: play and pause, a waveform that fills as it plays and can be
 * tapped or dragged to move, the time, a speed shared by every voice message, and — for one
 * received — a mark until it has been listened to. The bytes are read only when it first
 * plays; the waveform was measured by the sender, so nothing is decoded to draw it.
 */
export function VoiceBubble({ file, sender, peerName = "Your contact" }: { file: ChatFile & { voice: VoiceMeta }; sender: "me" | "peer"; peerName?: string }) {
  const { platform, transfer } = useTransfer(file.id);
  const locale = languageTag(useOptionalI18n()?.language ?? "en");
  const ready = transfer === null || transfer.state === "done";
  const seconds = file.voice.duration / 1000;

  const [state, setState] = useState<PlayState>("idle");
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(voiceRate);
  const [played, setPlayed] = useState(() => sender === "me" || isVoicePlayed(file.id));
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saveUrl, setSaveUrl] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  /** A resend or a request asked for, until the transfer answers by moving on. */
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const whyId = useId();
  useEffect(() => setBusy(false), [transfer?.state, transfer?.stalled]);

  const rootRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Stops the player following the speaker chosen in Settings. */
  const speakerRef = useRef<(() => void) | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const urlsRef = useRef<string[]>([]);
  const frameRef = useRef(0);
  const positionRef = useRef(0);
  const loadingRef = useRef<Promise<HTMLAudioElement | null> | null>(null);
  /** A play() is being started: its own rejection reports what went wrong, not the element's error event. */
  const startingRef = useRef(false);
  /** Whether the recording is already playing from a WAV decoded from it (the fallback, tried once). */
  const decodedRef = useRef(false);
  /** What the system's media controls call: set on every render, below, once every function it names exists. */
  const mediaRef = useRef<MediaSessionPlayer | null>(null);

  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  };

  const report = useCallback((what: string, error: unknown) => {
    const detail = describeFailure(what, error);
    setFailure(detail);
    if (import.meta.env.DEV) console.warn(`[voice] ${detail}`, { file: file.id, mime: file.mime, decoded: decodedRef.current });
  }, [file.id, file.mime]);

  /** It will not play here: say so plainly, and offer the file to save. */
  const giveUp = useCallback((message: string) => {
    if (blobRef.current) setSaveUrl((url) => url ?? objectUrl(blobRef.current!));
    setProblem(message);
  }, []);
  const cannotPlayHere = useCallback(
    () => giveUp(`This device can't play this recording (${formatOf(file.mime)}). Save it to play it elsewhere.`),
    [giveUp, file.mime],
  );

  const showProgress = useCallback((at: number) => {
    positionRef.current = at;
    waveRef.current?.style.setProperty("--voice-progress", String(Math.min(1, Math.max(0, at / Math.max(0.001, seconds)))));
  }, [seconds]);

  const stopFrames = () => cancelAnimationFrame(frameRef.current);
  const followAudio = useCallback(() => {
    stopFrames();
    const tick = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      showProgress(audio.currentTime);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [showProgress]);

  /** The recording decoded by Web Audio and played as WAV, when `<audio>` has no decoder for its own type. Once. */
  const switchToDecoded = useCallback(async (audio: HTMLAudioElement): Promise<boolean> => {
    if (decodedRef.current || !blobRef.current) return false;
    decodedRef.current = true;
    const wav = await decodeToWav(blobRef.current);
    if (!wav) { report("decode", new Error("Web Audio could not decode it either")); return false; }
    audio.src = objectUrl(wav);
    audio.load();
    return true;
  }, [report]);

  /** The player, made on first use: reading the bytes of every voice message on screen would be waste. */
  const load = useCallback((): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return Promise.resolve(audioRef.current);
    loadingRef.current ??= (async () => {
      const blob = await platform?.getFile(file.id);
      if (!blob) { setProblem("No longer available"); return null; }
      blobRef.current = blob;
      const audio = new Audio();
      audio.preload = "auto";
      if (audio.canPlayType(file.mime)) {
        audio.src = objectUrl(blob);
      } else if (!(await switchToDecoded(audio))) {
        // No decoder for this type at all (AAC on a Linux desktop without one): it can still be saved.
        cannotPlayHere();
        return null;
      }
      applyVoiceRate(audio, voiceRate());
      audio.addEventListener("timeupdate", () => {
        setPosition(audio.currentTime);
        mediaSessionPosition(file.id, audio.currentTime, seconds, audio.playbackRate);
      });
      audio.addEventListener("ended", () => {
        stopFrames();
        releasePlayback(file.id);
        setState("idle");
        setPosition(0);
        showProgress(0);
        audio.currentTime = 0;
        releaseMediaSession(file.id);
        playNextVoice(rootRef.current);
      });
      audio.addEventListener("pause", () => { stopFrames(); setState((s) => (s === "playing" ? "paused" : s)); mediaSessionState(file.id, "paused"); });
      audio.addEventListener("error", () => {
        report("media element", audio.error);
        if (startingRef.current) return;
        // Broke off while playing.
        stopFrames();
        releasePlayback(file.id);
        setState("idle");
        giveUp("Could not play this recording.");
      });
      const speaker = followSpeaker(audio);
      speakerRef.current = speaker.stop;
      await speaker.ready;
      audioRef.current = audio;
      return audio;
    })().finally(() => { loadingRef.current = null; });
    return loadingRef.current;
  }, [platform, file.id, file.mime, seconds, showProgress, report, giveUp, cannotPlayHere, switchToDecoded]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    releasePlayback(file.id);
  }, [file.id]);

  /** Starts `audio` where the waveform says; on a refusal, tries the decoded WAV once. Resolves whether it plays. */
  const start = useCallback(async (audio: HTMLAudioElement): Promise<boolean> => {
    startingRef.current = true;
    try {
      for (;;) {
        if (Math.abs(audio.currentTime - positionRef.current) > 0.05) audio.currentTime = positionRef.current;
        applyVoiceRate(audio, voiceRate());
        try {
          await audio.play();
          return true;
        } catch (error) {
          const name = (error as Error | undefined)?.name;
          // Paused or moved on before it started: nothing went wrong.
          if (name === "AbortError") return false;
          report("play()", error);
          // Not allowed to start by itself (the next one in a run, on a strict engine): a tap will do.
          if (name === "NotAllowedError") return false;
          // Refused as it is: its type may still decode through Web Audio.
          const decodedAlready = decodedRef.current;
          if (!decodedAlready && (await switchToDecoded(audio))) continue;
          if (decodedAlready) giveUp("Could not play this recording.");
          else cannotPlayHere();
          return false;
        }
      }
    } finally {
      startingRef.current = false;
    }
  }, [report, switchToDecoded, cannotPlayHere, giveUp]);

  const play = useCallback(async () => {
    if (!ready) return;
    claimPlayback(file.id);
    setProblem(null);
    setState("loading");
    const audio = await load();
    if (!audio) { releasePlayback(file.id); setState("idle"); return; }
    // Played to the end last time, or scrubbed while stopped: start from where the waveform says.
    if (positionRef.current >= seconds - 0.05) showProgress(0);
    if (!(await start(audio))) {
      releasePlayback(file.id);
      setState("idle");
      return;
    }
    setState("playing");
    followAudio();
    // The lock screen and media keys drive the one playing now (through `mediaRef`, always this render's functions).
    claimMediaSession(file.id, {
      title: "Voice message",
      artist: sender === "me" ? "You" : peerName,
      play: () => mediaRef.current?.play(),
      pause: () => mediaRef.current?.pause(),
      seekTo: (at) => mediaRef.current?.seekTo(at),
      next: () => mediaRef.current?.next?.(),
    });
    mediaSessionPosition(file.id, audio.currentTime, seconds, audio.playbackRate);
    if (sender === "peer" && !played) { markVoicePlayed(file.id); setPlayed(true); }
  }, [ready, file.id, load, seconds, showProgress, start, followAudio, sender, played, peerName]);

  useEffect(() => registerVoicePlayer(file.id, { play: () => void play(), pause }), [file.id, play, pause]);
  useEffect(() => onVoiceRate((next) => {
    setRate(next);
    if (audioRef.current) applyVoiceRate(audioRef.current, next);
  }), []);
  useEffect(() => () => {
    stopFrames();
    releasePlayback(file.id);
    releaseMediaSession(file.id);
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    speakerRef.current?.();
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, [file.id]);

  const seekTo = useCallback((at: number) => {
    const clamped = Math.min(seconds, Math.max(0, at));
    showProgress(clamped);
    setPosition(clamped);
    if (audioRef.current) audioRef.current.currentTime = clamped;
  }, [seconds, showProgress]);

  mediaRef.current = { title: "", play: () => void play(), pause, seekTo, next: () => void playNextVoice(rootRef.current) };

  const scrubbing = useRef(false);
  const fractionAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? (event.clientX - box.left) / box.width : 0;
  };
  const onScrubStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || event.button !== 0) return;
    scrubbing.current = true;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no pointer to hold */ }
    seekTo(fractionAt(event) * seconds);
  };
  const onScrubMove = (event: PointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) seekTo(fractionAt(event) * seconds);
  };
  const onScrubEnd = () => { scrubbing.current = false; };
  const onWaveKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = Math.max(1, seconds / 20);
    const to = { ArrowRight: positionRef.current + step, ArrowUp: positionRef.current + step, ArrowLeft: positionRef.current - step, ArrowDown: positionRef.current - step, Home: 0, End: seconds }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    seekTo(to);
  };

  const active = state === "playing" || state === "paused" || position > 0;
  const unplayed = sender === "peer" && !played;
  let status: string | null = null;
  // Where it stands, as a file says it: "Waiting for connection", "Not moving", never a bare 0% that looks alive.
  if (transfer?.state === "transferring" || transfer?.state === "failed") status = fileStatus(file, transfer, peerName, false);
  // One of mine that has not started for want of a connection: the clock beside the time says it.
  if (sender === "me" && transfer?.state === "transferring" && transfer.stage === "waiting" && transfer.transferred === 0) status = null;
  const stuck = platform?.fileAction ? stalledAction(transfer) : null;
  const failed = transfer?.state === "failed";
  const canRetry = canRetryFile(file, transfer, platform);
  // The engine's words (why it failed, why a click did not work) are behind the ⓘ, not in the bubble.
  const reason = retryError || (failed ? transfer.error : undefined);
  const moving = transfer?.state === "transferring" && !transfer.stalled;
  const run = (action: () => Promise<unknown>) => {
    setRetryError("");
    setBusy(true);
    // The ring turns until the transfer moves, or the request comes back without moving it.
    void action().catch((error: Error) => setRetryError(String(error.message ?? error))).finally(() => setBusy(false));
  };

  return (
    <div
      ref={rootRef}
      // As wide as a comfortable waveform, never wider than the message bubble it sits in (whose own limit
      // is a share of the chat, not of the window: vw here spilled it out of a narrow Desktop window).
      // Its colours are light in both themes: message bubbles are dark in both (MessageBubble).
      className="w-[300px] max-w-full pt-1"
      data-testid="voice-bubble"
      data-voice-player={file.id}
      data-voice-sender={sender}
      data-state={state}
      data-played={played ? "true" : "false"}
      style={{ ["--voice-fill" as string]: sender === "me" ? "var(--color-text-primary)" : "var(--color-accent-hover)" }}
    >
      <div className="flex items-center gap-1.5">
        {canRetry ? (
          <RoundRetry danger busy={busy} testId="voice-retry" label="Send again" hint="Not sent. Send it again."
            onClick={() => run(() => platform!.retryFile!(file.id))} />
        ) : stuck ? (
          <RoundRetry busy={busy} testId={`voice-${stuck.action}`} label={stuck.label} hint={stuck.hint}
            onClick={() => run(() => platform!.fileAction!(file.id, stuck.action))} />
        ) : (
          <span className="relative w-9 h-9 shrink-0">
            <button
              ref={playRef}
              type="button"
              data-testid="voice-play"
              aria-label={state === "playing" ? "Pause voice message" : "Play voice message"}
              disabled={!ready || state === "loading"}
              onClick={() => (state === "playing" ? pause() : void play())}
              className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-transparent border-none text-text-primary/90 cursor-pointer disabled:opacity-40 disabled:cursor-default hover:bg-black/15"
            >
              {state === "playing" ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
              )}
            </button>
            {moving && <ProgressRing fraction={transfer.transferred / Math.max(1, transfer.size)} testId="voice-progress" />}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <Waveform
            ref={waveRef}
            peaks={file.voice.peaks}
            knob
            role="slider"
            tabIndex={ready ? 0 : -1}
            aria-label="Position in voice message"
            aria-valuemin={0}
            aria-valuemax={Math.round(seconds)}
            aria-valuenow={Math.round(position)}
            aria-valuetext={`${formatVoiceDuration(position * 1000)} of ${formatVoiceDuration(file.voice.duration)}`}
            data-testid="voice-waveform"
            className={ready ? "cursor-pointer" : "opacity-50"}
            onPointerDown={onScrubStart}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubEnd}
            onPointerCancel={onScrubEnd}
            onKeyDown={onWaveKey}
          />
          {/* One line under the waveform, all inside the bubble: what it is and how long; while it plays, the speed in the mic's place. */}
          <div className="flex items-center gap-1 mt-1 h-[18px] text-[11px] text-text-primary/65" data-testid="voice-meta">
            {active ? (
              <SpeedPill rate={rate} locale={locale} onGone={() => playRef.current?.focus()} />
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                className={`shrink-0 ${unplayed ? "text-accent-hover" : ""}`}
                data-testid={unplayed ? "voice-unplayed" : "voice-mic"}
                role="img"
                aria-label={unplayed ? "Voice message, not played yet" : "Voice message"}
              >
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
              </svg>
            )}
            <span data-testid="voice-time" className={`tabular-nums ${unplayed ? "text-accent-hover font-medium" : ""}`}>
              {active ? formatVoiceDuration(position * 1000) : formatVoiceDuration(file.voice.duration)}
            </span>
            {status && <span data-testid="voice-status" className={`min-w-0 truncate ${failed ? "text-danger-ink" : ""}`}>· <bdi>{status}</bdi></span>}
            {reason && <WhyButton open={why} onToggle={() => setWhy(!why)} controls={whyId} testId="voice-why" danger />}
          </div>
        </div>
      </div>
      {problem && (
        <p className="text-[12px] text-danger-ink m-0 mt-1 px-1" role="alert" data-testid="voice-problem" data-error={failure ?? undefined}>
          {problem}{" "}
          {saveUrl && <a href={saveUrl} download={file.name} data-testid="voice-save" className="underline text-inherit">Save</a>}
        </p>
      )}
      {reason && why && <WhyText id={whyId} testId="voice-why-text">{reason}</WhyText>}
    </div>
  );
}

/**
 * The speed, WhatsApp's pill: 1× → 1.5× → 2× → 1× on each tap, for every voice message on this device. It is
 * there only while one plays or waits mid-way; when it goes (the recording ended) with the keyboard on it,
 * the keyboard goes back to play rather than to the page.
 */
export function SpeedPill({ rate, locale, onGone }: { rate: number; locale: string; onGone: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  // A layout cleanup runs while the button is still in the page, so it can still tell whether it had focus.
  useLayoutEffect(() => {
    const button = ref.current;
    return () => { if (button && document.activeElement === button) goneRef.current(); };
  }, []);
  const label = formatVoiceRate(rate, locale);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="voice-speed"
      data-rate={rate}
      aria-label={`Playback speed ${label}`}
      onClick={() => nextVoiceRate()}
      // The pill is as tall as the line it sits on; its touch area reaches a little past it.
      className="relative shrink-0 min-w-[34px] h-[18px] px-1.5 rounded-full border-none bg-black/25 text-text-primary/85 text-[11px] font-semibold leading-none cursor-pointer hover:bg-black/35 tabular-nums before:content-[''] before:absolute before:-inset-x-1 before:-inset-y-1"
    >
      {label}
    </button>
  );
}
