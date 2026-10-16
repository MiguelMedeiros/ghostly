import "./src-dfGE33hw.js";
//#region ../browser/src/backup/codec.ts
function fromBase64Url(text) {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Invalid base64url");
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
//#endregion
//#region ../browser/src/backup/envelope.ts
var BACKUP_MEDIA_TYPE = "application/vnd.ghostly.backup+json";
var ITERATIONS = 6e5;
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
/** A profile with years of files is large, but not this large: past it, a bundle is refused, not read. */
var MAX_BACKUP_BYTES = 1073741824;
async function through(bytes, stream) {
	const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
	const chunks = [];
	let size = 0;
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.length;
		if (size > 1073741824) {
			await reader.cancel();
			throw new Error("This backup is too large to restore");
		}
		chunks.push(next.value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}
/**
* The clear header is authenticated with the ciphertext (AES-GCM associated data): changing any of it,
* the compression included, makes the bundle fail to open instead of being read differently.
*/
var header = (e) => new TextEncoder().encode([
	e.format,
	e.version,
	e.kdf.name,
	e.kdf.iterations,
	e.kdf.salt,
	e.cipher.name,
	e.cipher.iv,
	e.compression
].join("\n"));
/** Checks, decrypts and decompresses a bundle. Nothing from a bundle is used before this succeeds. */
async function open(text, passphrase) {
	if (text.length > 1503238553.6) throw new Error("This backup is too large to restore");
	let envelope;
	try {
		envelope = JSON.parse(text);
	} catch {
		throw new Error("This is not a Ghostly backup");
	}
	if (envelope?.format !== "ghostly-backup") throw new Error("This is not a Ghostly backup");
	if (envelope.version !== 1) throw new Error("This backup comes from a newer Ghostly; update to restore it");
	if (envelope.kdf?.name !== "PBKDF2-SHA256" || !(envelope.kdf.iterations >= ITERATIONS) || envelope.kdf.iterations > 1e7 || envelope.cipher?.name !== "AES-256-GCM" || !["gzip", "none"].includes(envelope.compression)) throw new Error("Unsupported backup encryption");
	let body;
	try {
		body = new Uint8Array(await crypto.subtle.decrypt({
			name: "AES-GCM",
			iv: fromBase64Url(envelope.cipher.iv),
			additionalData: header(envelope)
		}, await keyFrom(passphrase, fromBase64Url(envelope.kdf.salt), envelope.kdf.iterations), fromBase64Url(envelope.ciphertext)));
	} catch {
		throw new Error("Wrong passphrase, or the backup was changed");
	}
	const plain = envelope.compression === "gzip" ? await through(body, new DecompressionStream("gzip")) : body;
	return new TextDecoder().decode(plain);
}
//#endregion
export { fromBase64Url as i, MAX_BACKUP_BYTES as n, open as r, BACKUP_MEDIA_TYPE as t };

//# sourceMappingURL=envelope-CEZ9D5OW.js.map