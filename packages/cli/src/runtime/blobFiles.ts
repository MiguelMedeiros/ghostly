import { fileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";

/** Files moved at once: their Blobs are in memory already, and each one is read and written a step at a time. */
const AT_ONCE = 4;

/**
 * Files a profile took before every received file went to file storage (held files, hold/1, up to 1.3.0): their bytes
 * are a Blob in their record, which the store keeps in memory and writes whole into `snapshot.bin` (100 MB for 24
 * pictures), read back at every start and one-shot. Each one goes to the profile's files folder, then its record says so
 * and drops the Blob. Called before the engine starts; a file that fails stays as it was, and goes at the next start.
 * Resolves to how many moved: the caller folds the store's journal into a small snapshot then.
 */
export async function moveBlobFiles(): Promise<number> {
  const ids = await fileStore.blobIds();
  if (!ids.length) return 0;
  const storage = await fileBytes();
  let moved = 0;
  const move = async (id: string) => {
    const file = await fileStore.get(id);
    // Its size is read off its metadata once the Blob is gone (`storedSize`): one without stays as it is.
    if (!file?.blob || file.metadata?.size !== file.blob.size) return;
    try {
      await storage.stage(id, file.blob);
      if (await fileStore.movedToBytes(id, storage.kind)) moved++;
      else await storage.remove(id);
    } catch {
      await storage.remove(id).catch(() => {});
    }
  };
  for (let i = 0; i < ids.length; i += AT_ONCE) await Promise.all(ids.slice(i, i + AT_ONCE).map(move));
  return moved;
}
