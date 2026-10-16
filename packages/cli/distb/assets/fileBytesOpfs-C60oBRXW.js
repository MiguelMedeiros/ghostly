import { c as fileSpace, f as FILE_BYTES_STEP, i as checkFileId } from "./fileBytes-BLAQx_nv.js";
import { n as storageRoom } from "./fileBytesIdb-BzBrRtog.js";
//#region ../browser/src/shared/fileBytesOpfs.ts
/**
* Files in the origin-private file system, written by `fileBytesWorker.ts`. Every page and the peer of one
* profile see the same folder; a file is written by one of them at a time (the page copies a file it sends,
* the peer writes one it receives), and read as a Blob only once it is closed.
*/
var OpfsFileBytes = class OpfsFileBytes {
	worker;
	kind = "opfs";
	/** Shared with the views `forSpace` makes: one worker, one run of request numbers. */
	counter = { next: 1 };
	/** Another profile's folder (`forSpace`); the active profile's when not set. */
	fixedSpace;
	waiting = /* @__PURE__ */ new Map();
	constructor(worker) {
		this.worker = worker;
		worker.onmessage = (event) => {
			const reply = event.data, pending = this.waiting.get(reply.n);
			if (!pending) return;
			if ("progress" in reply) return pending.progress?.(reply.progress);
			this.waiting.delete(reply.n);
			if (reply.ok) pending.resolve(reply.value);
			else pending.reject(reply.name ? Object.assign(new Error(reply.error), { name: reply.name }) : new Error(reply.error));
		};
		worker.onerror = (event) => {
			event.preventDefault();
			for (const pending of this.waiting.values()) pending.reject(/* @__PURE__ */ new Error(`File storage stopped: ${event.message || "unknown error"}`));
			this.waiting.clear();
		};
	}
	/** The worker, if this browser can run it and gives it sync access handles; null otherwise. */
	static async open() {
		if (typeof Worker === "undefined" || typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
		const store = new OpfsFileBytes(new Worker(new URL("./fileBytesWorker.ts", import.meta.url), { type: "module" }));
		try {
			if (await store.call({ op: "probe" })) return store;
		} catch {}
		store.worker.terminate();
		return null;
	}
	space() {
		return this.fixedSpace ?? fileSpace();
	}
	/** A view on the same worker that reads and writes another profile's folder. */
	forSpace(space) {
		const view = Object.create(this);
		view.fixedSpace = space;
		return view;
	}
	call(request, transfer = [], progress) {
		const n = this.counter.next++;
		return new Promise((resolve, reject) => {
			this.waiting.set(n, {
				resolve,
				reject,
				progress
			});
			this.worker.postMessage({
				...request,
				n,
				space: this.space()
			}, transfer);
		});
	}
	stage(id, source, onProgress) {
		return this.call({
			op: "stage",
			id: checkFileId(id),
			source
		}, [], onProgress);
	}
	append(id, offset, bytes) {
		const copy = bytes.slice();
		return this.call({
			op: "append",
			id: checkFileId(id),
			offset,
			bytes: copy
		}, [copy.buffer]);
	}
	flush(id) {
		return this.call({
			op: "flush",
			id: checkFileId(id)
		});
	}
	close(id) {
		return this.call({
			op: "close",
			id: checkFileId(id)
		});
	}
	size(id) {
		return this.call({
			op: "size",
			id: checkFileId(id)
		});
	}
	truncate(id, size) {
		return this.call({
			op: "truncate",
			id: checkFileId(id),
			size
		});
	}
	read(id, offset, length) {
		return this.call({
			op: "read",
			id: checkFileId(id),
			offset,
			length: Math.min(length, 16 * FILE_BYTES_STEP)
		});
	}
	digest(id) {
		return this.call({
			op: "digest",
			id: checkFileId(id)
		});
	}
	remove(id) {
		return this.call({
			op: "remove",
			id: checkFileId(id)
		});
	}
	removeWhere(prefix) {
		return this.call({
			op: "removeWhere",
			prefix
		});
	}
	async blob(id, type) {
		await this.close(id);
		try {
			const file = await (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files")).getDirectoryHandle(this.space())).getFileHandle(checkFileId(id))).getFile();
			return file.slice(0, file.size, type);
		} catch {
			return null;
		}
	}
	room() {
		return storageRoom();
	}
	async dropSpace(space) {
		try {
			await (await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files")).removeEntry(space, { recursive: true });
		} catch (error) {
			if (error?.name !== "NotFoundError") throw error;
		}
	}
};
//#endregion
export { OpfsFileBytes };

//# sourceMappingURL=fileBytesOpfs-C60oBRXW.js.map