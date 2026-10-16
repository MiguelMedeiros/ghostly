import { c as fileSpace, f as FILE_BYTES_STEP, i as checkFileId, p as digestText } from "./fileBytes-BLAQx_nv.js";
import { mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
//#region src/runtime/fileBytes.ts
/**
* Files as real files in the profile's folder (`files/<space>/<id>`, 0600 in 0700 folders), the Node twin of the
* Desktop's `native` backend (`shared/fileBytesNative.ts`, which goes through Rust). Registered as `native` and
* preferred, so every file of any size is a file on disk, read and written a step at a time.
*/
var NodeFileBytes = class {
	root;
	kind = "native";
	writers = /* @__PURE__ */ new Map();
	constructor(root) {
		this.root = root;
	}
	folder(space = fileSpace()) {
		return join(this.root, space);
	}
	path(id) {
		return join(this.folder(), checkFileId(id));
	}
	writer(id) {
		const path = this.path(id);
		let handle = this.writers.get(path);
		if (!handle) {
			handle = mkdir(this.folder(), {
				recursive: true,
				mode: 448
			}).then(() => open(path, "a", 384));
			this.writers.set(path, handle);
			handle.catch(() => this.writers.delete(path));
		}
		return handle;
	}
	/** Copies `source` in and gives its digest, hashed as it is copied (as the web's stores do): the file is read once, not twice. */
	async stage(id, source, onProgress) {
		await this.remove(id);
		try {
			const hash = createHash("sha256");
			for (let offset = 0; offset < source.size; offset += FILE_BYTES_STEP) {
				const bytes = new Uint8Array(await source.slice(offset, offset + FILE_BYTES_STEP).arrayBuffer());
				hash.update(bytes);
				await this.append(id, offset, bytes);
				onProgress?.(offset + bytes.length);
			}
			if (source.size === 0) await this.append(id, 0, /* @__PURE__ */ new Uint8Array());
			await this.close(id);
			return digestText(new Uint8Array(hash.digest()));
		} catch (error) {
			await this.remove(id).catch(() => {});
			throw error;
		}
	}
	async append(id, offset, bytes) {
		const size = await this.size(id) ?? 0;
		if (offset !== size) throw new Error(`Append at ${offset}, but the file holds ${size} bytes`);
		const handle = await this.writer(id);
		if (bytes.length) await handle.write(bytes);
	}
	async flush(id) {
		const handle = this.writers.get(this.path(id));
		if (handle) await (await handle).sync();
	}
	async close(id) {
		const path = this.path(id);
		const handle = this.writers.get(path);
		if (!handle) return;
		this.writers.delete(path);
		const file = await handle;
		await file.sync();
		await file.close();
	}
	async size(id) {
		const path = this.path(id);
		try {
			return (await stat(path)).size;
		} catch {
			return null;
		}
	}
	async truncate(id, size) {
		await this.close(id);
		const handle = await open(this.path(id), "r+");
		try {
			await handle.truncate(size);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	async read(id, offset, length) {
		const handle = await open(this.path(id), "r");
		try {
			const buffer = Buffer.alloc(Math.min(length, 16 * FILE_BYTES_STEP));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			return new Uint8Array(buffer.subarray(0, bytesRead));
		} finally {
			await handle.close();
		}
	}
	async digest(id) {
		const hash = createHash("sha256");
		const handle = await open(this.path(id), "r");
		try {
			for await (const chunk of handle.createReadStream({ highWaterMark: FILE_BYTES_STEP })) hash.update(chunk);
		} finally {
			await handle.close().catch(() => {});
		}
		return digestText(new Uint8Array(hash.digest()));
	}
	/** The file read into memory, to show; a large one only ever goes to disk (`ghostly file save`). */
	async blob(id, type) {
		const size = await this.size(id);
		if (size === null || size > 67108864) return null;
		const parts = [];
		for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) parts.push(await this.read(id, offset, FILE_BYTES_STEP));
		return new Blob(parts, { type });
	}
	async remove(id) {
		await this.close(id).catch(() => {});
		await rm(this.path(id), { force: true });
	}
	async removeWhere(prefix) {
		if (prefix && !/^[A-Za-z0-9_-]{1,200}$/.test(prefix)) throw new Error("Invalid file id");
		let names;
		try {
			names = await readdir(this.folder());
		} catch {
			return;
		}
		await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => this.remove(name)));
	}
	async room() {
		try {
			await mkdir(this.root, {
				recursive: true,
				mode: 448
			});
			const fs = await statfs(this.root);
			return fs.bavail * fs.bsize;
		} catch {
			return null;
		}
	}
	async dropSpace(space) {
		await rm(this.folder(space), {
			recursive: true,
			force: true
		});
	}
};
//#endregion
export { NodeFileBytes };

//# sourceMappingURL=fileBytes-BDUGlCnn.js.map