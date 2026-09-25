import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatVoiceDuration, type VoiceMeta } from "@ghostly/core";
import { useServicesPlatform } from "../../hooks/useServicesPlatform";
import { formatFileSize } from "../../lib/format";
import type { ChatFile } from "../../lib/types";
import {
  claimPlayback,
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
export function VoiceBubble({ file, sender }: { file: ChatFile & { voice: VoiceMeta }; sender: "me" | "peer" }) {
  const platform = useServicesPlatform();
  const transfer = platform?.getTransfer(file.id) ?? null;
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

  const rootRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const urlsRef = useRef<string[]>([]);
  const frameRef = useRef(0);
  const positionRef = useRef(0);
  const loadingRef = useRef<Promise<HTMLAudioElement | null> | null>(null);
  /** A play() is being started: its own rejection reports what went wrong, not the element's error event. */
  const startingRef = useRef(false);
  /** Whether the recording is already playing from a WAV decoded from it (the fallback, tried once). */
  const decodedRef = useRef(false);

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
      audio.playbackRate = voiceRate();
      audio.addEventListener("timeupdate", () => setPosition(audio.currentTime));
      audio.addEventListener("ended", () => {
        stopFrames();
        releasePlayback(file.id);
        setState("idle");
        setPosition(0);
        showProgress(0);
        audio.currentTime = 0;
        playNextVoice(rootRef.current);
      });
      audio.addEventListener("pause", () => { stopFrames(); setState((s) => (s === "playing" ? "paused" : s)); });
      audio.addEventListener("error", () => {
        report("media element", audio.error);
        if (startingRef.current) return;
        // Broke off while playing.
        stopFrames();
        releasePlayback(file.id);
        setState("idle");
        giveUp("Could not play this recording.");
      });
      audioRef.current = audio;
      return audio;
    })().finally(() => { loadingRef.current = null; });
    return loadingRef.current;
  }, [platform, file.id, file.mime, showProgress, report, giveUp, cannotPlayHere, switchToDecoded]);

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
        audio.playbackRate = voiceRate();
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
    if (sender === "peer" && !played) { markVoicePlayed(file.id); setPlayed(true); }
  }, [ready, file.id, load, seconds, showProgress, start, followAudio, sender, played]);

  useEffect(() => registerVoicePlayer(file.id, { play: () => void play(), pause }), [file.id, play, pause]);
  useEffect(() => onVoiceRate((next) => {
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }), []);
  useEffect(() => () => {
    stopFrames();
    releasePlayback(file.id);
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, [file.id]);

  const seekTo = useCallback((at: number) => {
    const clamped = Math.min(seconds, Math.max(0, at));
    showProgress(clamped);
    setPosition(clamped);
    if (audioRef.current) audioRef.current.currentTime = clamped;
  }, [seconds, showProgress]);

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
  if (transfer?.state === "transferring") status = `${Math.round((transfer.transferred / Math.max(1, transfer.size)) * 100)}% of ${formatFileSize(file.size)}`;
  else if (transfer?.state === "failed") status = `Failed: ${transfer.error ?? "transfer interrupted"}`;

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
      style={{ ["--voice-fill" as string]: sender === "me" ? "hsla(0,0%,100%,0.92)" : "var(--color-accent-hover)" }}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="voice-play"
          aria-label={state === "playing" ? "Pause voice message" : "Play voice message"}
          disabled={!ready || state === "loading"}
          onClick={() => (state === "playing" ? pause() : void play())}
          className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-transparent border-none text-[hsla(0,0%,100%,0.9)] cursor-pointer disabled:opacity-40 disabled:cursor-default hover:bg-black/15"
        >
          {state === "playing" ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
          )}
        </button>
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
          {/* One line under the waveform, all inside the bubble: what it is and how long, then the speed while it plays. */}
          <div className="flex items-center gap-1 mt-1 h-[18px] text-[11px] text-[hsla(0,0%,100%,0.6)]" data-testid="voice-meta">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              className={`shrink-0 ${unplayed ? "text-accent" : ""}`}
              data-testid={unplayed ? "voice-unplayed" : "voice-mic"}
              role="img"
              aria-label={unplayed ? "Voice message, not played yet" : "Voice message"}
            >
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
            </svg>
            <span data-testid="voice-time" className={`tabular-nums ${unplayed ? "text-accent font-medium" : ""}`}>
              {active ? formatVoiceDuration(position * 1000) : formatVoiceDuration(file.voice.duration)}
            </span>
            {status && <span data-testid="voice-status" className={`min-w-0 ${transfer?.state === "failed" ? "text-danger truncate" : "truncate"}`}>· {status}</span>}
            {active && (
              <button
                type="button"
                data-testid="voice-speed"
                aria-label={`Playback speed ${rate}×`}
                onClick={() => nextVoiceRate()}
                className="ms-auto shrink-0 min-w-[34px] h-[18px] px-1.5 rounded-full border-none bg-black/25 text-[hsla(0,0%,100%,0.85)] text-[11px] font-semibold leading-none cursor-pointer hover:bg-black/35 tabular-nums"
              >
                {rate}×
              </button>
            )}
          </div>
        </div>
      </div>
      {problem && (
        <p className="text-[12px] text-danger m-0 mt-1 px-1" role="alert" data-testid="voice-problem" data-error={failure ?? undefined}>
          {problem}{" "}
          {saveUrl && <a href={saveUrl} download={file.name} data-testid="voice-save" className="underline text-inherit">Save</a>}
        </p>
      )}
      {transfer?.state === "failed" && file.id.includes("-out-") && platform?.retryFile && (
        <button className="text-xs underline px-1 py-1 bg-transparent border-none text-inherit cursor-pointer" onClick={() => { setRetryError(""); void platform.retryFile!(file.id).catch((error) => setRetryError(String(error.message ?? error))); }}>Retry sending</button>
      )}
      {retryError && <p className="text-xs text-danger px-1 m-0" role="alert">{retryError}</p>}
    </div>
  );
}
