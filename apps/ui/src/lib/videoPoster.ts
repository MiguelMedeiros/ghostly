import { toBase64Url, VIDEO_LIMITS, type VideoMeta } from "@ghostly/core";

/**
 * A video's length, size and a small JPEG of an early frame, read in the page with a `<video>` and a canvas.
 * The sender sends them with the file (so the receiver shows a picture before a byte has arrived); a receiver
 * whose sender sent none makes a poster here once the file is in. Nothing is decoded but what the element
 * needs for one frame, and nothing waits longer than `timeoutMs`: a video that does not answer goes without.
 */

const DEFAULT_TIMEOUT_MS = 3_000;
/** Quality, then size, stepped down until the poster fits. */
const STEPS: { edge: number; quality: number }[] = [
  { edge: VIDEO_LIMITS.posterEdge, quality: 0.72 },
  { edge: VIDEO_LIMITS.posterEdge, quality: 0.55 },
  { edge: 240, quality: 0.55 },
  { edge: 180, quality: 0.5 },
  { edge: 120, quality: 0.45 },
];

function once(target: HTMLMediaElement, events: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (event: Event) => { clear(); resolve(event.type); };
    const failed = () => { clear(); reject(new Error(target.error ? `MediaError ${target.error.code}` : "The video did not load")); };
    const timer = setTimeout(() => { clear(); reject(new Error("The video took too long")); }, timeoutMs);
    const clear = () => {
      clearTimeout(timer);
      for (const name of events) target.removeEventListener(name, done);
      target.removeEventListener("error", failed);
    };
    for (const name of events) target.addEventListener(name, done);
    target.addEventListener("error", failed);
  });
}

function jpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try { canvas.toBlob(resolve, "image/jpeg", quality); } catch { resolve(null); }
  });
}

/** The frame on screen in `video`, as a JPEG that fits the offer, or null when it cannot be drawn. */
async function drawPoster(video: HTMLVideoElement): Promise<Blob | null> {
  const { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  for (const step of STEPS) {
    const scale = Math.min(1, step.edge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await jpeg(canvas, step.quality);
    if (blob && blob.size <= VIDEO_LIMITS.maxPosterBytes) return blob;
  }
  return null;
}

/**
 * What a recording made by a MediaRecorder says of its length: nothing (Infinity) until the element has looked
 * at its end. Asked for a time past the end, it finds out.
 */
async function realDuration(video: HTMLVideoElement, timeoutMs: number): Promise<number> {
  if (Number.isFinite(video.duration)) return video.duration;
  video.currentTime = 1e7;
  await once(video, ["durationchange", "seeked"], timeoutMs).catch(() => undefined);
  const duration = video.duration;
  video.currentTime = 0;
  return Number.isFinite(duration) ? duration : NaN;
}

export interface VideoFrame {
  /** Seconds. NaN when the video does not say. */
  duration: number;
  width: number;
  height: number;
  poster: Blob | null;
}

/** The first frame (a tenth of a second in, past a black first frame) and what the video says of itself. */
export async function readVideo(source: Blob, { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<VideoFrame | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(source);
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    video.src = url;
    await once(video, ["loadeddata"], left());
    const duration = await realDuration(video, left());
    const at = Number.isFinite(duration) ? Math.min(0.1, duration / 2) : 0.1;
    if (Math.abs(video.currentTime - at) > 0.01) {
      video.currentTime = at;
      await once(video, ["seeked"], left()).catch(() => undefined);
    }
    return { duration, width: video.videoWidth, height: video.videoHeight, poster: await drawPoster(video) };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** The description a video is sent with, or undefined when it cannot be read here (it then goes without one). */
export async function videoMetaOf(source: Blob, options?: { timeoutMs?: number }): Promise<VideoMeta | undefined> {
  const frame = await readVideo(source, options);
  if (!frame || !(frame.duration > 0) || !frame.width || !frame.height) return undefined;
  const meta: VideoMeta = { duration: Math.max(1, Math.round(frame.duration * 1000)), width: frame.width, height: frame.height };
  if (frame.poster) meta.poster = toBase64Url(new Uint8Array(await frame.poster.arrayBuffer()));
  return meta;
}

/** A poster sent with a video, as something an `<img>` shows. */
export function posterUrl(poster: string | undefined): string | undefined {
  if (!poster) return undefined;
  const base64 = poster.replace(/-/g, "+").replace(/_/g, "/");
  return `data:image/jpeg;base64,${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
}

/**
 * Posters made here, by file id, for this run of the app: made one at a time (each reads a file), and kept
 * small (a few dozen JPEGs of 12 KiB at most). One that could not be made is not tried again in this run.
 */
const localPosters = new Map<string, Promise<{ url: string; width: number; height: number; duration: number } | null>>();
const LOCAL_POSTERS_KEPT = 48;
let posterQueue: Promise<unknown> = Promise.resolve();

export function localPoster(id: string, read: () => Promise<Blob | null>): Promise<{ url: string; width: number; height: number; duration: number } | null> {
  const known = localPosters.get(id);
  if (known) return known;
  const made = posterQueue.then(async () => {
    const blob = await read().catch(() => null);
    if (!blob) return null;
    const frame = await readVideo(blob);
    if (!frame?.poster || !frame.width) return null;
    return { url: URL.createObjectURL(frame.poster), width: frame.width, height: frame.height, duration: frame.duration };
  }).catch(() => null);
  posterQueue = made;
  localPosters.set(id, made);
  if (localPosters.size > LOCAL_POSTERS_KEPT) {
    const [oldest, poster] = localPosters.entries().next().value!;
    localPosters.delete(oldest);
    void poster.then((p) => { if (p) URL.revokeObjectURL(p.url); });
  }
  return made;
}
