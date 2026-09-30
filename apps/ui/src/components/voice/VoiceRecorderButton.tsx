import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { VOICE_LIMITS, formatVoiceDuration, type VoiceMeta } from "@ghostly/core";
import { toChosenSpeaker } from "../../lib/mediaDevices";
import { MICROPHONE_MESSAGES, MicrophoneError, VoiceRecorder, canRecordVoice, type MicrophoneProblem } from "../../lib/voiceRecorder";
import { useT, type Translate } from "../../contexts/I18nContext";

/** The microphone's own problems, in the person's language; a browser's words about it stay as they are. */
function microphoneText(t: Translate, problem: MicrophoneProblem): string {
  switch (problem) {
    case "denied": return t("chat.voice.micDenied");
    case "unavailable": return t("chat.voice.micUnavailable");
    case "unsupported": return t("chat.voice.micUnsupported");
  }
}
import { LiveWaveform, Waveform } from "./Waveform";
import "./voice.css";

type Mode = "idle" | "hold" | "locked";
type Phase = "starting" | "recording" | "paused" | "sending";

/** Released sooner than this, a press was a tap: on touch a hint, with a mouse hands-free recording. */
const TAP_MS = 300;
/**
 * A mouse let go before this much was recorded (a slow click, a microphone still waking up) meant
 * "record", not "send": it records hands-free, as a click does in WhatsApp Web.
 */
const MOUSE_SEND_MS = 1000;
/** How far the finger travels to cancel (sideways) or to lock (up). */
const CANCEL_PX = 110;
const LOCK_PX = 80;
const HINT_MS = 2500;
const PREVIEW_BARS = 40;
/** Esc throws away a recording shorter than this at once; a longer one asks first. */
const CONFIRM_MS = 3000;
/** How long the bin shows after a slide throws a recording away. */
const BIN_MS = 700;

interface Props {
  onSend(file: File, voice: VoiceMeta): Promise<string | null>;
  /** Why a voice message cannot be sent in this chat now; pressing the mic says so. */
  unavailable?: string;
  disabled?: boolean;
  onError(message: string): void;
  /** Recording or not: the composer hides its pickers meanwhile. */
  onActiveChange?(active: boolean): void;
}

const MicIcon = ({ size = 22, color = "currentColor" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
);
const SendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
);
const BinIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <g className="voice-bin-lid"><polyline points="3 6 5 6 21 6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></g>
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" />
  </svg>
);
const PlayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
);
const PauseIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
);

/**
 * The mic that takes the send button's place while the message is empty, as in WhatsApp.
 * Hold to record and release to send; slide sideways to cancel, up to lock. A mouse click (or the
 * keyboard) records hands-free straight away, like WhatsApp Web. Hands-free, the mic becomes the
 * send button at once: one press sends. Beside it: discard, pause (listen back while paused) and
 * resume. Enter sends; Esc discards, asking first once there is more than a few seconds to lose.
 */
export function VoiceRecorderButton({ onSend, unavailable, disabled, onError, onActiveChange }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("idle");
  const [phase, setPhase] = useState<Phase>("starting");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [hint, setHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [preview, setPreview] = useState<{ peaks: number[]; playing: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [binned, setBinned] = useState(false);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const gestureRef = useRef<{ id: number; x: number; y: number; at: number; mouse: boolean } | null>(null);
  /** A press on the send button (hands-free): it sends when that pointer lets go on it. */
  const sendPressRef = useRef<number | null>(null);
  /**
   * The click after a pointer gesture this button already acted on. Cleared by the next press too, so a
   * click the engine never delivered (a release away from the button) cannot swallow the next one.
   */
  const suppressClickRef = useRef(false);
  const sendingRef = useRef(false);
  /** Send was asked for before the microphone answered: it sends once it does. */
  const pendingSendRef = useRef(false);
  /** Whether the recording was running when Esc asked "discard?", so Keep carries on. */
  const confirmResumeRef = useRef(false);
  const modeRef = useRef<Mode>("idle");
  const confirmingRef = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const binTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewAudio = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const previewWave = useRef<HTMLDivElement>(null);
  const previewFrame = useRef(0);

  const setModeBoth = (next: Mode) => { modeRef.current = next; setMode(next); };
  const setConfirmingBoth = (next: boolean) => { confirmingRef.current = next; setConfirming(next); };
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
    sendPressRef.current = null;
    pendingSendRef.current = false;
    setConfirmingBoth(false);
    setModeBoth("idle");
    setPhase("starting");
    setElapsed(0);
    setLevels([]);
    setDrag({ x: 0, y: 0 });
  }, [stopPreview]);

  const cancel = useCallback((why?: string) => {
    recorderRef.current?.cancel();
    reset();
    setAnnounce(why ?? t("chat.voice.discarded"));
  }, [reset, t]);

  const send = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || sendingRef.current) return;
    if (!recorder.recording && !recorder.paused) {
      // Hands-free, the send button shows before the microphone answers: a press then is kept, not lost.
      if (modeRef.current === "locked") { pendingSendRef.current = true; setPhase("sending"); return; }
      return cancel();
    }
    const locked = modeRef.current === "locked";
    sendingRef.current = true;
    setConfirmingBoth(false);
    setPhase("sending");
    stopPreview();
    try {
      const recording = await recorder.stop();
      reset();
      if (!recording) { showHint(locked ? t("chat.voice.tooShort") : t("chat.voice.tooShortHold")); return; }
      setAnnounce(t("chat.voice.sent"));
      const error = await onSend(recording.file, recording.voice);
      if (error) onError(error);
    } finally {
      sendingRef.current = false;
    }
  }, [cancel, reset, stopPreview, showHint, onSend, onError, t]);

  const begin = useCallback(async (next: Exclude<Mode, "idle">) => {
    if (disabled || recorderRef.current) return;
    if (unavailable) { onError(unavailable); return; }
    if (!canRecordVoice()) { onError(microphoneText(t, "unsupported")); return; }
    const recorder = new VoiceRecorder();
    recorderRef.current = recorder;
    recorder.onLevel = () => setLevels(recorder.recentLevels(48));
    recorder.onLimit = () => { showHint(t("chat.voice.limit", { minutes: VOICE_LIMITS.maxDurationMs / 60_000 })); void send(); };
    setModeBoth(next);
    setPhase("starting");
    try {
      await recorder.start();
    } catch (error) {
      if (recorderRef.current === recorder) reset();
      onError(error instanceof MicrophoneError && error.message === MICROPHONE_MESSAGES[error.problem] ? microphoneText(t, error.problem)
        : error instanceof Error ? error.message : microphoneText(t, "unavailable"));
      return;
    }
    if (recorderRef.current !== recorder) return;
    setAnnounce("Recording");
    if (pendingSendRef.current) { pendingSendRef.current = false; void send(); return; }
    setPhase("recording");
  }, [disabled, unavailable, onError, reset, showHint, send, t]);

  // A chat left mid-recording gives the microphone back, and the contact stops seeing "recording audio…".
  useEffect(() => () => {
    recorderRef.current?.cancel();
    if (modeRef.current !== "idle") activeChange.current?.(false);
    cancelAnimationFrame(previewFrame.current);
    if (previewAudio.current) URL.revokeObjectURL(previewAudio.current.url);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    if (binTimer.current) clearTimeout(binTimer.current);
  }, []);

  // The clock, while anything is recorded.
  useEffect(() => {
    if (mode === "idle") return;
    const timer = setInterval(() => setElapsed(recorderRef.current?.elapsed() ?? 0), 200);
    return () => clearInterval(timer);
  }, [mode]);

  const pauseRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder?.recording) return;
    recorder.pause();
    setPhase("paused");
    setElapsed(recorder.elapsed());
    // Fewer bars than a message: the bar beside it has buttons on both sides.
    setPreview({ peaks: recorder.peaks(PREVIEW_BARS), playing: false });
  }, []);

  const resumeRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder?.paused) return;
    stopPreview();
    recorder.resume();
    setPhase("recording");
  }, [stopPreview]);

  /** Esc: a short recording goes at once; a longer one waits, paused, for "Discard?" to be answered. */
  const askDiscard = useCallback(() => {
    const recorder = recorderRef.current;
    if (modeRef.current !== "locked" || !recorder || recorder.elapsed() < CONFIRM_MS) return cancel();
    confirmResumeRef.current = recorder.recording;
    pauseRecording();
    setConfirmingBoth(true);
  }, [cancel, pauseRecording]);

  const keep = useCallback(() => {
    setConfirmingBoth(false);
    if (confirmResumeRef.current) resumeRecording();
    buttonRef.current?.focus();
  }, [resumeRecording]);

  useEffect(() => { if (confirming) keepRef.current?.focus(); }, [confirming]);

  // Esc discards, Enter sends: wherever focus is while recording. Asking "discard?", Esc keeps.
  useEffect(() => {
    if (mode === "idle") return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (sendingRef.current) return;
      if (confirmingRef.current) {
        if (event.key === "Escape") { event.preventDefault(); keep(); }
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); askDiscard(); }
      else if (event.key === "Enter" && !event.repeat && modeRef.current === "locked") { event.preventDefault(); void send(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, askDiscard, keep, send]);

  const lock = useCallback(() => {
    gestureRef.current = null;
    setDrag({ x: 0, y: 0 });
    setModeBoth("locked");
    setAnnounce(t("chat.voice.handsFree"));
    buttonRef.current?.focus();
  }, [t]);

  const bin = useCallback(() => {
    if (binTimer.current) clearTimeout(binTimer.current);
    setBinned(true);
    binTimer.current = setTimeout(() => setBinned(false), BIN_MS);
  }, []);

  const direction = () => (buttonRef.current && getComputedStyle(buttonRef.current).direction === "rtl" ? -1 : 1);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    if (modeRef.current === "locked") { sendPressRef.current = event.pointerId; return; }
    if (modeRef.current !== "idle") return;
    event.preventDefault();
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now(), mouse: event.pointerType === "mouse" };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events have no pointer to hold */ }
    void begin("hold");
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId || modeRef.current !== "hold") return;
    const x = (event.clientX - gesture.x) * direction();
    const y = event.clientY - gesture.y;
    if (x < -CANCEL_PX) { suppressClickRef.current = true; cancel(t("chat.voice.discarded")); bin(); return; }
    if (y < -LOCK_PX) { suppressClickRef.current = true; lock(); return; }
    setDrag({ x: Math.min(0, x), y: Math.min(0, y) });
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    // Hands-free: the send button sends as the press ends on it, whether or not a click follows.
    if (modeRef.current === "locked") {
      if (sendPressRef.current !== event.pointerId) return;
      sendPressRef.current = null;
      suppressClickRef.current = true;
      void send();
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId || modeRef.current !== "hold") return;
    suppressClickRef.current = true;
    gestureRef.current = null;
    const tap = Date.now() - gesture.at < TAP_MS;
    if (gesture.mouse) {
      const recorder = recorderRef.current;
      if (tap || !recorder?.recording || recorder.elapsed() < MOUSE_SEND_MS) return lock();
      void send();
      return;
    }
    // A tap on a touch screen was a question.
    if (tap) { cancel(""); showHint(t("chat.voice.holdHint")); return; }
    void send();
  };

  const onPointerCancel = () => {
    sendPressRef.current = null;
    if (modeRef.current === "hold") cancel(t("chat.voice.cancelled"));
  };

  const onClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    // The keyboard (or assistive tech) pressed it: hands-free, since there is nothing to hold.
    if (modeRef.current === "idle") void begin("locked");
    else if (modeRef.current === "locked") void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // A key press is not the click of a pointer gesture: Space sends even after a lock whose click never came.
    suppressClickRef.current = false;
    // Enter on the focused send button is the document's Enter: send once.
    if (event.key === "Enter" && modeRef.current === "locked") event.preventDefault();
  };

  const togglePause = () => {
    if (recorderRef.current?.paused) resumeRecording();
    else pauseRecording();
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
      await toChosenSpeaker(audio);
    }
    await audio.play().catch(() => onError(t("chat.voice.previewFailed")));
  };

  const recording = mode !== "idle";
  const paused = phase === "paused";
  const sending = phase === "sending";
  const nearLock = drag.y < -LOCK_PX / 2;
  const slideFade = Math.max(0.15, 1 - Math.abs(drag.x) / CANCEL_PX);
  const time = formatVoiceDuration(elapsed);
  const locked = mode === "locked";

  return (
    <>
      {recording && (
        <div className="voice-bar" data-testid="voice-bar" data-mode={mode} data-phase={phase} data-confirming={confirming || undefined} role="group" aria-label={t("chat.voice.message")}>
          {confirming ? (
            <div className="voice-confirm" role="alertdialog" aria-label={t("chat.voice.discardAsk")} data-testid="voice-confirm">
              <span className="voice-confirm-text">{t("chat.voice.discardAsk")}</span>
              <button ref={keepRef} type="button" className="voice-text-button" data-testid="voice-confirm-keep" onClick={keep}>{t("chat.voice.keep")}</button>
              <button type="button" className="voice-text-button voice-text-danger" data-testid="voice-confirm-discard" onClick={() => cancel()}>{t("chat.voice.discard")}</button>
            </div>
          ) : (
            <>
              {locked && (
                <button type="button" className="voice-icon-button" data-testid="voice-delete" aria-label={t("chat.voice.discard")} title={t("chat.voice.discard")} disabled={sending} onClick={() => cancel()}>
                  <BinIcon />
                </button>
              )}
              {paused && preview ? (
                <>
                  <button type="button" className="voice-icon-button" data-testid="voice-preview"
                    aria-label={preview.playing ? t("chat.voice.pausePlayback") : t("chat.voice.playback")} title={preview.playing ? t("chat.voice.pausePlayback") : t("chat.voice.playback")} onClick={() => void togglePreview()}>
                    {preview.playing ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <Waveform ref={previewWave} peaks={preview.peaks} className="flex-1 min-w-0" data-testid="voice-preview-wave" style={{ ["--voice-fill" as string]: "var(--color-accent)" }} />
                  <span className="text-[13px] tabular-nums text-text-secondary min-w-[36px]" data-testid="voice-timer" aria-label={t("chat.voice.recorded", { time })}>{time}</span>
                </>
              ) : (
                <>
                  <span className="voice-bar-dot" aria-hidden="true" />
                  <span className="text-[15px] tabular-nums text-text-primary min-w-[40px]" data-testid="voice-timer" aria-label={t("chat.voice.recorded", { time })}>{time}</span>
                  {mode === "hold" ? (
                    <>
                      <LiveWaveform levels={levels} bars={24} className="voice-hold-live" />
                      <span className="voice-slide" style={{ transform: `translateX(${drag.x * direction() * 0.6}px)` }} data-testid="voice-slide">
                        <span className="voice-slide-fade" style={{ opacity: slideFade }}>
                          <svg className="voice-slide-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                          {t("chat.voice.slideCancel")}
                        </span>
                      </span>
                    </>
                  ) : (
                    <LiveWaveform levels={levels} />
                  )}
                </>
              )}
              {locked && (
                <button type="button" className="voice-icon-button voice-pause-button" data-testid="voice-pause" data-paused={paused || undefined}
                  disabled={phase === "starting" || sending}
                  aria-label={paused ? t("chat.file.resume") : t("chat.file.pause")} title={paused ? t("chat.file.resume") : t("chat.file.pause")} onClick={togglePause}>
                  {paused ? <MicIcon size={20} color="var(--color-danger)" /> : <PauseIcon size={20} />}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {mode === "hold" && (
        <div className="voice-lock" data-testid="voice-lock-hint" data-near={nearLock ? "true" : "false"} style={{ transform: `translateY(${Math.max(-LOCK_PX, drag.y) * 0.5}px)` }} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            {/* Open until the finger is nearly there, then it snaps shut. */}
            <path d={nearLock ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.8-1.2"} />
          </svg>
          <svg className="voice-lock-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15" /></svg>
        </div>
      )}

      {binned && (
        <div className="voice-binned" data-testid="voice-binned" aria-hidden="true"><BinIcon size={22} /></div>
      )}

      {hint && <div className="voice-hint" role="status" data-testid="voice-hint">{hint}</div>}
      <span className="sr-only" aria-live="polite">{announce}</span>

      <button
        ref={buttonRef}
        type="button"
        data-testid={locked ? "voice-send" : "voice-record"}
        data-mode={mode}
        aria-label={locked ? t("chat.send") : t("chat.voice.record")}
        aria-disabled={disabled || !!unavailable || undefined}
        aria-busy={sending || undefined}
        title={locked ? t("chat.send") : mode === "idle" ? (unavailable ?? t("chat.voice.recordHint")) : undefined}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        // A press that leaves the send button is not a press on it: letting go back on it later sends nothing.
        onPointerLeave={() => { sendPressRef.current = null; }}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
        style={{ touchAction: "none" }}
        className={`voice-record-button relative w-11 h-11 max-md:w-12 max-md:h-12 flex items-center justify-center rounded-full shrink-0 cursor-pointer select-none bg-accent text-on-accent hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${unavailable ? "opacity-60" : ""}`}
      >
        {/* One element either way (so a press's target never leaves the page); the send icon pops in by CSS. */}
        <span className="voice-button-icon">{locked ? <SendIcon /> : <MicIcon />}</span>
      </button>
    </>
  );
}
