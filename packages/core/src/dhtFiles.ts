import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "./bytes";
import { sanitizeFileName, sanitizeMime } from "./files";
import { parseImageMeta, type ImageMeta } from "./image";
import { parseVideoMeta, type VideoMeta } from "./video";
import { downsamplePeaks, parseVoiceMeta, type VoiceMeta } from "./voice";

/**
 * A file's bubble on the DHT floor (WISP 403 § Files): while the contact is away, a file's offer (its name, size, type,
 * id and the sender's time, with its picture, voice or video size when it has one) rides an envelope like a text, so
 * it takes its place among the texts written around it. Its bytes never do: they follow on the live session (files/3).
 *
 * Only to a contact whose capability record (WISP 03) lists this: an app from before would show the file's name as a
 * text of its own.
 */
export const DHT_FILE_CAPABILITY = "dht-file/1" as const;

/** The id a file's offer has on the floor (22 characters, like a text's): every send of it and its receipt match. */
export function dhtFileId(wireId: string): string {
  return toBase64Url(sha256(utf8Encode(`ghostly-file/1:${wireId}`)).slice(0, 16));
}

/** A file's id on the live session (files/3): what the floor's sixteenth element names. */
const WIRE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** What a picture, a voice note or a video says of itself on the floor: a video's poster never rides. */
export interface DhtFileMeta { voice?: VoiceMeta; image?: ImageMeta; video?: Omit<VideoMeta, "poster"> }
/** The signed body's sixteenth element: `[wire id, size, type, meta]`. The name is the envelope's text. */
export type DhtFileElement = [wireId: string, size: number, mime: string, meta: DhtFileMeta | null];

/** A file to say on the floor, as the sender has it. */
export interface DhtFileOffer {
  wireId: string;
  name: string;
  size: number;
  mime: string;
  voice?: VoiceMeta;
  image?: ImageMeta;
  video?: VideoMeta;
}
/** A file the contact said on the floor, checked: its bubble waits for the bytes. */
export interface DhtFileAnnouncement extends DhtFileOffer { video?: Omit<VideoMeta, "poster"> }

/**
 * The sixteenth elements to try for a file, the most it can say first: its whole meta, a voice note's waveform thinned
 * to fewer bars, no meta. The sender takes the first whose envelope fits the packet.
 */
export function dhtFileElements(file: DhtFileOffer): DhtFileElement[] {
  const base = (meta: DhtFileMeta | null): DhtFileElement => [file.wireId, file.size, file.mime, meta];
  const out: DhtFileElement[] = [];
  if (file.voice) {
    out.push(base({ voice: file.voice }));
    for (const bars of [32, 16, 8]) if (file.voice.peaks.length > bars) out.push(base({ voice: { duration: file.voice.duration, peaks: downsamplePeaks(file.voice.peaks, bars) } }));
  } else if (file.video) out.push(base({ video: { duration: file.video.duration, width: file.video.width, height: file.video.height } }));
  else if (file.image) out.push(base({ image: file.image }));
  out.push(base(null));
  return out;
}

/**
 * The sixteenth element as a reader takes it, with the envelope's message (`[id, time, name]`). Null when it is not a
 * file's offer, or not one that holds: the envelope's id must be the one its wire id gives, so a receipt names it.
 */
export function readDhtFile(raw: unknown, message: [id: string, timestamp: number, text: string]): DhtFileAnnouncement | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [wireId, size, mime, meta] = raw as unknown[];
  if (typeof wireId !== "string" || !WIRE_ID.test(wireId) || message[0] !== dhtFileId(wireId)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  if (typeof mime !== "string" || mime.length > 130) return null;
  if (meta !== null && (typeof meta !== "object" || Array.isArray(meta))) return null;
  const name = sanitizeFileName(message[2]), type = sanitizeMime(mime);
  const out: DhtFileAnnouncement = { wireId, name, size, mime: type };
  const said = (meta ?? {}) as Record<string, unknown>;
  const voice = parseVoiceMeta(said.voice, type), image = parseImageMeta(said.image, type), video = parseVideoMeta(said.video, type);
  if (voice) out.voice = voice;
  else if (video) { const { poster: _poster, ...shown } = video; out.video = shown; }
  else if (image) out.image = image;
  return out;
}
