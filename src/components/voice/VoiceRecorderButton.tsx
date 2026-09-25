import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { VOICE_LIMITS, formatVoiceDuration, type VoiceMeta } from "@ghostly/core";
import { MICROPHONE_MESSAGES, VoiceRecorder, canRecordVoice } from "../../lib/voiceRecorder";
import { LiveWaveform, Waveform } from "./Waveform";
import "./voice.css";

type Mode = "idle" | "hold" | "locked";
type Phase = "starting" | "recording" | "paused" | "sending";

/** Released sooner than this, a press was a tap: on touch a hint, with a mouse hands-free recording. */
const TAP_MS = 300;
/** How far the finger travels to cancel (sideways) or to lock (up). */
const CANCEL_PX = 110;
const LOCK_PX = 80;
const HINT_MS = 2500;
const PREVIEW_BARS = 40;

interface Props {
  onSend(file: File, voice: VoiceMeta): Promise<string | null>;
  /** Why a voice message cannot be sent in this chat now; pressing the mic says so. */
  unavailable?: string;
  disabled?: boolean;
  onError(message: string): void;
  /** Recording or not: the composer hides its pickers meanwhile. */
  onActiveChange?(active: boolean): void;
}

/**
 * The mic that takes the send button's place while the message is empty, as in WhatsApp.
 * Hold to record and release to send; slide sideways to cancel, up to lock. Locked (or
 * started with a click or the keyboard) it records hands-free: pause and resume, listen to
 * what is recorded so far, delete, or send. Esc cancels, Enter sends.
 */
export function VoiceRecorderButton({ onSend, unavailable, disabled, onError, onActiveChange }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [phase, setPhase] = useState<Phase>("starting");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [hint, setHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [preview, setPreview] = useState<{ peaks: number[]; playing: boolean } | null>(null);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gestureRef = useRef<{ id: number; x: number; y: number; at: number; mouse: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const sendingRef = useRef(false);
  const modeRef = useRef<Mode>("idle");
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewAudio = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const previewWave = useRef<HTMLDivElement>(null);
  const previewFrame = useRef(0);

  const setModeBoth = (next: Mode) => { modeRef.current = next; setMode(next); };
  const activeChange = useRef(onActiveChange);
  activeChange.current = onActiveChange;
  useEffect(() => { activeChange.current?.(mode !== "idle"); }, [mode]);

  const showHint = useCallback((text: string) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setHint(text);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  const stopPreview = useCallback(() => {
    cancelAnimationFrame(previewFrame.current);
    const current = previewAudio.current;
    if (current) { current.audio.pause(); URL.revokeObjectURL(current.url); }
    previewAudio.current = null;
    setPreview(null);
  }, []);

  const reset = useCallback(() => {
    stopPreview();
    recorderRef.current = null;
    gestureRef.current = null;
    setModeBoth("idle");
    setPhase("starting");
    setElapsed(0);
    setLevels([]);
    setDrag({ x: 0, y: 0 });
  }, [stopPreview]);

  const cancel = useCallback((why = "Voice message deleted") => {
    recorderRef.current?.cancel();
    reset();
    setAnnounce(why);
  }, [reset]);

  const send = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || sendingRef.current) return;
    // Nothing is recorded until the microphone answers.
    if (!recorder.recording && !recorder.paused) return cancel();
    sendingRef.current = true;
    setPhase("sending");
    stopPreview();
    try {
      const recording = await recorder.stop();
      reset();
      if (!recording) { showHint("Too short. Hold to record, release to send"); return; }
      setAnnounce("Voice message sent");
      const error = await onSend(recording.file, recording.voice);
      if (error) onError(error);
    } finally {
      sendingRef.current = false;
    }
  }, [cancel, reset, stopPreview, showHint, onSend, onError]);

  const begin = useCallback(async (next: Exclude<Mode, "idle">) => {
    if (disabled || recorderRef.current) return;
    if (unavailable) { onError(unavailable); return; }
    if (!canRecordVoice()) { onError(MICROPHONE_MESSAGES.unsupported); return; }
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;
    recorder.onLevel = () => setLevels(recorder.recentLevels(48));
    recorder.onLimit = () => { showHint(`Voice messages are at most ${VOICE_LIMITS.maxDurationMs / 60_000} minutes`); void send(); };
    setModeBoth(next);
    setPhase("starting");
    try {
      await recorder.start();
    } catch (error) {
      if (recorderRef.current === recorder) reset();
      onError(error instanceof Error ? error.message : MICROPHONE_MESSAGES.unavailable);
      return;
    }
    if (recorderRef.current !== recorder) return;
    setPhase("recording");
    setAnnounce("Recording");
  }, [disabled, unavailable, onError, reset, showHint, send]);

  // A chat left mid-recording gives the microphone back.
  useEffect(() => () => {
    recorderRef.current?.cancel();
    cancelAnimationFrame(previewFrame.current);
    if (previewAudio.current) URL.revokeObjectURL(previewAudio.current.url);
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  // The clock, while anything is recorded.
  useEffect(() => {
    if (mode === "idle") return;
    const timer = setInterval(() => setElapsed(recorderRef.current?.elapsed() ?? 0), 200);
    return () => clearInterval(timer);
  }, [mode]);

  // Esc cancels, Enter sends — wherever focus is while recording.
  useEffect(() => {
    if (mode === "idle") return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      else if (event.key === "Enter" && !event.repeat && modeRef.current === "locked") { event.preventDefault(); void send(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, cancel, send]);

  const lock = useCallback(() => {
    gestureRef.current = null;
    setDrag({ x: 0, y: 0 });
    setModeBoth("locked");
    setAnnounce("Recording hands-free. Enter sends, Escape deletes.");
    buttonRef.current?.focus();
  }, []);

  const direction = () => (buttonRef.current && getComputedStyle(buttonRef.current).direction === "rtl" ? -1 : 1);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || modeRef.current !== "idle") return;
    event.preventDefault();
    suppressClickRef.current = false;
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), mouse: event.pointerType === "mouse" };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no pointer to hold */ }
    void begin("hold");
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId || modeRef.current !== "hold") return;
    const x = (event.clientX - gesture.x) * direction();
    const y = event.clientY - gesture.y;
    if (x < -CANCEL_PX) { suppressClickRef.current = true; cancel("Voice message cancelled"); return; }
    if (y < -LOCK_PX) { suppressClickRef.current = true; lock(); return; }
    setDrag({ x: Math.min(0, x), y: Math.min(0, y) });
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId || modeRef.current !== "hold") return;
    suppressClickRef.current = true;
    gestureRef.current = null;
    if (Date.now() - gesture.at < TAP_MS) {
      // A click with a mouse records hands-free; a tap on a touch screen was a question.
      if (gesture.mouse) return lock();
      cancel("");
      showHint("Hold to record, release to send");
      return;
    }
    void send();
  };

  const onPointerCancel = () => {
    if (modeRef.current === "hold") cancel("Voice message cancelled");
  };

  const onClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    // The keyboard (or assistive tech) pressed it: hands-free, since there is nothing to hold.
    if (modeRef.current === "idle") void begin("locked");
    else if (modeRef.current === "locked") void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Enter on the focused send button is the document's Enter: send once.
    if (event.key === "Enter" && modeRef.current === "locked") event.preventDefault();
  };

  const togglePause = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.paused) {
      stopPreview();
      recorder.resume();
      setPhase("recording");
    } else {
      recorder.pause();
      setPhase("paused");
      setElapsed(recorder.elapsed());
      // Fewer bars than a message: the bar beside it has buttons on both sides.
      setPreview({ peaks: recorder.peaks(PREVIEW_BARS), playing: false });
    }
  };

  const togglePreview = async () => {
    const recorder = recorderRef.current;
    if (!recorder || !recorder.paused) return;
    const current = previewAudio.current;
    if (current && !current.audio.paused) { current.audio.pause(); return; }
    let audio = current?.audio;
    if (!audio) {
      const url = URL.createObjectURL(await recorder.preview());
      audio = new Audio(url);
      const total = recorder.elapsed() / 1000;
      const follow = () => {
        previewWave.current?.style.setProperty("--voice-progress", String(Math.min(1, audio!.currentTime / Math.max(0.001, total))));
        if (!audio!.paused) previewFrame.current = requestAnimationFrame(follow);
      };
      audio.addEventListener("play", () => { setPreview((p) => p && { ...p, playing: true }); follow(); });
      audio.addEventListener("pause", () => setPreview((p) => p && { ...p, playing: false }));
      audio.addEventListener("ended", () => { previewWave.current?.style.setProperty("--voice-progress", "0"); setPreview((p) => p && { ...p, playing: false }); });
      previewAudio.current = { audio, url };
    }
    await audio.play().catch(() => onError("Could not play the recording."));
  };

  const recording = mode !== "idle";
  const paused = phase === "paused";
  const nearLock = drag.y < -LOCK_PX / 2;
  const slideFade = Math.max(0.15, 1 - Math.abs(drag.x) / CANCEL_PX);
  const time = formatVoiceDuration(elapsed);

  return (
    <>
      {recording && (
        <div className="voice-bar" data-testid="voice-bar" data-mode={mode} data-phase={phase} role="group" aria-label="Voice message">
          {mode === "locked" && (
            <button type="button" className="voice-icon-button" data-testid="voice-delete" aria-label="Delete voice message" onClick={() => cancel()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          )}
          <span className="voice-bar-dot" aria-hidden="true" />
          <span className="text-[15px] tabular-nums text-text-primary min-w-[40px]" data-testid="voice-timer" aria-label={`Recorded ${time}`}>{time}</span>
          {mode === "hold" ? (
            <>
              <LiveWaveform levels={levels} bars={24} className="voice-hold-live" />
              <span className="voice-slide" style={{ opacity: slideFade, transform: `translateX(${drag.x * direction() * 0.6}px)` }} data-testid="voice-slide">
                <svg className="voice-slide-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                Slide to cancel
              </span>
            </>
          ) : paused && preview ? (
            <>
              <button type="button" className="voice-icon-button" data-testid="voice-preview" aria-label={preview.playing ? "Pause preview" : "Play what is recorded"} onClick={() => void togglePreview()}>
                {preview.playing
                  ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                  : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>}
              </button>
              <Waveform ref={previewWave} peaks={preview.peaks} className="flex-1 min-w-0" data-testid="voice-preview-wave" style={{ ["--voice-fill" as string]: "var(--color-accent)" }} />
            </>
          ) : (
            <LiveWaveform levels={levels} />
          )}
          {mode === "locked" && (
            <button type="button" className="voice-icon-button" data-testid="voice-pause" disabled={phase === "starting" || phase === "sending"}
              aria-label={paused ? "Resume recording" : "Pause recording"} onClick={togglePause}>
              {paused
                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="#ea4335" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
                : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" /></svg>}
            </button>
          )}
        </div>
      )}

      {mode === "hold" && (
        <div className="voice-lock" data-testid="voice-lock-hint" data-near={nearLock ? "true" : "false"} style={{ transform: `translateY(${Math.max(-LOCK_PX, drag.y) * 0.5}px)` }} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15" /></svg>
        </div>
      )}

      {hint && <div className="voice-hint" role="status" data-testid="voice-hint">{hint}</div>}
      <span className="sr-only" aria-live="polite">{announce}</span>

      <button
        ref={buttonRef}
        type="button"
        data-testid={mode === "locked" ? "voice-send" : "voice-record"}
        data-mode={mode}
        aria-label={mode === "locked" ? "Send voice message" : "Record a voice message"}
        aria-disabled={disabled || !!unavailable || undefined}
        title={mode === "idle" ? (unavailable ?? "Hold to record, release to send. Click to record hands-free.") : undefined}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
        style={{ touchAction: "none" }}
        className={`voice-record-button relative w-10 h-10 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-full shrink-0 cursor-pointer select-none bg-accent text-on-accent hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${unavailable ? "opacity-60" : ""}`}
      >
        {mode === "locked" ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
        )}
      </button>
    </>
  );
}
