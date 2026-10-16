import { Dl as toBase64Url } from "./src-dfGE33hw.js";
import { l as fileStore } from "./idb-BuyRKmBx.js";
import { i as fromBase64Url, r as open$1 } from "./envelope-CEZ9D5OW.js";
import { t as CliError } from "./errors-B-zMxbcd.js";
import { _ as str, n as bool } from "./apiKit-BeSsbld5.js";
import { d as profileExists, f as profilePaths, n as RESTORED_MARK } from "./profiles-CI6Z0_ww.js";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
//#region ../browser/src/backup/stream.ts
/**
* A backup written and read a piece at a time (WISP 05, envelope version 2), so a profile with years of files never
* has to fit in memory. The file is one line of clear JSON (the header), then frames:
*
*   header line:  {"format":"ghostly-backup","version":2,"protection":"passphrase"|"none",...}\n
*   frame:        kind (1 byte) | length (4 bytes, big endian) | body
*
* A frame carries one record: a piece of JSON (gzip or plain) or a piece of a file's bytes, at most `FRAME_BYTES`
* of them. The last frame is the final marker; a file that ends without it was cut short and is refused.
*
* - `passphrase`: the key comes from the passphrase as in version 1 (PBKDF2-SHA256, 600 000 rounds, 16 byte salt).
*   Every frame is sealed alone with AES-256-GCM: its nonce is the header's 7 random bytes, the frame's number
*   (4 bytes) and its kind (1 byte), and the SHA-256 of the header line is its associated data. A frame changed,
*   moved, dropped or retyped, a changed header, or a missing final marker fails to open.
* - `none`: nothing is encrypted. A SHA-256 chain runs over the header line and every frame, and the final marker
*   holds its last value, so a damaged or cut file is refused. It proves nothing about who made the file.
*/
var FRAME_BYTES = 1048576;
/** No frame is larger than this: a reader refuses one that says it is, before reading it. */
var MAX_FRAME_BYTES = 67108864;
/** One piece of JSON, decompressed: past it the backup is refused, not read. */
var MAX_JSON_BYTES = 268435456;
var MAX_HEADER_BYTES = 4096;
var ITERATIONS = 6e5;
var KIND = {
	gzipJson: 1,
	json: 2,
	bytes: 3,
	final: 255
};
/** Thrown when the work was cancelled (`AbortSignal`): nothing is wrong with the backup. */
var BackupCancelled = class extends Error {
	constructor() {
		super("Cancelled");
		this.name = "AbortError";
	}
};
var check = (signal) => {
	if (signal?.aborted) throw new BackupCancelled();
};
var canCompress = () => typeof CompressionStream !== "undefined";
async function through(bytes, stream, limit = Infinity) {
	const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
	const chunks = [];
	let size = 0;
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.length;
		if (size > limit) {
			await reader.cancel();
			throw new Error("This backup is too large to restore");
		}
		chunks.push(next.value);
	}
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}
async function keyFrom(passphrase, salt, iterations) {
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey({
		name: "PBKDF2",
		hash: "SHA-256",
		salt,
		iterations
	}, material, {
		name: "AES-GCM",
		length: 256
	}, false, ["encrypt", "decrypt"]);
}
var sha256 = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", join$1(parts)));
function join$1(parts) {
	if (parts.length === 1) return parts[0];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
function prefix(kind, length) {
	const out = /* @__PURE__ */ new Uint8Array(5);
	out[0] = kind;
	new DataView(out.buffer).setUint32(1, length);
	return out;
}
function nonce(base, frame, kind) {
	const out = /* @__PURE__ */ new Uint8Array(12);
	out.set(base, 0);
	new DataView(out.buffer).setUint32(7, frame);
	out[11] = kind;
	return out;
}
/** Writes a backup: `json` and `bytes` in the order they are to be read, then `finish`. */
var BackupWriter = class BackupWriter {
	sink;
	key;
	base;
	chain;
	signal;
	frame = 0;
	/** Bytes handed to the sink so far. */
	written = 0;
	finished = false;
	/** Set once the sink refused a frame: the error it gave, thrown again at every later write. */
	failed = null;
	constructor(sink, key, base, chain, signal) {
		this.sink = sink;
		this.key = key;
		this.base = base;
		this.chain = chain;
		this.signal = signal;
	}
	/** `passphrase` null: a backup anyone can read (the caller has made sure that is what the person chose). */
	static async start(sink, passphrase, signal, version = 2) {
		if (passphrase !== null && passphrase.length < 12) throw new Error("Use at least 12 characters for the backup passphrase");
		check(signal);
		const salt = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16)), base = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(7));
		const header = passphrase === null ? {
			format: "ghostly-backup",
			version,
			protection: "none",
			check: { name: "SHA-256-chain" }
		} : {
			format: "ghostly-backup",
			version,
			protection: "passphrase",
			kdf: {
				name: "PBKDF2-SHA256",
				iterations: ITERATIONS,
				salt: toBase64Url(salt)
			},
			cipher: {
				name: "AES-256-GCM",
				nonce: toBase64Url(base)
			}
		};
		const line = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
		const key = passphrase === null ? null : await keyFrom(passphrase, salt, ITERATIONS);
		const writer = new BackupWriter(sink, key, base, await sha256(line), signal);
		await sink.write(line);
		writer.written = line.length;
		return writer;
	}
	async put(kind, plain) {
		check(this.signal);
		if (this.failed) throw this.failed.error;
		if (this.finished) throw new Error("This backup is already finished");
		if (this.frame >= 4294967295) throw new Error("This backup is too large");
		if (plain.length > MAX_FRAME_BYTES) throw new Error("A record of this profile is too large for a backup");
		let out;
		if (this.key) {
			const sealed = new Uint8Array(await crypto.subtle.encrypt({
				name: "AES-GCM",
				iv: nonce(this.base, this.frame, kind),
				additionalData: this.chain
			}, this.key, plain));
			out = join$1([prefix(kind, sealed.length), sealed]);
		} else {
			const head = prefix(kind, kind === KIND.final ? 32 : plain.length);
			if (kind === KIND.final) out = join$1([head, this.chain]);
			else {
				out = join$1([head, plain]);
				this.chain = await sha256(this.chain, out);
			}
		}
		this.frame += 1;
		try {
			await this.sink.write(out);
		} catch (error) {
			this.failed = { error };
			throw error;
		}
		this.written += out.length;
	}
	/** One piece of JSON, compressed where the platform can. */
	async json(text) {
		const plain = new TextEncoder().encode(text);
		if (plain.length > MAX_JSON_BYTES) throw new Error("A record of this profile is too large for a backup");
		if (canCompress()) await this.put(KIND.gzipJson, await through(plain, new CompressionStream("gzip")));
		else await this.put(KIND.json, plain);
	}
	/** Bytes of the file the last JSON announced, cut into frames. */
	async bytes(chunk) {
		for (let at = 0; at < chunk.length; at += FRAME_BYTES) await this.put(KIND.bytes, chunk.subarray(at, Math.min(chunk.length, at + FRAME_BYTES)));
	}
	/** The final marker: without it a reader refuses the backup. Resolves to the size of the whole backup. */
	async finish() {
		await this.put(KIND.final, /* @__PURE__ */ new Uint8Array());
		this.finished = true;
		return this.written;
	}
};
/** The first line of a version 2 backup, or null when this is not one (version 1 is one JSON object with no line end). */
async function readBackupHeader(source) {
	const start = await source.read(0, Math.min(MAX_HEADER_BYTES, source.size));
	const end = start.indexOf(10);
	if (end < 0) return null;
	let header;
	try {
		header = JSON.parse(new TextDecoder().decode(start.subarray(0, end)));
	} catch {
		return null;
	}
	if (header?.format !== "ghostly-backup" || typeof header.version !== "number" || header.version < 2) return null;
	if (header.version !== 2 && header.version !== 3) throw new Error("This backup comes from a newer Ghostly; update to restore it");
	if (header.protection === "none") {
		if (header.check?.name !== "SHA-256-chain") throw new Error("Unsupported backup format");
	} else if (header.protection === "passphrase") {
		if (header.kdf?.name !== "PBKDF2-SHA256" || !(header.kdf.iterations >= ITERATIONS) || header.kdf.iterations > 1e7 || header.cipher?.name !== "AES-256-GCM") throw new Error("Unsupported backup encryption");
	} else throw new Error("Unsupported backup format");
	return {
		header,
		line: start.slice(0, end + 1)
	};
}
var DAMAGED = "This backup is damaged: it was changed or cut short";
/** Reads a version 2 backup record by record. Nothing of a frame is handed out before it passed its check. */
var BackupReader = class BackupReader {
	source;
	key;
	base;
	chain;
	signal;
	frame = 0;
	at;
	block = /* @__PURE__ */ new Uint8Array();
	blockAt = 0;
	done = false;
	constructor(source, key, base, chain, start, signal) {
		this.source = source;
		this.key = key;
		this.base = base;
		this.chain = chain;
		this.signal = signal;
		this.at = start;
	}
	get protection() {
		return this.key ? "passphrase" : "none";
	}
	/** Null when `source` is not a version 2 backup. `passphrase` is needed, and used, only for a sealed one. */
	static async open(source, passphrase, signal) {
		const found = await readBackupHeader(source);
		if (!found) return null;
		check(signal);
		const { header, line } = found;
		if (header.protection === "none") return new BackupReader(source, null, /* @__PURE__ */ new Uint8Array(), await sha256(line), line.length, signal);
		let key, base;
		try {
			base = fromBase64Url(header.cipher.nonce);
			if (base.length !== 7) throw new Error("nonce");
			key = await keyFrom(passphrase ?? "", fromBase64Url(header.kdf.salt), header.kdf.iterations);
		} catch {
			throw new Error("Unsupported backup encryption");
		}
		return new BackupReader(source, key, base, await sha256(line), line.length, signal);
	}
	/** Bytes of the source read so far (for progress). */
	get position() {
		return this.at;
	}
	/** `length` bytes at the reading point, through a read-ahead block so a source is asked a few times per megabyte, not per frame. */
	async take(length) {
		if (this.at + length > this.source.size) throw new Error(DAMAGED);
		const from = this.at - this.blockAt;
		if (from < 0 || from + length > this.block.length) {
			this.block = await this.source.read(this.at, Math.min(this.source.size - this.at, Math.max(length, 4 * FRAME_BYTES)));
			this.blockAt = this.at;
			if (this.block.length < length) throw new Error(DAMAGED);
		}
		const out = this.block.subarray(this.at - this.blockAt, this.at - this.blockAt + length);
		this.at += length;
		return out;
	}
	/** The next record, or null at the end: only then is the backup known to be whole. */
	async next() {
		check(this.signal);
		if (this.done) return null;
		const head = await this.take(5);
		const kind = head[0], length = new DataView(head.buffer, head.byteOffset, 5).getUint32(1);
		if (length > 67108880 || !Object.values(KIND).includes(kind)) throw new Error(DAMAGED);
		const headCopy = head.slice();
		const body = await this.take(length);
		let plain;
		if (this.key) try {
			plain = new Uint8Array(await crypto.subtle.decrypt({
				name: "AES-GCM",
				iv: nonce(this.base, this.frame, kind),
				additionalData: this.chain
			}, this.key, body));
		} catch {
			throw new Error(this.frame === 0 ? "Wrong passphrase, or the backup was changed" : DAMAGED);
		}
		else if (kind === KIND.final) {
			if (body.length !== 32 || body.some((byte, i) => byte !== this.chain[i])) throw new Error(DAMAGED);
			plain = /* @__PURE__ */ new Uint8Array();
		} else {
			this.chain = await sha256(this.chain, headCopy, body);
			plain = body.slice();
		}
		this.frame += 1;
		if (kind === KIND.final) {
			if (plain.length || this.at !== this.source.size) throw new Error(DAMAGED);
			this.done = true;
			return null;
		}
		if (kind === KIND.bytes) return { bytes: plain };
		const text = kind === KIND.gzipJson ? await through(plain, new DecompressionStream("gzip"), MAX_JSON_BYTES).catch((error) => {
			throw error instanceof Error && error.message.startsWith("This backup is too large") ? error : /* @__PURE__ */ new Error(DAMAGED);
		}) : plain;
		return { json: new TextDecoder().decode(text) };
	}
};
//#endregion
//#region ../browser/src/backup/light.ts
/**
* A light backup (WISP 05 § Light backups): everything of a profile but the bytes of its larger files. Their messages
* and records stay; after a restore they show as not in this backup.
*
* The cut: a file of at most 1 MiB keeps its bytes (a short clip, a sticker, a screenshot, a document), and so does a
* voice message of at most 4 MiB. Voice messages are part of the conversation, and the longest one the apps record
* (15 minutes at 32 kbit/s, `VOICE_LIMITS`) is about 3.6 MB, so every recorded one stays. Photos from a camera
* (usually 2 to 8 MB), videos and large files are what is left out.
*/
var LIGHT_FILE_BYTES = 1048576;
var LIGHT_VOICE_BYTES = 4194304;
/** Whether a file of this size keeps its bytes in a light backup. */
var keptInLight = (size, voice) => size <= (voice ? LIGHT_VOICE_BYTES : LIGHT_FILE_BYTES);
//#endregion
//#region src/backup.ts
/**
* A headless profile's backup: the WISP 05 envelope around the profile itself, its store and its files, written and
* read a piece at a time (envelope version 2), so a profile with large files never has to fit in memory. It restores
* into a new headless profile; the app's own backups are made from its page's storage and are not this format
* (WISP 1100 § Parity). A backup an older CLI made (version 1: everything in one sealed JSON document) still restores.
*/
var FORMAT = "ghostly-cli-profile/2";
var FORMAT_1 = "ghostly-cli-profile/1";
async function walk(root, dir = root, out = []) {
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const path = join(dir, name);
		if ((await stat(path)).isDirectory()) await walk(root, path, out);
		else out.push(relative(root, path));
	}
	return out;
}
/** A file's first `size` bytes into the backup, a frame at a time. One that got shorter meanwhile stops the backup. */
async function copyIn(writer, path, size) {
	const handle = await open(path, "r");
	try {
		const buffer = new Uint8Array(FRAME_BYTES);
		for (let at = 0; at < size;) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(FRAME_BYTES, size - at), at);
			if (!bytesRead) throw new CliError("unavailable", `${path} changed while it was backed up: try again`);
			await writer.bytes(buffer.subarray(0, bytesRead));
			at += bytesRead;
		}
	} finally {
		await handle.close();
	}
}
var BACKUP_METHODS = { 
/**
* Writes the backup to `path` (resolved by the command), sealed with `passphrase`, or not encrypted when
* `noPassphrase` is true: one of the two, never a guess. The store is written whole for it, every value inline. It is
* written beside `path` and only takes its name once it is complete: a backup that fails leaves no file. `light`:
* the files over the cut (`keptInLight`) are left out, their records kept.
*/
async "profile.backup"(ctx, params) {
	const path = resolve(str(params, "path", true));
	if (existsSync(path)) throw new CliError("refused", `${path} exists: choose another name`);
	const passphrase = str(params, "passphrase"), unsealed = bool(params, "noPassphrase");
	if (!passphrase && !unsealed) throw new CliError("bad_request", "passphrase is required (or noPassphrase: true for a backup anyone can read)");
	if (passphrase && unsealed) throw new CliError("bad_request", "Give a passphrase or noPassphrase, not both");
	const folder = dirname(path);
	if (!(await stat(folder)).isDirectory()) throw new CliError("not_found", `No such file or folder: ${folder}`);
	const paths = ctx.runtime.paths;
	const store = join(paths.db, `backup-store-${process.pid}.bin`);
	await ctx.runtime.store.exportSnapshot(store);
	const light = bool(params, "light");
	const all = await Promise.all((await walk(paths.files)).map(async (name) => ({
		name,
		size: (await stat(join(paths.files, name))).size
	})));
	const kept = async (file) => keptInLight(file.size, false) || file.size <= 4194304 && !!(await fileStore.get(basename(file.name)).catch(() => void 0))?.metadata?.voice;
	const files = [], leftOut = [];
	for (const file of all) (!light || await kept(file) ? files : leftOut).push(file);
	const storeSize = (await stat(store)).size, bytes = files.reduce((sum, file) => sum + file.size, 0);
	const leftOutBytes = leftOut.reduce((sum, file) => sum + file.size, 0);
	const partial = `${path}.partial-${process.pid}`;
	let out = null;
	try {
		out = await openFile(partial);
		const handle = out;
		let writer;
		try {
			writer = await BackupWriter.start({ write: async (chunk) => {
				await handle.write(chunk);
			} }, unsealed ? null : passphrase);
		} catch (error) {
			throw new CliError("bad_request", error instanceof Error ? error.message : String(error));
		}
		const put = (record) => writer.json(JSON.stringify(record));
		await put({
			t: "profile",
			format: FORMAT,
			createdAt: Date.now(),
			files: files.length,
			bytes,
			...light && { light: {
				maxFileBytes: 1048576,
				maxVoiceBytes: 4194304,
				files: leftOut.length,
				bytes: leftOutBytes,
				ids: leftOut.map((file) => basename(file.name))
			} }
		});
		await put({
			t: "file",
			kind: "store",
			size: storeSize
		});
		await copyIn(writer, store, storeSize);
		for (const file of files) {
			await put({
				t: "file",
				kind: "file",
				path: file.name.split(sep).join("/"),
				size: file.size
			});
			await copyIn(writer, join(paths.files, file.name), file.size);
		}
		await put({
			t: "end",
			files: files.length,
			bytes
		});
		const written = await writer.finish();
		await handle.sync();
		await handle.close();
		out = null;
		try {
			await link(partial, path);
		} catch (error) {
			throw error.code === "EEXIST" ? new CliError("refused", `${path} exists: choose another name`) : error;
		}
		return {
			path,
			bytes: written,
			files: files.length,
			protection: unsealed ? "none" : "passphrase",
			...light && {
				light: true,
				leftOut: leftOut.length,
				leftOutBytes
			}
		};
	} finally {
		await out?.close().catch(() => {});
		await rm(partial, { force: true });
		await rm(store, { force: true });
	}
} };
async function openFile(path) {
	try {
		return await open(path, "wx", 384);
	} catch (error) {
		if (error.code === "EEXIST") {
			await rm(path, { force: true });
			return open(path, "wx", 384);
		}
		throw error;
	}
}
/** A file on disk as a backup's source: read in ranges, never whole. A folder opens, and is refused as one here. */
async function fileSource(path) {
	const handle = await open(path, "r");
	const found = await handle.stat();
	if (found.isDirectory()) {
		await handle.close();
		throw new CliError("bad_request", `${path} is a folder: name a file`);
	}
	const { size } = found;
	return {
		size,
		read: async (offset, length) => {
			const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
			let got = 0;
			while (got < buffer.length) {
				const { bytesRead } = await handle.read(buffer, got, buffer.length - got, offset + got);
				if (!bytesRead) break;
				got += bytesRead;
			}
			return buffer.subarray(0, got);
		},
		close: () => handle.close()
	};
}
/** A version 1 backup is one JSON object, and `seal` writes its format first. */
var VERSION_1_START = /^\s*\{\s*"format"\s*:\s*"ghostly-backup"/;
/**
* Whether the backup at `file` is sealed with a passphrase or was made without one, read from its clear header.
* A file that is neither version is refused here, before any passphrase is asked for: the path is what is wrong.
*/
async function backupFileProtection(file) {
	const source = await fileSource(file);
	try {
		let found;
		try {
			found = await readBackupHeader(source);
		} catch (error) {
			throw new CliError("refused", error instanceof Error ? error.message : String(error));
		}
		if (found) return found.header.protection;
		if (!VERSION_1_START.test(new TextDecoder().decode(await source.read(0, 256)))) throw new CliError("refused", "This is not a Ghostly backup");
		return "passphrase";
	} finally {
		await source.close();
	}
}
/** Where a path named by a backup lands inside the new profile's files folder; never outside it. */
function inside(root, path) {
	const target = typeof path === "string" && path ? resolve(root, path) : "";
	if (!target.startsWith(resolve(root) + sep)) throw new CliError("refused", "The backup names a file outside its folder");
	return target;
}
/** While a restore writes it, the profile's folder is not a profile: no profile name starts with a dot (`listProfiles`). */
var RESTORING = /^\.restoring-(.+)-(\d+)$/;
/**
* The folder a restore writes into, beside the profiles: it takes the profile's name only once everything is in it,
* so a restore that is stopped at any moment (Ctrl-C, a kill, the power) leaves no profile, whole or half-made.
* What an earlier restore that was stopped left behind is removed here, once the process that made it is gone.
*/
async function restoringFolder(home, name) {
	const root = join(home, "profiles");
	await mkdir(root, {
		recursive: true,
		mode: 448
	});
	for (const entry of await readdir(root)) {
		const pid = Number(RESTORING.exec(entry)?.[2]);
		if (!pid) continue;
		let alive = pid === process.pid;
		if (!alive) try {
			process.kill(pid, 0);
			alive = true;
		} catch (error) {
			alive = error.code === "EPERM";
		}
		if (!alive) await rm(join(root, entry), {
			recursive: true,
			force: true
		});
	}
	const dir = join(root, `.restoring-${name}-${process.pid}`);
	await rm(dir, {
		recursive: true,
		force: true
	});
	await mkdir(dir, { mode: 448 });
	return {
		...profilePaths(home, name),
		dir,
		db: join(dir, "db"),
		files: join(dir, "files")
	};
}
/**
* The folder is whole: marked as a restored copy (`RESTORED_MARK`, which names the files a light backup left out),
* then given the profile's name. Never over a profile.
*/
async function finishRestore(home, name, work, leftOut = []) {
	const paths = profilePaths(home, name);
	await writeFile(join(work.dir, RESTORED_MARK), leftOut.length ? JSON.stringify({ leftOut }) : "", { mode: 384 });
	if (existsSync(paths.dir)) throw new CliError("refused", `Profile ${name} exists: restore into a new name`);
	await rename(work.dir, paths.dir);
	return paths;
}
/**
* Opens the backup at `file` into a new profile (never over an existing one), with its passphrase when it has one.
* Runs with no engine: nothing is open yet. A backup that is refused, damaged or cut short leaves no profile behind,
* and neither does a restore that is stopped while it runs (`restoringFolder`). The profile is marked as a restored
* copy: its engine, the first time it starts, treats the money in it as a restore does (`RESTORED_MARK`).
*/
async function restoreProfile(home, name, file, passphrase) {
	if (profileExists(home, name)) throw new CliError("refused", `Profile ${name} exists: restore into a new name`);
	const source = await fileSource(file);
	let work = null;
	try {
		let reader;
		try {
			reader = await BackupReader.open(source, passphrase);
		} catch (error) {
			throw new CliError("refused", error instanceof Error ? error.message : String(error));
		}
		if (!reader) {
			const payload = await readWhole(file, passphrase ?? "");
			work = await restoringFolder(home, name);
			await writeWhole(work, payload);
			return await finishRestore(home, name, work);
		}
		const next = async () => {
			try {
				return await reader.next();
			} catch (error) {
				throw new CliError("refused", error instanceof Error ? error.message : String(error));
			}
		};
		const parse = (json) => {
			try {
				return JSON.parse(json);
			} catch {
				throw new CliError("refused", "This backup is damaged: it was changed or cut short");
			}
		};
		const first = await next();
		const head = first?.json === void 0 ? null : parse(first.json);
		if (head?.t !== "profile" || head.format !== FORMAT) throw new CliError("refused", "This backup is not a headless Ghostly profile");
		const leftOut = Array.isArray(head.light?.ids) ? head.light.ids.filter((id) => typeof id === "string") : [];
		work = await restoringFolder(home, name);
		const paths = work;
		await mkdir(paths.db, {
			recursive: true,
			mode: 448
		});
		let out = null, files = 0, bytes = 0, ended = false, stored = false;
		try {
			for (let record = await next(); record; record = await next()) {
				if (ended) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
				if (record.bytes) {
					if (!out || record.bytes.length > out.left) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
					await out.handle.write(record.bytes);
					out.left -= record.bytes.length;
					continue;
				}
				if (out) {
					if (out.left) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
					await out.handle.close();
					out = null;
				}
				const value = parse(record.json);
				if (value.t === "end") {
					ended = value.files === files && value.bytes === bytes;
					if (!ended) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
					continue;
				}
				if (value.t !== "file" || !Number.isSafeInteger(value.size) || value.size < 0) continue;
				let target;
				if (value.kind === "store") {
					target = join(paths.db, "snapshot.bin");
					stored = true;
				} else {
					target = inside(paths.files, value.path);
					await mkdir(dirname(target), {
						recursive: true,
						mode: 448
					});
					files += 1;
					bytes += value.size;
				}
				out = {
					handle: await open(target, "wx", 384),
					left: value.size
				};
			}
			if (out || !ended || !stored) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
		} finally {
			await out?.handle.close().catch(() => {});
		}
		return await finishRestore(home, name, work, leftOut);
	} catch (error) {
		if (work) await rm(work.dir, {
			recursive: true,
			force: true
		});
		throw error;
	} finally {
		await source.close();
	}
}
/** A version 1 backup: one sealed JSON document, read whole. */
async function readWhole(file, passphrase) {
	let payload;
	try {
		payload = JSON.parse(await open$1(await readFile(file, "utf8"), passphrase));
	} catch (error) {
		throw new CliError("refused", error instanceof Error ? error.message : String(error));
	}
	if (payload?.format !== FORMAT_1 || typeof payload.store !== "string" || !Array.isArray(payload.files)) throw new CliError("refused", "This backup is not a headless Ghostly profile");
	return payload;
}
async function writeWhole(paths, payload) {
	await mkdir(paths.db, {
		recursive: true,
		mode: 448
	});
	await writeFile(join(paths.db, "snapshot.bin"), Buffer.from(payload.store, "base64"), { mode: 384 });
	for (const entry of payload.files) {
		const target = inside(paths.files, entry.path);
		await mkdir(dirname(target), {
			recursive: true,
			mode: 448
		});
		await writeFile(target, Buffer.from(entry.data, "base64"), { mode: 384 });
	}
}
//#endregion
export { backupFileProtection as n, restoreProfile as r, BACKUP_METHODS as t };

//# sourceMappingURL=backup-B2HfdNO7.js.map