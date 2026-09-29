import { fromBase64Url } from "./bytes";

/**
 * Videos. A video is an ordinary file (files/2, files/3 or a held item) whose announcement may also carry a
 * `video` description: how long it is, its size in pixels and a small JPEG of its first frame, so the
 * receiver shows a picture and a length before a byte of it has arrived. A peer that does not know `video`
 * ignores it and shows a file; a bad description only means no poster.
 */
export interface VideoMeta {
  /** Milliseconds. */
  duration: number;
  /** Pixels, as it plays (rotation applied). */
  width: number;
  height: number;
  /** A JPEG of an early frame, base64url, at most `VIDEO_LIMITS.maxPosterBytes`. */
  poster?: string;
}

export const VIDEO_LIMITS = {
  /** The poster's bytes: with the rest of an offer, a frame stays far below the 60 KiB a session carries. */
  maxPosterBytes: 12 * 1024,
  /** The poster's longest side, in pixels, as the sender draws it. */
  posterEdge: 320,
  /** Ten hours: longer is a mistake, not a video. */
  maxDurationMs: 10 * 60 * 60_000,
  /** Pixels on either side (8K and a bit). */
  maxEdge: 16_384,
} as const;

/**
 * Video a player may be handed as it is. None of these runs anything in the page's origin, so received bytes
 * of these types are served with their type (see `safeBlobType`): WebKit will not play what is typed as bytes.
 */
export const PLAYABLE_VIDEO = /^video\/(mp4|webm|quicktime|ogg|x-m4v)$/;

/** Whether a file is a video, by its type: shown in a video bubble whether or not it came with a description. */
export function isVideoMime(mime: string): boolean {
  return mime.split(";")[0]!.trim().toLowerCase().startsWith("video/");
}

/**
 * Whether a file is shown as a video (a poster, a player): a type a player may be handed. Other video types
 * (Matroska, AVI) are files, saved to be played elsewhere.
 */
export function isPlayableVideoType(mime: string): boolean {
  return PLAYABLE_VIDEO.test(mime.split(";")[0]!.trim().toLowerCase());
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const JPEG_START = [0xff, 0xd8, 0xff];

/**
 * A peer's `video` description, or undefined when it is not one. It never refuses the file. A poster that is
 * too large or not a JPEG is dropped on its own; the length and size are kept.
 */
export function parseVideoMeta(value: unknown, mime?: string): VideoMeta | undefined {
  if (mime !== undefined && !isVideoMime(mime)) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { duration, width, height, poster } = value as { duration?: unknown; width?: unknown; height?: unknown; poster?: unknown };
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0 || duration > VIDEO_LIMITS.maxDurationMs) return undefined;
  const edge = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= VIDEO_LIMITS.maxEdge;
  if (!edge(width) || !edge(height)) return undefined;
  const meta: VideoMeta = { duration, width, height };
  if (typeof poster === "string" && poster.length <= Math.ceil((VIDEO_LIMITS.maxPosterBytes * 4) / 3) && BASE64URL.test(poster)) {
    try {
      const bytes = fromBase64Url(poster);
      if (bytes.length <= VIDEO_LIMITS.maxPosterBytes && JPEG_START.every((b, i) => bytes[i] === b)) meta.poster = poster;
    } catch { /* no poster */ }
  }
  return meta;
}

/** `0:07`, `12:45`, `1:02:03`: as a player shows a video's length. */
export function formatVideoDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
