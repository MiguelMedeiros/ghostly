import { formatFileSize, sanitizeFileName, sanitizeMime } from "./files";
import { parseImageMeta, type ImageMeta } from "./image";
import { parseVideoMeta, type VideoMeta } from "./video";
import { fileMessageText, formatVoiceDuration, parseVoiceMeta, type VoiceMeta } from "./voice";

/**
 * Files and voice messages in groups (WISP 503 · Group Files). A file is announced as a group message carrying its
 * description; its bytes go over `files/3` between two members, from a member that holds it to one that asks for it.
 * The limits below are the profile's first numbers, kept in one place so they are easy to change.
 */
export const GROUP_FILE_LIMITS = {
  /** The largest file a group takes. */
  maxBytes: 100 * 1024 * 1024,
  /** A file this size or smaller is fetched without asking (voice messages always are, up to `VOICE_LIMITS`). */
  autoBytes: 8 * 1024 * 1024,
  /** What a device keeps of a group's files it fetched without asking; past it, every file is asked about. */
  autoBytesPerGroup: 256 * 1024 * 1024,
  /** Bytes of group files a device serves to others in a day, when serving is on. */
  serveBytesPerDay: 1024 * 1024 * 1024,
  /** Transfers a holder serves at once, all groups together. */
  serveAtOnce: 3,
  /** File announcements a member sends to one group in a minute. */
  announcePerMinute: 8,
  /** File announcements taken from one member of a group in `announceWindowMs`; past it, shown as text, unfetched. */
  announceTaken: 30,
  announceWindowMs: 10 * 60_000,
  /** Holders remembered per file. */
  holders: 8,
  /** Message ids in one `group-have`. */
  haveIds: 32,
  /** How long a want waits for an offer before the next holder is asked. */
  wantWaitMs: 30_000,
  /** A file session closes this long after its last transfer ends. */
  sessionIdleMs: 60_000,
  /** File sessions opening at once, and open at once, all groups together. */
  sessionsOpening: 2,
  sessionsOpen: 4,
  /** The longest file name and type kept from a description. */
  nameChars: 255,
  mimeChars: 255,
} as const;

/** The `paired-groups` version an app announces when it takes group files: it answers wants and takes `group-have`. */
export const GROUP_VERSION_FILES = 6;

/** A group file's description as the author's app puts it in the message (WISP 503 § The announcement). */
export interface GroupFileMeta {
  name: string;
  mime: string;
  size: number;
  /** SHA-256 of the file, base64url: what every receiver checks the stored bytes against. */
  d: string;
  voice?: VoiceMeta;
  video?: VideoMeta;
  image?: ImageMeta;
}

const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/**
 * A description read from the wire, cleaned: the name made a display name (never a path), the type untrusted, the
 * size within the group limit, the digest the right shape. A malformed voice, video or picture description is dropped
 * on its own and the file is still a file; anything else malformed is no file at all (null), and the text shows.
 */
export function readGroupFileMeta(value: unknown): GroupFileMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name.trim() || [...v.name].length > GROUP_FILE_LIMITS.nameChars) return null;
  if (typeof v.mime !== "string" || v.mime.length > GROUP_FILE_LIMITS.mimeChars) return null;
  if (!Number.isSafeInteger(v.size) || (v.size as number) < 1 || (v.size as number) > GROUP_FILE_LIMITS.maxBytes) return null;
  if (typeof v.d !== "string" || !DIGEST.test(v.d)) return null;
  const mime = sanitizeMime(v.mime);
  const voice = v.voice === undefined ? undefined : parseVoiceMeta(v.voice, mime);
  const video = v.video === undefined ? undefined : parseVideoMeta(v.video, mime);
  const image = v.image === undefined ? undefined : parseImageMeta(v.image, mime);
  return { name: sanitizeFileName(v.name), mime, size: v.size as number, d: v.d,
    ...(voice ? { voice } : {}), ...(video ? { video } : {}), ...(image ? { image } : {}) };
}

/**
 * The text an announcement carries when its author wrote no caption: what an app without group files shows instead
 * of the file. English, as wire text is; an app that knows the file shows the file, not this line.
 */
export function groupFileFallback(file: Pick<GroupFileMeta, "name" | "size" | "voice" | "video">): string {
  if (file.voice) return `🎤 Voice message (${formatVoiceDuration(file.voice.duration)}): update Ghostly to hear it`;
  return `${fileMessageText(file)} (${formatFileSize(file.size)}): update Ghostly to get files in groups`;
}

/**
 * Whether a device fetches a file by itself (WISP 503 § Automatic and asked downloads): a voice message always, any
 * other file up to `autoBytes` while what it took that way from the group stays within `autoBytesPerGroup`.
 */
export function fetchesByItself(file: Pick<GroupFileMeta, "size" | "voice">, keptAutomatically: number,
  limits: { autoBytes: number; autoBytesPerGroup: number } = GROUP_FILE_LIMITS): boolean {
  if (file.voice) return true;
  return file.size <= limits.autoBytes && keptAutomatically + file.size <= limits.autoBytesPerGroup;
}
