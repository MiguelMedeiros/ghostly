import { $n as engineError, er as engineText } from "./src-dfGE33hw.js";
import { d as openDb, h as wrap, i as STORES, m as transact, p as store } from "./idb-BuyRKmBx.js";
//#region ../browser/src/engine/paymentAdapters/persistence.ts
/**
* A USDT payment is one transaction at one account nonce. Another payment from the same account and chain that is
* submitted or of unknown outcome holds its nonce until it confirms. A review made after it was sent took the next
* nonce and may go at once. One made before (or read from an RPC that had not seen it yet) has the same or a lower
* nonce: sent, it would replace the earlier transaction or be dropped, so it is refused. A row with no nonce refuses.
*/
function nonceTaken(review, intents) {
	if (review.method !== "usdt") return false;
	const from = review.evm?.from?.toLowerCase(), nonce = review.evm?.nonce;
	return intents.some(({ review: other }) => other.id !== review.id && other.method === "usdt" && other.chainId === review.chainId && other.evm?.from?.toLowerCase() === from && ["submitted", "unknown"].includes(other.state) && !(typeof nonce === "number" && typeof other.evm?.nonce === "number" && nonce > other.evm.nonce));
}
var intentRepository = {
	async get(id) {
		return wrap((await store(STORES.intents, "readonly")).get(id));
	},
	async list() {
		return wrap((await store(STORES.intents, "readonly")).getAll());
	},
	async put(intent) {
		await transact([STORES.intents], (s) => {
			s[STORES.intents].put(intent);
		});
	},
	async claim(id) {
		const tx = (await openDb()).transaction(STORES.intents, "readwrite");
		return new Promise((resolve, reject) => {
			let saved;
			let reason = engineText("alreadySubmitted");
			const request = tx.objectStore(STORES.intents).getAll();
			request.onsuccess = () => {
				const intents = request.result;
				saved = intents.find((item) => item.review.id === id);
				if (!saved || saved.review.state !== "pending") {
					tx.abort();
					return;
				}
				if (saved.review.requestId && intents.some(({ review }) => review.id !== id && review.requestId === saved.review.requestId && review.linkId === saved.review.linkId && [
					"submitted",
					"settled",
					"unknown"
				].includes(review.state))) {
					tx.abort();
					return;
				}
				if (nonceTaken(saved.review, intents)) {
					reason = engineText("sentAfterReview");
					tx.abort();
					return;
				}
				saved.review = {
					...saved.review,
					state: "submitted",
					error: void 0,
					submittedAt: Date.now()
				};
				tx.objectStore(STORES.intents).put(saved);
			};
			tx.oncomplete = () => resolve(saved);
			tx.onabort = tx.onerror = () => reject(new Error(reason));
		});
	},
	async cancel(id) {
		const tx = (await openDb()).transaction(STORES.intents, "readwrite");
		return new Promise((resolve, reject) => {
			let saved;
			const request = tx.objectStore(STORES.intents).get(id);
			request.onsuccess = () => {
				saved = request.result;
				if (!saved || saved.review.state !== "pending") {
					tx.abort();
					return;
				}
				saved.review = {
					...saved.review,
					state: "cancelled"
				};
				tx.objectStore(STORES.intents).put(saved);
			};
			tx.oncomplete = () => resolve(saved);
			tx.onabort = tx.onerror = () => reject(engineError("cannotCancelSubmitted"));
		});
	}
};
/** Key for a wallet that needs no password: its seed is protected like the Cashu proofs in the same database. */
function newDeviceKey() {
	return btoa(String.fromCharCode(...crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(32)))).replace(/=+$/, "");
}
async function passwordKey(password, salt) {
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey({
		name: "PBKDF2",
		hash: "SHA-256",
		salt,
		iterations: 6e5
	}, material, {
		name: "AES-GCM",
		length: 256
	}, false, ["encrypt", "decrypt"]);
}
async function sealSeed(seed, password) {
	if (password.length < 12) throw new Error("Use at least 12 characters for the wallet password");
	const salt = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16)), iv = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt({
		name: "AES-GCM",
		iv
	}, await passwordKey(password, salt), new TextEncoder().encode(seed));
	return {
		version: 1,
		salt: [...salt],
		iv: [...iv],
		ciphertext: [...new Uint8Array(ciphertext)]
	};
}
async function unsealSeed(seed, password) {
	if (seed.version !== 1) throw new Error("Unsupported wallet backup version");
	try {
		return new TextDecoder().decode(await crypto.subtle.decrypt({
			name: "AES-GCM",
			iv: new Uint8Array(seed.iv)
		}, await passwordKey(password, new Uint8Array(seed.salt)), new Uint8Array(seed.ciphertext)));
	} catch {
		throw new Error("Could not unlock the wallet. Check the password and backup.");
	}
}
//#endregion
//#region ../browser/src/engine/paymentAdapters/networkReason.ts
/**
* A request's failure as a person says it, when the browser's own words say nothing: a request that timed out or was
* given up ("Fetch is aborted" in Safari, "signal timed out" in Chromium) did not answer in time; one that never left
* ("Failed to fetch", "Load failed") could not reach it. `host` names what was asked, when known. Anything else is
* `null`: its own words are kept.
*/
function networkReason(error, host) {
	const name = error instanceof Error ? error.name : "";
	const text = error instanceof Error ? error.message : String(error);
	if (name === "AbortError" || name === "TimeoutError" || /^(fetch is aborted|signal timed out|signal is aborted without reason|the (user|operation) (aborted a request|was aborted)\.?|this operation was aborted|the operation timed out\.?)$/i.test(text.trim())) return host ? engineText("hostTimedOut", { host }) : engineText("networkTimedOut");
	if (/^(failed to fetch|load failed|fetch failed|networkerror when attempting to fetch resource\.?|network request failed)$/i.test(text.trim())) return host ? engineText("hostUnreachable", { host }) : engineText("networkUnreachable");
	return null;
}
/** A request URL's host, for a reason that names it; the URL itself when it does not parse. */
function rpcHost(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
//#endregion
export { sealSeed as a, newDeviceKey as i, rpcHost as n, unsealSeed as o, intentRepository as r, networkReason as t };

//# sourceMappingURL=networkReason-CY6aipPw.js.map