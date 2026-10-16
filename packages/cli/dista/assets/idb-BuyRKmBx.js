//#region ../browser/src/shared/idb.ts
/**
* The extension's one IndexedDB database. The peer (offscreen document) and
* the pages share an origin, so both open it: that is also how file contents
* move between them without squeezing through runtime messages.
*/
var dbName = "ghostly";
/** The peer database this page uses: its profile's (WISP 04). */
function databaseName() {
	return dbName;
}
/** The profile's database did not open. Nothing was changed, and nothing is ever deleted or reset because of it. */
var ProfileOpenError = class extends Error {
	failure;
	constructor(failure) {
		super(profileOpenMessage(failure));
		this.failure = failure;
		this.name = "ProfileOpenError";
	}
};
/** The failure in plain English, for logs, the CLI and anything that shows an engine error as it came. */
function profileOpenMessage(failure) {
	const could = "Ghostly could not open this profile's data";
	switch (failure.reason) {
		case "newer": return `This profile was last used by a newer version of Ghostly (its data is version ${failure.storedVersion ?? "above " + failure.supportedVersion}, this version reads up to ${failure.supportedVersion}). Update Ghostly to open it.`;
		case "blocked": return `${could}: another Ghostly window or tab still has it open with an older version. Close it and try again.`;
		case "full": return `${could}: this device is out of storage space. Free some space and try again.`;
		case "denied": return `${could}: storage is not allowed here (a private window, or storage blocked for this site).`;
		default: return `${could}${failure.detail ? `: ${failure.detail}` : ""}`;
	}
}
/** What the start of the engine failed with, as the failure the pages show: a database that did not open, or anything else. */
function profileOpenFailure(error) {
	if (error instanceof ProfileOpenError) return error.failure;
	const detail = error instanceof Error ? error.message : String(error);
	return {
		reason: "failed",
		supportedVersion: 15,
		...detail ? { detail } : {}
	};
}
/**
* A failed call as the client hears it (engine/server.ts): the error's message. Only the message travels, so a storage
* write the browser refused for want of space (Chromium's QuotaExceededError has an empty message) says so, its name
* kept for the ⓘ.
*/
function errorLine(error) {
	if (error?.name === "QuotaExceededError") {
		const message = error instanceof Error ? error.message.trim() : "";
		return `Not enough space on this device (QuotaExceededError${message ? `: ${message}` : ""})`;
	}
	return error instanceof Error ? error.message : String(error);
}
/** How long an open that another window blocks may wait for that window to let go before it is said to be blocked. */
var OPEN_TIMINGS = { blockedMs: 1e4 };
function failureOf(error) {
	const name = error?.name;
	const message = error?.message;
	const detail = [typeof name === "string" ? name : "", typeof message === "string" ? message : ""].filter(Boolean).join(": ");
	return {
		reason: name === "VersionError" ? "newer" : name === "QuotaExceededError" ? "full" : name === "BlockedError" ? "blocked" : name === "SecurityError" || name === "InvalidStateError" || name === "ReferenceError" || name === "TypeError" ? "denied" : "failed",
		supportedVersion: 15,
		...detail ? { detail } : {}
	};
}
/**
* The version a database is stored at, read without changing it: an open that names no version opens what is there.
* Only for a database known to exist (an open without a version would make a missing one).
*/
function storedVersion(name) {
	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(name);
			request.onupgradeneeded = () => {
				try {
					request.transaction?.abort();
				} catch {}
			};
			request.onsuccess = () => {
				const { version } = request.result;
				request.result.close();
				resolve(version);
			};
			request.onerror = request.onblocked = () => resolve(void 0);
		} catch {
			resolve(void 0);
		}
	});
}
/** The messages store's index of card messages (`card.kind`): what `db.getCardMessages` reads. */
var CARD_INDEX = "byCardKind";
/** The wallet history's index by (mint, time): what `newestWalletTx` reads. */
var WALLET_TX_INDEX = "byMintTime";
var STORES = {
	links: "links",
	messages: "messages",
	services: "services",
	settings: "settings",
	files: "files",
	proofs: "proofs",
	payments: "payments",
	quotes: "quotes",
	walletTx: "walletTx",
	melts: "melts",
	/** Swaps at a mint that have not finished (`PendingSwap`): what gets their outputs back when an answer is missed. */
	swaps: "swaps",
	intents: "paymentIntents",
	/** Private groups (WISP 900): membership chain, epoch secrets and my own recent messages, by group id. */
	groups: "groups",
	/** Files kept in 1 MiB pieces where the platform has no file system for them (see `fileBytesIdb.ts`). */
	fileChunks: "fileChunks",
	/**
	* What changes about a stored file after it is stored, by file id. A `files` record is written once and never
	* again: WebKit loses the Blob of a record written back with the Blob it read (see `fileStore`).
	*/
	fileState: "fileState",
	/** Installed mini-apps (WISP 1200 § Updates and rollback), by app reference: `InstalledApp` (`engine/apps.ts`). */
	apps: "apps",
	/** The app stores the person added, by store key: `AddedAppStore`. A store is its key; its URL is kept on the record. */
	appStores: "appStores",
	/** Each installed app's own storage, by (app reference, scope, key): `AppStorageRow`. Scope: a chat's link id, or `alone`. */
	appStorage: "appStorage"
};
/** The app storage store's index by (app reference, scope): one scope's rows, for its 5 MiB cap and its keys. */
var APP_STORAGE_SCOPE_INDEX = "byAppScope";
/** The app storage store's index by scope: every app's rows of one chat, which go with the chat. */
var APP_STORAGE_CHAT_INDEX = "byScope";
var dbPromise = null;
function openDb() {
	dbPromise ??= new Promise((resolve, reject) => {
		let settled = false;
		let blocked;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(blocked);
			const failure = failureOf(error);
			if (failure.reason !== "newer") {
				reject(new ProfileOpenError(failure));
				return;
			}
			storedVersion(dbName).then((version) => reject(new ProfileOpenError({
				...failure,
				...version !== void 0 ? { storedVersion: version } : {}
			})));
		};
		let request;
		try {
			request = indexedDB.open(dbName, 15);
		} catch (error) {
			fail(error);
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			const has = (name) => db.objectStoreNames.contains(name);
			if (!has(STORES.links)) db.createObjectStore(STORES.links, { keyPath: "id" });
			if (!has(STORES.services)) db.createObjectStore(STORES.services, { keyPath: "id" });
			if (!has(STORES.settings)) db.createObjectStore(STORES.settings);
			if (!has(STORES.messages)) db.createObjectStore(STORES.messages, { keyPath: ["linkId", "id"] }).createIndex("byLink", "linkId");
			if (!has(STORES.proofs)) db.createObjectStore(STORES.proofs, { keyPath: "secret" });
			if (!has(STORES.payments)) db.createObjectStore(STORES.payments, { keyPath: "id" });
			if (!has(STORES.quotes)) db.createObjectStore(STORES.quotes, { keyPath: "quote" });
			if (!has(STORES.walletTx)) db.createObjectStore(STORES.walletTx, { keyPath: "id" });
			if (!has(STORES.melts)) db.createObjectStore(STORES.melts, { keyPath: "quote" });
			if (!has(STORES.intents)) db.createObjectStore(STORES.intents, { keyPath: "review.id" });
			if (!has(STORES.files)) db.createObjectStore(STORES.files, { keyPath: "id" }).createIndex("byLink", "linkId");
			if (!has(STORES.groups)) db.createObjectStore(STORES.groups, { keyPath: "id" });
			if (!has(STORES.fileChunks)) db.createObjectStore(STORES.fileChunks, { keyPath: ["id", "index"] });
			if (!has(STORES.fileState)) db.createObjectStore(STORES.fileState, { keyPath: "id" });
			const messages = request.transaction.objectStore(STORES.messages);
			if (!messages.indexNames.contains("byLinkTime")) messages.createIndex("byLinkTime", ["linkId", "timestamp"]);
			if (!messages.indexNames.contains("byCardKind")) messages.createIndex(CARD_INDEX, "card.kind");
			if (!has(STORES.swaps)) db.createObjectStore(STORES.swaps, { keyPath: "id" });
			if (!has(STORES.apps)) db.createObjectStore(STORES.apps, { keyPath: "ref" });
			if (!has(STORES.appStores)) db.createObjectStore(STORES.appStores, { keyPath: "key" });
			if (!has(STORES.appStorage)) {
				const storage = db.createObjectStore(STORES.appStorage, { keyPath: [
					"ref",
					"scope",
					"key"
				] });
				storage.createIndex(APP_STORAGE_SCOPE_INDEX, ["ref", "scope"]);
				storage.createIndex(APP_STORAGE_CHAT_INDEX, "scope");
			}
			const walletTx = request.transaction.objectStore(STORES.walletTx);
			if (!walletTx.indexNames.contains("byMintTime")) walletTx.createIndex(WALLET_TX_INDEX, ["mint", "timestamp"]);
		};
		request.onsuccess = () => {
			if (settled) {
				request.result.close();
				return;
			}
			settled = true;
			clearTimeout(blocked);
			request.result.onversionchange = () => {
				request.result.close();
				dbPromise = null;
			};
			resolve(request.result);
		};
		request.onerror = (event) => {
			event.preventDefault?.();
			fail(request.error);
		};
		request.onblocked = () => {
			blocked ??= setTimeout(() => fail({
				name: "BlockedError",
				message: "another connection holds an older version open"
			}), OPEN_TIMINGS.blockedMs);
		};
	});
	return dbPromise;
}
/** The stores "Clear all data" empties: chats and their keys, messages, files, shared services, groups, mini-apps and their data. */
var PROFILE_STORES = [
	STORES.links,
	STORES.messages,
	STORES.files,
	STORES.fileState,
	STORES.fileChunks,
	STORES.services,
	STORES.groups,
	STORES.apps,
	STORES.appStores,
	STORES.appStorage
];
/**
* Records of the settings store that belong to the profile, not to a wallet: its DID and its key, its identity proofs
* with their keys and revocations, its own Nostr data, the public profiles it read, the built-in mini-apps it removed
* (`BUILT_IN_APPS_KEY` of `engine/apps.ts`), its x401 credentials and their keys (`engine/x401.ts`). A list of what goes
* rather than of what stays, on purpose: every other record of that store is a wallet's (seeds, configuration, pending
* operations), and a wallet record a newer version adds must never be deleted by mistake.
*/
var PROFILE_SETTINGS_KEYS = [
	"profileDid",
	"identityProofs",
	"identityRevocations",
	"nostrSocial",
	"publicProfiles",
	"appBuiltIns",
	"x401Credentials"
];
/**
* The fields of the peer's `settings` record that are a wallet's, kept by "Clear all data": the mint list, the first-run
* wallet setup and the backup reminders. Everything else in it is the profile's (name, picture, network settings,
* storage credentials for held items, the push subscription and who holds it) and goes.
*/
var WALLET_SETTINGS_FIELDS = [
	"mints",
	"mintsInitialized",
	"walletSetup",
	"backupReminders"
];
/**
* "Clear all data" (WISP 04): everything of the profile in its peer database except its wallets. The chats' stores are
* emptied, the profile's records of the settings store are deleted and the `settings` record keeps only its wallet
* fields. The wallets (proofs, payments, quotes, history, payment journal, wallet records) stay: ecash is money, and
* nothing else holds a copy of it. The caller stops the peer first, or it may write back what was just deleted.
*/
async function clearProfileStores() {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	const names = [...PROFILE_STORES, STORES.settings].filter((name) => db.objectStoreNames.contains(name));
	const tx = db.transaction(names, "readwrite");
	for (const name of names) if (name !== STORES.settings) tx.objectStore(name).clear();
	if (names.includes(STORES.settings)) {
		const settings = tx.objectStore(STORES.settings);
		for (const key of PROFILE_SETTINGS_KEYS) settings.delete(key);
		const read = settings.get("settings");
		read.onsuccess = () => {
			const record = read.result;
			if (!record || typeof record !== "object") return;
			const kept = Object.fromEntries(WALLET_SETTINGS_FIELDS.filter((field) => field in record).map((field) => [field, record[field]]));
			settings.put(kept, "settings");
		};
	}
	await new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = tx.onabort = () => reject(tx.error);
	});
}
/** Deletes a database of the origin by name (an SDK's own), as far as the browser lets it: blocked or failed, it gives up quietly. */
function deleteDatabase(name) {
	return new Promise((resolve) => {
		try {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		} catch {
			resolve();
		}
	});
}
function wrap(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
async function store(name, mode) {
	return (await openDb()).transaction(name, mode).objectStore(name);
}
/**
* Several writes across stores in one transaction: they all land, or none does.
* `work` only queues requests; the promise settles when the transaction does.
*/
async function transact(names, work) {
	const tx = (await openDb()).transaction(names, "readwrite");
	const done = new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? /* @__PURE__ */ new Error("The wallet could not save"));
		tx.onerror = () => reject(tx.error ?? /* @__PURE__ */ new Error("The wallet could not save"));
	});
	try {
		work(Object.fromEntries(names.map((name) => [name, tx.objectStore(name)])));
	} catch (error) {
		tx.abort();
		await done.catch(() => {});
		throw error;
	}
	return done;
}
/**
* The `count` newest wallet movements of the mints `wanted` picks, newest first. Read backwards on the history index, a
* mint at a time: a mint not wanted, or one whose `count` newest are read, is stepped over at once. What it reads grows
* with the number of mints, never with the history's length.
*/
async function newestWalletTx(wanted, count) {
	const index = (await store(STORES.walletTx, "readonly")).index(WALLET_TX_INDEX);
	const rows = [];
	await new Promise((resolve, reject) => {
		let mint, taken = 0;
		const read = (below) => {
			const request = index.openCursor(below, "prev");
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) {
					resolve();
					return;
				}
				const [at] = cursor.key;
				if (at !== mint) {
					mint = at;
					taken = 0;
				}
				if (taken >= count || !wanted(at)) {
					read(IDBKeyRange.upperBound([at, -Infinity], true));
					return;
				}
				rows.push(cursor.value);
				taken++;
				cursor.continue();
			};
		};
		read(null);
	});
	return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, count);
}
/** A stored file as it stands: its record, with what changed since it was stored read over it. */
function withState(file, state) {
	if (!state) return file;
	const { id: _id, ...fields } = state;
	return {
		...file,
		...fields
	};
}
/**
* The files store. A record is written once, by `put`, and never written back: what changes later (`patch`,
* `updateTransfer`) goes to `STORES.fileState` and is read over it. WebKit (Safari, the macOS app) keeps a stored
* Blob as a file the record points to, and a record written back with the Blob it read can lose that file: from
* then on every read of it fails with "The object can not be found here." For the same reason a Blob read from
* here is never put here again, under any id (a forward copies the bytes into a Blob of its own).
*/
var fileStore = {
	/** Stores a file anew: whatever changed about an earlier file under this id is forgotten. */
	async put(file) {
		await transact([STORES.files, STORES.fileState], (stores) => {
			stores[STORES.files].put(file);
			stores[STORES.fileState].delete(file.id);
		});
	},
	async updateTransfer(id, transfer) {
		await fileStore.patch(id, { transfer });
	},
	/** Changes some fields of a stored file (never its record, see above); nothing happens to one that was deleted. */
	async patch(id, fields) {
		await transact([STORES.files, STORES.fileState], (stores) => {
			const exists = stores[STORES.files].getKey(id);
			exists.onsuccess = () => {
				if (exists.result === void 0) return;
				const state = stores[STORES.fileState].get(id);
				state.onsuccess = () => {
					stores[STORES.fileState].put({
						...state.result,
						...fields,
						id
					});
				};
			};
		});
	},
	async get(id) {
		const tx = (await openDb()).transaction([STORES.files, STORES.fileState], "readonly");
		const [file, state] = await Promise.all([wrap(tx.objectStore(STORES.files).get(id)), wrap(tx.objectStore(STORES.fileState).get(id))]);
		return file && withState(file, state);
	},
	async listForLink(linkId) {
		const tx = (await openDb()).transaction([STORES.files, STORES.fileState], "readonly");
		const files = await wrap(tx.objectStore(STORES.files).index("byLink").getAll(linkId));
		const states = await Promise.all(files.map((file) => wrap(tx.objectStore(STORES.fileState).get(file.id))));
		return files.map((file, i) => withState(file, states[i]));
	},
	/** The id of every group a stored file is of (`linkId` `group:<id>`), read off the index: no record is loaded. */
	async groupIds() {
		const index = (await store(STORES.files, "readonly")).index("byLink"), ids = [];
		await new Promise((resolve, reject) => {
			const request = index.openKeyCursor(IDBKeyRange.bound("group:", "group:￿"), "nextunique");
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return resolve();
				ids.push(String(cursor.key).slice(6));
				cursor.continue();
			};
		});
		return ids;
	},
	/** The id of every stored file whose bytes are a Blob in its record. */
	async blobIds() {
		const files = await store(STORES.files, "readonly"), ids = [];
		await new Promise((resolve, reject) => {
			const request = files.openCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return resolve();
				if (cursor.value.blob) ids.push(String(cursor.key));
				cursor.continue();
			};
		});
		return ids;
	},
	/**
	* A file whose Blob was copied to file storage (`kind`, under its id): its record without the Blob from now on. Written
	* back without the Blob it read, so not what WebKit loses (see above); what changed about it since (`fileState`) stays.
	* False when the record is gone or holds no Blob any more: the copy is the caller's to remove.
	*/
	async movedToBytes(id, kind) {
		let moved = false;
		await transact([STORES.files], (stores) => {
			const read = stores[STORES.files].get(id);
			read.onsuccess = () => {
				const record = read.result;
				if (!record?.blob) return;
				const { blob: _blob, ...rest } = record;
				stores[STORES.files].put({
					...rest,
					bytes: kind
				});
				moved = true;
			};
		});
		return moved;
	},
	async delete(id) {
		await transact([STORES.files, STORES.fileState], (stores) => {
			stores[STORES.files].delete(id);
			stores[STORES.fileState].delete(id);
		});
	},
	async deleteForLink(linkId) {
		const tx = (await openDb()).transaction([STORES.files, STORES.fileState], "readwrite");
		const files = tx.objectStore(STORES.files), state = tx.objectStore(STORES.fileState);
		const keys = await wrap(files.index("byLink").getAllKeys(linkId));
		await Promise.all(keys.flatMap((key) => [wrap(files.delete(key)), wrap(state.delete(key))]));
	}
};
//#endregion
export { clearProfileStores as a, errorLine as c, openDb as d, profileOpenFailure as f, wrap as h, STORES as i, fileStore as l, transact as m, APP_STORAGE_SCOPE_INDEX as n, databaseName as o, store as p, CARD_INDEX as r, deleteDatabase as s, APP_STORAGE_CHAT_INDEX as t, newestWalletTx as u };

//# sourceMappingURL=idb-BuyRKmBx.js.map