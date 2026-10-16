import { l as fileStore } from "./idb-BuyRKmBx.js";
import { o as fileBytes } from "./fileBytes-BLAQx_nv.js";
//#region src/runtime/blobFiles.ts
/** Files moved at once: their Blobs are in memory already, and each one is read and written a step at a time. */
var AT_ONCE = 4;
/**
* Files a profile took before every received file went to file storage (held files, hold/1, up to 1.3.0): their bytes
* are a Blob in their record, which the store keeps in memory and writes whole into `snapshot.bin` (100 MB for 24
* pictures), read back at every start and one-shot. Each one goes to the profile's files folder, then its record says so
* and drops the Blob. Called before the engine starts; a file that fails stays as it was, and goes at the next start.
* Resolves to how many moved: the caller folds the store's journal into a small snapshot then.
*/
async function moveBlobFiles() {
	const ids = await fileStore.blobIds();
	if (!ids.length) return 0;
	const storage = await fileBytes();
	let moved = 0;
	const move = async (id) => {
		const file = await fileStore.get(id);
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
//#endregion
export { moveBlobFiles };

//# sourceMappingURL=blobFiles-DKc6L-Hg.js.map