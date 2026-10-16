import { d as openDb, h as wrap, i as STORES } from "./idb-BuyRKmBx.js";
import { f as FILE_BYTES_STEP, i as checkFileId, p as digestText } from "./fileBytes-BLAQx_nv.js";
import { sha256 } from "@noble/hashes/sha2.js";
//#region ../browser/src/shared/fileBytesIdb.ts
var STEP = FILE_BYTES_STEP;
async function chunks(mode) {
	return (await openDb()).transaction(STORES.fileChunks, mode).objectStore(STORES.fileChunks);
}
var range = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
/**
* Files in IndexedDB, in 1 MiB pieces stored as Blobs (which browsers keep on disk), for platforms without
* the origin-private file system. Reading one hands out a Blob made of the pieces, so a download never
* loads the file into memory either.
*/
var IdbFileBytes = class {
	kind = "idb";
	tails = /* @__PURE__ */ new Map();
	/** Writes to one file run one after another. */
	queues = /* @__PURE__ */ new Map();
	serial(id, work) {
		const run = (this.queues.get(id) ?? Promise.resolve()).then(work, work);
		const settled = run.catch(() => {});
		this.queues.set(id, settled);
		settled.then(() => {
			if (this.queues.get(id) === settled) this.queues.delete(id);
		});
		return run;
	}
	async list(id) {
		const store = await chunks("readonly");
		const keys = await wrap(store.getAllKeys(range(id)));
		if (!keys.length) return [];
		const last = await wrap(store.get(keys[keys.length - 1]));
		return keys.map(([, index], i) => ({
			id,
			index,
			length: i === keys.length - 1 ? last.length : STEP
		}));
	}
	async put(chunk) {
		await wrap((await chunks("readwrite")).put(chunk));
	}
	/** The piece being filled, loaded from storage the first time a file is written. */
	async tail(id) {
		let tail = this.tails.get(id);
		if (tail) return tail;
		const pieces = await this.list(id);
		const last = pieces[pieces.length - 1];
		tail = {
			index: 0,
			bytes: new Uint8Array(STEP),
			length: 0,
			dirty: false
		};
		if (last && last.length < STEP) {
			const stored = await wrap((await chunks("readonly")).get([id, last.index]));
			tail.index = last.index;
			tail.bytes.set(new Uint8Array(await stored.data.arrayBuffer()));
			tail.length = last.length;
		} else if (last) tail.index = last.index + 1;
		this.tails.set(id, tail);
		return tail;
	}
	async sizeNow(id) {
		const tail = this.tails.get(id);
		if (tail) return tail.index * STEP + tail.length;
		const pieces = await this.list(id);
		if (!pieces.length) return null;
		return (pieces.length - 1) * STEP + pieces[pieces.length - 1].length;
	}
	async flushNow(id) {
		const tail = this.tails.get(id);
		if (!tail?.dirty) return;
		await this.put({
			id,
			index: tail.index,
			length: tail.length,
			data: new Blob([tail.bytes.slice(0, tail.length)])
		});
		tail.dirty = false;
	}
	async stage(id, source, onProgress) {
		checkFileId(id);
		await this.remove(id);
		const hash = sha256.create();
		let offset = 0;
		const reader = source.stream().getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				hash.update(value);
				await this.append(id, offset, value);
				offset += value.length;
				onProgress?.(offset);
			}
			await this.close(id);
		} catch (error) {
			await reader.cancel().catch(() => {});
			await this.remove(id).catch(() => {});
			throw error;
		}
		return digestText(hash.digest());
	}
	append(id, offset, bytes) {
		checkFileId(id);
		return this.serial(id, async () => {
			const tail = await this.tail(id);
			if (offset !== tail.index * STEP + tail.length) throw new Error("File write out of order");
			let pos = 0;
			while (pos < bytes.length) {
				const take = Math.min(STEP - tail.length, bytes.length - pos);
				tail.bytes.set(bytes.subarray(pos, pos + take), tail.length);
				tail.length += take;
				pos += take;
				tail.dirty = true;
				if (tail.length === STEP) {
					await this.flushNow(id);
					tail.index += 1;
					tail.length = 0;
				}
			}
		});
	}
	flush(id) {
		return this.serial(id, () => this.flushNow(id));
	}
	close(id) {
		return this.serial(id, async () => {
			await this.flushNow(id);
			this.tails.delete(id);
		});
	}
	size(id) {
		checkFileId(id);
		return this.serial(id, () => this.sizeNow(id));
	}
	truncate(id, size) {
		checkFileId(id);
		return this.serial(id, async () => {
			await this.flushNow(id);
			this.tails.delete(id);
			const pieces = await this.list(id);
			const keep = Math.floor(size / STEP), rest = size % STEP;
			const store = await chunks("readwrite");
			await Promise.all(pieces.filter((piece) => piece.index > keep || piece.index === keep && rest === 0).map((piece) => wrap(store.delete([id, piece.index]))));
			const cut = pieces.find((piece) => piece.index === keep);
			if (cut && rest > 0 && cut.length > rest) {
				const stored = await wrap((await chunks("readonly")).get([id, keep]));
				await this.put({
					id,
					index: keep,
					length: rest,
					data: stored.data.slice(0, rest)
				});
			}
		});
	}
	read(id, offset, length) {
		checkFileId(id);
		return this.serial(id, async () => {
			await this.flushNow(id);
			const out = [];
			const store = await chunks("readonly");
			const end = offset + length;
			for (let index = Math.floor(offset / STEP); index * STEP < end; index++) {
				const piece = await wrap(store.get([id, index]));
				if (!piece) break;
				const from = Math.max(0, offset - index * STEP), to = Math.min(piece.length, end - index * STEP);
				if (from < to) out.push(new Uint8Array(await piece.data.slice(from, to).arrayBuffer()));
				if (piece.length < STEP) break;
			}
			if (out.length === 1) return out[0];
			const joined = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
			let pos = 0;
			for (const part of out) {
				joined.set(part, pos);
				pos += part.length;
			}
			return joined;
		});
	}
	async digest(id) {
		const hash = sha256.create();
		for await (const part of this.pieces(id)) hash.update(new Uint8Array(await part.arrayBuffer()));
		return digestText(hash.digest());
	}
	async *pieces(id) {
		checkFileId(id);
		await this.flush(id);
		const pieces = await this.list(id);
		for (const piece of pieces) {
			const stored = await wrap((await chunks("readonly")).get([id, piece.index]));
			if (stored) yield stored.data;
		}
	}
	async blob(id, type) {
		const parts = [];
		for await (const part of this.pieces(id)) parts.push(part);
		return parts.length ? new Blob(parts, { type }) : await this.size(id) === 0 ? new Blob([], { type }) : null;
	}
	remove(id) {
		checkFileId(id);
		return this.serial(id, async () => {
			this.tails.delete(id);
			await wrap((await chunks("readwrite")).delete(range(id)));
		});
	}
	async removeWhere(prefix) {
		for (const id of [...this.tails.keys()]) if (id.startsWith(prefix)) this.tails.delete(id);
		const store = await chunks("readwrite");
		await wrap(prefix ? store.delete(IDBKeyRange.bound([prefix, 0], [`${prefix}￿`, Infinity])) : store.clear());
	}
	async room() {
		return storageRoom();
	}
};
/** What the browser still lets this origin store, or null when it does not say. */
async function storageRoom() {
	try {
		const estimate = await navigator.storage?.estimate?.();
		if (!estimate?.quota) return null;
		return Math.max(0, estimate.quota - (estimate.usage ?? 0));
	} catch {
		return null;
	}
}
//#endregion
export { storageRoom as n, IdbFileBytes as t };

//# sourceMappingURL=fileBytesIdb-BzBrRtog.js.map