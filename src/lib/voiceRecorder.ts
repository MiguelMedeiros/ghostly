import { VOICE_LIMITS, downsamplePeaks, recordingMime, voiceFileName, type VoiceMeta } from "@ghostly/core";

/**
 * One voice recording: the microphone, a MediaRecorder in a type every Ghostly can play,
 * and a level meter whose readings become the waveform sent with the file. The microphone
 * is released the moment recording stops, is cancelled or fails, so the system's
 * microphone indicator goes out with it.
 */
export type MicrophoneProblem = "denied" | "unavailable" | "unsupported";

export class MicrophoneError extends Error {
  constructor(readonly problem: MicrophoneProblem, message: string) {
    super(message);
    this.name = "MicrophoneError";
  }
}

export const MICROPHONE_MESSAGES: Record<MicrophoneProblem, string> = {
  denied: "Ghostly can't use the microphone. Allow it for Ghostly in your browser's site settings (on the desktop app: System Settings → Privacy & Security → Microphone), then try again.",
  unavailable: "No microphone is available. Connect one, or close the app that is using it, then try again.",
  unsupported: "This browser can't record voice messages.",
};

export interface Recording {
  file: File;
  voice: VoiceMeta;
}

/** How often the level is read: often enough for a live waveform, few enough to keep 15 minutes small. */
const LEVEL_MS = 50;
/** Shorter than this is a slip of the finger, not a message. */
export const MIN_RECORDING_MS = 400;

function recorderType(): { recorder: string; file: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  return recordingMime((type) => MediaRecorder.isTypeSupported(type));
}

/** Whether this page can record at all: a microphone API and a type to record in. */
export function canRecordVoice(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && recorderType() !== null;
}

function micError(error: unknown): MicrophoneError {
  const name = error instanceof Error || (typeof DOMException !== "undefined" && error instanceof DOMException) ? (error as Error).name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new MicrophoneError("denied", MICROPHONE_MESSAGES.denied);
  return new MicrophoneError("unavailable", MICROPHONE_MESSAGES.unavailable);
}

export class VoiceRecorder {
  /** The latest level, 0-1, while recording. */
  onLevel?: (level: number) => void;
  /** The recording reached the longest a voice message may be; it is paused until the caller decides. */
  onLimit?: () => void;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private chunks: Blob[] = [];
  private readonly levels: number[] = [];
  private type: { recorder: string; file: string } | null = null;
  private startedAt = 0;
  private before = 0;
  private closed = false;

  /** Asks for the microphone and starts recording. Rejects with a `MicrophoneError`. */
  async start(): Promise<void> {
    this.type = recorderType();
    if (!this.type || !navigator.mediaDevices?.getUserMedia) throw new MicrophoneError("unsupported", MICROPHONE_MESSAGES.unsupported);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      throw micError(error);
    }
    // Cancelled while the permission prompt was up: give the microphone straight back.
    if (this.closed) { for (const track of stream.getTracks()) track.stop(); return; }
    this.stream = stream;
    try {
      const recorder = new MediaRecorder(stream, { mimeType: this.type.recorder, audioBitsPerSecond: VOICE_LIMITS.audioBitsPerSecond });
      recorder.ondataavailable = (event) => { if (event.data.size > 0) this.chunks.push(event.data); };
      // A timeslice keeps what is recorded so far playable for the preview.
      recorder.start(1000);
      this.recorder = recorder;
    } catch (error) {
      this.release();
      throw new MicrophoneError("unsupported", error instanceof Error ? error.message : MICROPHONE_MESSAGES.unsupported);
    }
    this.startedAt = Date.now();
    this.startMeter(stream);
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  get paused(): boolean {
    return this.recorder?.state === "paused";
  }

  /** Milliseconds recorded, pauses left out. */
  elapsed(): number {
    return this.before + (this.recording ? Date.now() - this.startedAt : 0);
  }

  /** The waveform so far, for the preview of a paused recording. */
  peaks(bars?: number): number[] {
    return downsamplePeaks(this.levels, bars);
  }

  /** The last `count` levels, oldest first: the live waveform. */
  recentLevels(count: number): number[] {
    return this.levels.slice(-count);
  }

  pause(): void {
    if (!this.recording) return;
    this.before += Date.now() - this.startedAt;
    this.recorder!.pause();
  }

  resume(): void {
    if (!this.paused || this.before >= VOICE_LIMITS.maxDurationMs) return;
    this.startedAt = Date.now();
    this.recorder!.resume();
  }

  /** What is recorded so far, playable, without stopping. */
  async preview(): Promise<Blob> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const done = () => { recorder.removeEventListener("dataavailable", done); resolve(); };
        recorder.addEventListener("dataavailable", done);
        try { recorder.requestData(); } catch { done(); }
        // Some engines have nothing new to hand over while paused, and say nothing.
        setTimeout(done, 400);
      });
    }
    return new Blob(this.chunks, { type: this.type?.file });
  }

  /** Stops, lets go of the microphone, and returns the recording (null when too short to be one). */
  async stop(): Promise<Recording | null> {
    const recorder = this.recorder;
    const duration = Math.min(this.elapsed(), VOICE_LIMITS.maxDurationMs);
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    const peaks = this.peaks();
    this.release();
    const type = this.type?.file;
    if (!type || duration < MIN_RECORDING_MS || this.chunks.length === 0) return null;
    const timestamp = Date.now();
    const file = new File(this.chunks, voiceFileName(type, timestamp), { type, lastModified: timestamp });
    this.chunks = [];
    return { file, voice: { duration: Math.round(duration), peaks } };
  }

  /** Throws the recording away and lets go of the microphone. */
  cancel(): void {
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      try { recorder.stop(); } catch { /* already stopping */ }
    }
    this.chunks = [];
    this.release();
  }

  private startMeter(stream: MediaStream): void {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let analyser: AnalyserNode | null = null;
    let samples: Float32Array<ArrayBuffer> | null = null;
    try {
      if (Context) {
        this.context = new Context();
        analyser = this.context.createAnalyser();
        analyser.fftSize = 1024;
        this.context.createMediaStreamSource(stream).connect(analyser);
        samples = new Float32Array(analyser.fftSize);
      }
    } catch {
      // No meter: the recording still works, drawn flat.
      analyser = null;
    }
    this.meter = setInterval(() => {
      if (this.elapsed() >= VOICE_LIMITS.maxDurationMs && this.recording) {
        this.pause();
        this.onLimit?.();
      }
      if (!this.recording) return;
      let level = 0;
      if (analyser && samples) {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        // Speech sits low on a linear RMS scale: lift it so a normal voice fills the bars.
        level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      }
      this.levels.push(level);
      this.onLevel?.(level);
    }, LEVEL_MS);
  }

  private release(): void {
    this.closed = true;
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
