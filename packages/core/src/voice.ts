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
export const PLAYABLE_AUDIO = /^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav)$/;

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

/** A name for the file, for whoever saves it or runs a Ghostly that shows it as a file. */
export function voiceFileName(mime: string, timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Voice message ${stamp}.${EXTENSIONS[baseMime(mime)] ?? "audio"}`;
}

/** `0:07`, `12:45`: minutes and seconds, as a player shows them. */
export function formatVoiceDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** The line a file message shows in the chat list and in notifications. */
export function fileMessageText(file: { name: string; voice?: VoiceMeta }): string {
  return file.voice ? `🎤 Voice message (${formatVoiceDuration(file.voice.duration)})` : `📎 ${file.name}`;
}
