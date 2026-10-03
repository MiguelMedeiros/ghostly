/**
 * A light backup (WISP 05 § Light backups): everything of a profile but the bytes of its larger files. Their messages
 * and records stay; after a restore they show as not in this backup.
 *
 * The cut: a file of at most 1 MiB keeps its bytes (a short clip, a sticker, a screenshot, a document), and so does a
 * voice message of at most 4 MiB. Voice messages are part of the conversation, and the longest one the apps record
 * (15 minutes at 32 kbit/s, `VOICE_LIMITS`) is about 3.6 MB, so every recorded one stays. Photos from a camera
 * (usually 2 to 8 MB), videos and large files are what is left out.
 */
export const LIGHT_FILE_BYTES = 1024 * 1024;
export const LIGHT_VOICE_BYTES = 4 * 1024 * 1024;

/** What a light bundle says of itself in its first record: its cut, and what it left out. */
export interface LightMark {
  maxFileBytes: number;
  maxVoiceBytes: number;
  /** How many files were left out, and their bytes. */
  files: number;
  bytes: number;
}

/** Whether a file of this size keeps its bytes in a light backup. */
export const keptInLight = (size: number, voice: boolean): boolean => size <= (voice ? LIGHT_VOICE_BYTES : LIGHT_FILE_BYTES);
