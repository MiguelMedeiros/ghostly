/*
 * What Settings reads of the translation models on this computer, and the Remove it offers. The Desktop download
 * command (its pinned list and the `translation-models/<pair>/` folder) brings the real wrappers: until it is in, these
 * stand in for them with the same shape, and say there is nothing on disk.
 */

/** One language pair on disk: `<from>-<to>` (`pt-en`) and the bytes of all its files. */
export interface DownloadedPair {
  pair: string;
  bytes: number;
}

/** The translation models this computer has, shared by every profile on it. */
export interface TranslationStatus {
  pairs: DownloadedPair[];
}

/** The pairs downloaded on this computer. */
export async function translationStatus(): Promise<TranslationStatus> {
  return { pairs: [] };
}

/** Deletes `pair`'s files from this computer: every profile on it loses that pair. */
export async function removeTranslationPair(pair: string): Promise<void> {
  throw new Error(`No translation model to remove: ${pair}`);
}
