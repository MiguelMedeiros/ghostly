import { safeBlobType } from "@ghostly/core";
import type { ServicesPlatform } from "./platform";

/** A stored file opened for a `<video>` or `<audio>`: its URL, whether the platform streams it, and how to let it go. */
export interface StoredMedia {
  url: string;
  streamed: boolean;
  release(): void;
}

/**
 * Where a stored file plays from. Desktop serves its own files in ranges (`streamFile`): nothing is read into the
 * page, and a file of any size plays and seeks. Elsewhere, or with `bytes`, the file is handed over as a Blob, as
 * before: the way back when a stream is refused. Null when neither has it (gone, or too large to hand out here).
 */
export async function openStoredMedia(
  platform: Pick<ServicesPlatform, "getFile" | "streamFile">,
  fileId: string,
  mime: string,
  { bytes = false }: { bytes?: boolean } = {},
): Promise<StoredMedia | null> {
  if (!bytes && platform.streamFile) {
    const stream = await platform.streamFile(fileId).catch(() => null);
    if (stream) return { url: stream.url, streamed: true, release: () => stream.release() };
  }
  const blob = await platform.getFile(fileId).catch(() => null);
  if (!blob) return null;
  const type = safeBlobType(mime);
  const url = URL.createObjectURL(blob.type === type ? blob : blob.slice(0, blob.size, type));
  return { url, streamed: false, release: () => URL.revokeObjectURL(url) };
}
