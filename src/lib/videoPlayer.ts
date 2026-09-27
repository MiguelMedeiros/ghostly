import { PLAYABLE_VIDEO, safeBlobType } from "@ghostly/core";

/** The box a video is shown in: as wide as a picture, a tall one capped in height. */
const MAX_WIDTH = 300;
const MAX_HEIGHT = 330;
const MIN_WIDTH = 140;

const FORMATS: Record<string, string> = { "video/mp4": "MP4", "video/webm": "WebM", "video/quicktime": "MOV", "video/ogg": "Ogg", "video/x-m4v": "M4V", "video/x-matroska": "MKV" };
/** The container's short name, as a person knows it: "MP4", "WebM". */
export const videoFormat = (mime: string) => FORMATS[mime.split(";")[0]!.trim().toLowerCase()] ?? (mime.split("/")[1]?.toUpperCase() || "this type");

/**
 * Whether this device plays the file's type. Only types served as themselves (`safeBlobType`) are candidates:
 * a `<video>` handed opaque bytes would refuse them on WebKit anyway.
 */
export function canPlayVideo(mime: string): boolean {
  const type = safeBlobType(mime);
  if (!PLAYABLE_VIDEO.test(type) || typeof document === "undefined") return false;
  try { return document.createElement("video").canPlayType(type) !== ""; } catch { return false; }
}

/** Width and height of the box, from the video's own proportions. */
export function videoBox(width: number | undefined, height: number | undefined): { width: number; height: number } {
  const ratio = width && height ? width / height : 16 / 9;
  const boxWidth = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, MAX_HEIGHT * ratio)));
  return { width: boxWidth, height: Math.round(Math.min(MAX_HEIGHT, boxWidth / ratio)) };
}
