import { formatVideoDuration, type VideoMeta } from "./video";

/**
 * Voice messages. A voice message is an ordinary file (files/2, or a held item) whose
 * announcement also carries a `voice` description: how long it is and the shape of its
 * sound. The shape is measured once, while recording, so no player ever decodes audio
 * to draw it. A peer that does not know `voice` ignores it and shows an audio file.
 */
export interface VoiceMeta {
  /** Milliseconds. */
  duration: number;
  /** Loudness per bar, 0-255, in playing order. */
  peaks: number[];
}

export const VOICE_LIMITS = {
  /** Fifteen minutes: at the bitrate recorded (32 kbit/s) about 3.6 MB, well inside a held item's 8 MiB. */
  maxDurationMs: 15 * 60_000,
  /** Bars drawn for a recording. */
  bars: 64,
  /** Bars accepted from a peer. */
  maxBars: 128,
  /** Asked of the recorder; opus speech is clear well below it. */
  audioBitsPerSecond: 32_000,
} as const;

/**
 * Audio a player may be handed as it is. None of these runs anything in the page's origin,
 * so received bytes of these types are served with their type (see `safeBlobType`).
 */
export const PLAYABLE_AUDIO = /^audio\/(webm|ogg|opus|mp4|mpeg|mp3|aac|x-m4a|wav|x-wav|wave|flac|x-flac)$/;

/**
 * Whether a file sent as a file (not a voice message) is shown with a player: a type a player may be handed.
 * Other audio types (MIDI, AIFF, WMA) are files, saved to be played elsewhere.
 */
export function isPlayableAudioType(mime: string): boolean {
  return PLAYABLE_AUDIO.test(baseMime(mime));
}

/** The part of a type before its parameters, in lower case: `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

/**
 * A peer's `voice` description, or undefined when it is not one. It never refuses the file:
 * a bad description only means the file is shown as a file.
 */
export function parseVoiceMeta(value: unknown, mime?: string): VoiceMeta | undefined {
  if (mime !== undefined && !PLAYABLE_AUDIO.test(baseMime(mime))) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { duration, peaks } = value as { duration?: unknown; peaks?: unknown };
  // A recorder stops a moment after the limit, never minutes after it.
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0 || duration > VOICE_LIMITS.maxDurationMs + 5_000) return undefined;
  if (!Array.isArray(peaks) || peaks.length === 0 || peaks.length > VOICE_LIMITS.maxBars) return undefined;
  if (!peaks.every((peak) => typeof peak === "number" && Number.isInteger(peak) && peak >= 0 && peak <= 255)) return undefined;
  return { duration, peaks: [...peaks] };
}

/**
 * How the level is metered while recording (apps/ui/src/lib/voiceRecorder.ts): every `intervalMs`, the RMS of the last
 * `window` samples an AnalyserNode holds (at a 48 kHz context, about 21 ms of sound).
 */
export const VOICE_METER = { intervalMs: 50, window: 1024, windowRate: 48_000 } as const;

/** One reading of the meter, 0-1: the RMS of the samples, lifted because speech sits low on a linear scale. */
export function voiceLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/**
 * The readings the recorder would have taken of this sound (mono, -1 to 1), for a recording made elsewhere: one
 * every `intervalMs` of it, each over the window that ends there, as long in time as the analyser's.
 */
export function voiceLevelsOf(mono: Float32Array, sampleRate: number): number[] {
  if (!(sampleRate > 0) || mono.length === 0) return [];
  const window = Math.max(1, Math.round((VOICE_METER.window * sampleRate) / VOICE_METER.windowRate));
  const levels: number[] = [];
  for (let step = 1; ; step++) {
    const end = Math.round((step * VOICE_METER.intervalMs * sampleRate) / 1000);
    if (end > mono.length) break;
    levels.push(voiceLevel(mono.subarray(Math.max(0, end - window), end)));
  }
  return levels;
}

/** The waveform sent with a recording made elsewhere, drawn as the recorder draws its own. */
export function voicePeaksOf(mono: Float32Array, sampleRate: number, bars: number = VOICE_LIMITS.bars): number[] {
  return downsamplePeaks(voiceLevelsOf(mono, sampleRate), bars);
}

/** Below this a recording is silence, and is drawn flat rather than stretched to fill the bars. */
const QUIET = 0.02;

/**
 * Bars from the loudness measured while recording (RMS, 0-1, oldest first): the loudest
 * sample of each stretch, scaled so the loudest bar is full height.
 */
export function downsamplePeaks(levels: ArrayLike<number>, bars: number = VOICE_LIMITS.bars): number[] {
  const count = Math.max(1, Math.min(VOICE_LIMITS.maxBars, Math.floor(bars)));
  const clean = Array.from(levels, (level) => (Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0));
  if (clean.length === 0) return new Array<number>(count).fill(0);
  const loudest = Math.max(QUIET, ...clean);
  const out: number[] = [];
  for (let bar = 0; bar < count; bar++) {
    const from = Math.floor((bar * clean.length) / count);
    // Fewer samples than bars: each bar takes the sample under it.
    const to = Math.max(from + 1, Math.floor(((bar + 1) * clean.length) / count));
    let peak = 0;
    for (let i = from; i < to && i < clean.length; i++) peak = Math.max(peak, clean[i]!);
    out.push(Math.round((peak / loudest) * 255));
  }
  return out;
}

/**
 * What to record in, by preference: opus in WebM plays on Chromium, Firefox, Safari 15+ and
 * WebKitGTK; older WebKit (WKWebView on macOS before Safari 18.4) records only AAC in MP4,
 * which Chrome, Edge and Safari play. `recorder` is asked of MediaRecorder, `file` is sent.
 */
export const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"] as const;

export function recordingMime(isTypeSupported: (mime: string) => boolean): { recorder: string; file: string } | null {
  for (const type of RECORDING_TYPES) {
    let supported = false;
    try { supported = isTypeSupported(type); } catch { /* an engine that throws for a type does not have it */ }
    if (supported) return { recorder: type, file: baseMime(type) };
  }
  return null;
}

const EXTENSIONS: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/wav": "wav" };

function voiceName(prefix: string, mime: string, timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${prefix} ${stamp}.${EXTENSIONS[baseMime(mime)] ?? "audio"}`;
}

/** A name for the file, for whoever saves it or runs a Ghostly that shows it as a file. */
export function voiceFileName(mime: string, timestamp: number): string {
  return voiceName("Voice message", mime, timestamp);
}

/**
 * The name a downloaded voice message is saved under, made here from the message's time and its
 * type (the sender's own name for it is not used): "Ghostly voice 2026-09-27 14.01.30.webm".
 */
export function voiceDownloadName(mime: string, timestamp: number): string {
  return voiceName("Ghostly voice", mime, timestamp);
}

/** `0:07`, `12:45`: minutes and seconds, as a player shows them. */
export function formatVoiceDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** The line a file message shows in the chat list and in notifications. */
export function fileMessageText(file: { name: string; voice?: VoiceMeta; video?: VideoMeta }): string {
  if (file.voice) return `🎤 Voice message (${formatVoiceDuration(file.voice.duration)})`;
  if (file.video) return `🎬 Video (${formatVideoDuration(file.video.duration)})`;
  return `📎 ${file.name}`;
}
