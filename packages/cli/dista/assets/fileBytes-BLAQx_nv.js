import { o as databaseName } from "./idb-BuyRKmBx.js";
import { sha256 } from "@noble/hashes/sha2.js";
//#region ../browser/src/shared/fileBytesCommon.ts
/** What `fileBytes.ts` and its worker share: the worker is built alone, so this imports nothing. */
/** Reads and copies move this much at a time. */
var FILE_BYTES_STEP = 1048576;
var BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** base64url without padding (the worker has no @ghostly/core). */
function digestText(bytes) {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
		out += BASE64URL[n >> 18 & 63] + BASE64URL[n >> 12 & 63];
		if (i + 1 < bytes.length) out += BASE64URL[n >> 6 & 63];
		if (i + 2 < bytes.length) out += BASE64URL[n & 63];
	}
	return out;
}
//#endregion
//#region ../browser/src/shared/fileBytes.ts
/** Why `FileBytes.stream` refused a file this device holds: no room on the disk for the player's copy of it. */
var NO_ROOM_TO_PLAY = "no_room_to_play";
/** Files sent from memory-sized sources stay whole in IndexedDB; anything larger goes through a `FileBytes`. */
var SMALL_FILE_BYTES = 16777216;
var ID = /^[A-Za-z0-9_-]{1,200}$/;
var SPACE = /^[A-Za-z0-9_.-]{1,100}$/;
/** A file id every backend accepts as a file name as it is: never a path. */
function checkFileId(id) {
	if (!ID.test(id)) throw new Error("Invalid file id");
	return id;
}
/** This profile's folder name. */
function fileSpace() {
	const space = databaseName();
	if (!SPACE.test(space)) throw new Error("Invalid profile space");
	return space;
}
/**
* SHA-256 of a Blob, read a step at a time: memory stays at one step. Read with `slice().arrayBuffer()`, not
* `stream()`: in WebKit a Blob kept in IndexedDB that reads fine in slices failed as a stream ("The object can not be
* found here"), which failed a voice note after all its bytes had arrived.
*/
async function blobDigest(blob, onProgress) {
	const hash = sha256.create();
	for (let done = 0; done < blob.size;) {
		const part = new Uint8Array(await blob.slice(done, Math.min(blob.size, done + FILE_BYTES_STEP)).arrayBuffer());
		if (!part.length) throw new Error("The file is shorter than it says");
		hash.update(part);
		done += part.length;
		onProgress?.(done);
	}
	return digestText(hash.digest());
}
var makers = /* @__PURE__ */ new Map([["opfs", () => import("./fileBytesOpfs-C60oBRXW.js").then((m) => m.OpfsFileBytes.open())], ["idb", () => import("./fileBytesIdb-eSPW2XlO.js").then((m) => new m.IdbFileBytes())]]);
var made = /* @__PURE__ */ new Map();
var preferred = ["opfs", "idb"];
/** How a backend is made. The platform registers its own (Desktop: `native`) before anything uses it. */
function registerFileBytes(kind, make, prefer = false) {
	makers.set(kind, make);
	made.delete(kind);
	if (prefer) preferred = [kind, ...preferred.filter((k) => k !== kind)];
}
/** The backend of this kind, or null where this platform has none. */
function fileBytesOf(kind) {
	let backend = made.get(kind);
	if (!backend) {
		const make = makers.get(kind);
		backend = make ? make().catch(() => null) : Promise.resolve(null);
		made.set(kind, backend);
	}
	return backend;
}
/** Where new files go: the first backend this platform has. */
async function fileBytes() {
	for (const kind of preferred) {
		const backend = await fileBytesOf(kind);
		if (backend) return backend;
	}
	throw new Error("This device has no storage for files");
}
/** "Clear all data" and a deleted chat: the bytes of its files go with it, wherever they are. */
async function removeFileBytes(prefix = "") {
	await Promise.all([...makers.keys()].map(async (kind) => (await fileBytesOf(kind))?.removeWhere(prefix)));
}
/** A deleted profile's files, wherever they are. */
async function dropFileSpace(space) {
	if (!SPACE.test(space)) throw new Error("Invalid profile space");
	await Promise.all([...makers.keys()].map(async (kind) => (await fileBytesOf(kind))?.dropSpace?.(space)));
}
/** Tests: forget what was made and which backend comes first. */
function resetFileBytes(order = ["opfs", "idb"]) {
	made.clear();
	preferred = order;
}
//#endregion
export { dropFileSpace as a, fileSpace as c, resetFileBytes as d, FILE_BYTES_STEP as f, checkFileId as i, registerFileBytes as l, SMALL_FILE_BYTES as n, fileBytes as o, digestText as p, blobDigest as r, fileBytesOf as s, NO_ROOM_TO_PLAY as t, removeFileBytes as u };

//# sourceMappingURL=fileBytes-BLAQx_nv.js.map